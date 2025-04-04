const WebSocket = require('ws');
const root = require('./generated/containerPb.js');
const Container = root.DBMessaging.Protobuf.Container;
const CDPValueType = root.ICD.Protobuf.CDPValueType;

class Client {
  /**
   * @param {string} endpoint - The logger endpoint (e.g. "127.0.0.1:17000" or "ws://127.0.0.1:17000")
   * @param {boolean} [autoReconnect=true] - Automatically reconnect if the connection is lost
   */
  constructor(endpoint, autoReconnect = true) {
    // If endpoint does not start with "ws://" or "wss://", prepend "ws://"
    let url = endpoint;
    if (!/^wss?:\/\//.test(url)) {
      url = `ws://${url}`;
    }

    this.reqId = -1;
    this.autoReconnect = autoReconnect;

    // Time synchronization is enabled by default.
    this.enableTimeSync = true;

    this.isOpen = false;
    this.queuedRequests = {};
    this.storedPromises = {};
    this.nameToId = {};
    this.idToName = {};

    // New mapping for signal types.
    this.nameToType = {};

    // Time-diff related
    this.timeDiff = 0;
    this.timeReceived = null;
    this.lastTimeRequest = Date.now() / 1000;
    this.haveSentQueuedReq = false;
    this.roundTripTimes = {};

    // Create the WebSocket connection
    this.ws = this._connect(url);
  }

  /**
   * Enable or disable time synchronization.
   * @param {boolean} enable - If true, time sync is enabled; if false, time sync is disabled.
   */
  setEnableTimeSync(enable) {
    this.enableTimeSync = enable;
    if (!enable) {
      // Cancel any pending time sync requests so they won’t update timeDiff later.
      for (const key in this.storedPromises) {
        this.storedPromises[key].reject(new Error("Time sync disabled"));
      }
      this.storedPromises = {};
    }
  }

  _connect(url) {
    const ws = new WebSocket(url);
    ws._url = url;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => this._onOpen(ws);
    ws.onmessage = (event) => this._handleMessage(ws, event.data);
    ws.onerror = (error) => this._onError(ws, error);
    ws.onclose = () => this._onClose(ws);
    return ws;
  }

  _onOpen(ws) {
    this.isOpen = true;
    if (this.enableTimeSync) {
      this._updateTimeDiff();
    }
    this.lastTimeRequest = Date.now() / 1000;
  }

  _onError(ws, error) {
    if (!error) {
      error = new Error("Something went wrong");
    }
    if (!this.autoReconnect) {
      for (const key in this.storedPromises) {
        this.storedPromises[key].reject(error);
      }
      this.storedPromises = {};
      this.queuedRequests = {};
    }
  }

  _onClose(ws) {
    this.isOpen = false;
    if (!this.autoReconnect) {
      this._onError(ws, new Error("Connection was closed"));
    } else {
      // Try to reconnect after a delay
      setTimeout(() => {
        this.ws = this._connect(ws._url);
      }, 1000);
    }
  }

  disconnect() {
    this.autoReconnect = false;
    this._cleanupQueuedRequests();
    this.isOpen = false;
    if (this.ws) {
      this.ws.close();
    }
  }

  _cleanupQueuedRequests() {
    for (const key in this.storedPromises) {
      this.storedPromises[key].reject(new Error("Connection was closed"));
    }
    this.storedPromises = {};
    this.queuedRequests = {};
  }

  // --- Public API methods ---

  requestApiVersion() {
    this._timeRequest();
    const requestId = this._getRequestId();
    if (!this.isOpen) {
      this.queuedRequests[requestId] = "api_version";
    } else {
      this._sendApiVersionRequest(requestId);
    }
    return new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
  }

  requestLoggedNodes() {
    this._timeRequest();
    const requestId = this._getRequestId();
    if (!this.isOpen) {
      this.queuedRequests[requestId] = "logged_nodes";
    } else {
      this._sendLoggedNodesRequest(requestId);
    }
    return new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
  }

  requestLogLimits() {
    this._timeRequest();
    const requestId = this._getRequestId();
    if (!this.isOpen) {
      this.queuedRequests[requestId] = "log_limits";
    } else {
      this._sendLogLimitsRequest(requestId);
    }
    return new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
  }

  requestDataPoints(nodeNames, startS, endS, noOfDataPoints) {
    this._timeRequest();
    const requestId = this._getRequestId();
    const promise = new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
    if (!this.isOpen) {
      this.queuedRequests[requestId] = ["node_values", nodeNames, startS, endS, noOfDataPoints];
    } else {
      this._reqDataPoints(nodeNames, startS, endS, noOfDataPoints, requestId);
    }
    return promise;
  }

  /**
   * Request events based on the provided query parameters.
   * @param {Object} query - An object matching the EventQuery schema.
   * For example:
   * {
   *   timeRangeBegin: 1620000000,
   *   timeRangeEnd: 1620003600,
   *   codeMask: 0,
   *   limit: 100,
   *   offset: 0,
   *   flags: 1  // Numeric flags as defined in your protocol
   * }
   * @returns {Promise<Array>} Resolves with an array of events.
   */
  requestEvents(query) {
    this._timeRequest();
    const requestId = this._getRequestId();
    if (!this.isOpen) {
      this.queuedRequests[requestId] = { type: "events", query: query };
    } else {
      this._sendEventsRequest(requestId, query);
    }
    return new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
  }

  _sendEventsRequest(requestId, query) {
    const container = Container.create();
    container.messageType = Container.Type.eEventsRequest;
    container.eventsRequest = { requestId: requestId, query: query };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }

  _handleMessage(ws, message) {
    const data = Container.decode(new Uint8Array(message));
    this._parseMessage(data);
  }

  _parseMessage(data) {
    switch (data.messageType) {
      case Container.Type.eError:
        if (this.storedPromises[data.error.requestId]) {
          const { reject } = this.storedPromises[data.error.requestId];
          delete this.storedPromises[data.error.requestId];
          reject(new Error(data.error.errorMessage));
        }
        break;

      case Container.Type.eTimeResponse:
        this.timeReceived = Date.now() / 1000;
        if (this.storedPromises[data.timeResponse.requestId]) {
          const { resolve } = this.storedPromises[data.timeResponse.requestId];
          delete this.storedPromises[data.timeResponse.requestId];
          resolve(data.timeResponse.timestamp);
        }
        break;

      case Container.Type.eSignalInfoResponse: {
        const nodes = [];
        this.nameToId = {};
        this.idToName = {};
        for (let i = 0; i < data.signalInfoResponse.name.length; i++) {
          const node = {
            name: data.signalInfoResponse.name[i],
            routing: data.signalInfoResponse.path[i]
          };
          if (data.signalInfoResponse.tagMap && data.signalInfoResponse.tagMap[i]) {
            node.tags = this._convertTagMap(data.signalInfoResponse.tagMap[i]);
          }
          this.nameToId[data.signalInfoResponse.name[i]] = data.signalInfoResponse.id[i];
          this.idToName[data.signalInfoResponse.id[i]] = data.signalInfoResponse.name[i];
          nodes.push(node);
        }
        if (this.storedPromises[data.signalInfoResponse.requestId]) {
          const { resolve } = this.storedPromises[data.signalInfoResponse.requestId];
          delete this.storedPromises[data.signalInfoResponse.requestId];
          resolve(nodes);
        }
        break;
      }

      case Container.Type.eCriterionLimitsResponse:
        if (this.enableTimeSync) {
          data.criterionLimitsResponse.criterionMin += this.timeDiff;
          data.criterionLimitsResponse.criterionMax += this.timeDiff;
        }
        {
          const limits = {
            startS: data.criterionLimitsResponse.criterionMin,
            endS: data.criterionLimitsResponse.criterionMax
          };
          if (this.storedPromises[data.criterionLimitsResponse.requestId]) {
            const { resolve } = this.storedPromises[data.criterionLimitsResponse.requestId];
            delete this.storedPromises[data.criterionLimitsResponse.requestId];
            resolve(limits);
          }
        }
        break;

      case Container.Type.eVersionResponse: {
        const version = parseFloat(data.versionResponse.version);
        if (version < 3.0) {
          if (this.storedPromises[data.versionResponse.requestId]) {
            const { reject } = this.storedPromises[data.versionResponse.requestId];
            delete this.storedPromises[data.versionResponse.requestId];
            reject(new Error("CDP version needs to be 4.3 or newer."));
          }
        } else {
          if (this.storedPromises[data.versionResponse.requestId]) {
            const { resolve } = this.storedPromises[data.versionResponse.requestId];
            delete this.storedPromises[data.versionResponse.requestId];
            resolve(data.versionResponse.version);
          }
        }
        break;
      }

      case Container.Type.eSignalDataResponse: {
        let dataPoints = [];
        let index = 0;
        for (const row of data.signalDataResponse.row) {
          if (this.enableTimeSync) {
            data.signalDataResponse.criterion[index] += this.timeDiff;
          }
          let signalNames = [];
          for (const signalId of row.signalId) {
            signalNames.push(this.idToName[signalId]);
          }
          const value = this._createValue(
            signalNames,
            row.minValues,
            row.maxValues,
            row.lastValues
          );
          dataPoints.push({
            timestamp: data.signalDataResponse.criterion[index],
            value: value
          });
          index++;
        }
        if (this.storedPromises[data.signalDataResponse.requestId]) {
          const { resolve } = this.storedPromises[data.signalDataResponse.requestId];
          delete this.storedPromises[data.signalDataResponse.requestId];
          resolve(dataPoints);
        }
        break;
      }

      case Container.Type.eEventsResponse: {
        if (this.storedPromises[data.eventsResponse.requestId]) {
          const { resolve } = this.storedPromises[data.eventsResponse.requestId];
          delete this.storedPromises[data.eventsResponse.requestId];
          resolve(data.eventsResponse.events);
        }
        break;
      }

      default:
        console.error("Unknown message type", data.messageType);
    }
  }

  _convertTagMap(tagMapObj) {
    const result = {};
    if (!tagMapObj || !tagMapObj.tags) {
      return result;
    }
    for (const [tagKey, tagInfo] of Object.entries(tagMapObj.tags)) {
      result[tagKey] = {
        value: tagInfo.value,
        source: tagInfo.source
      };
    }
    return result;
  }

  _createValue(signalNames, minValues, maxValues, lastValues) {
    const value = {};
    for (let i = 0; i < signalNames.length; i++) {
      const signalType = this.nameToType[signalNames[i]] || CDPValueType.eDOUBLE;
      value[signalNames[i]] = {
        min: this._valueFromVariant(minValues[i], signalType),
        max: this._valueFromVariant(maxValues[i], signalType),
        last: this._valueFromVariant(lastValues[i], signalType)
      };
    }
    return value;
  }

  _valueFromVariant(variant, type) {
    if (!variant) return null;
    switch (type) {
      case CDPValueType.eDOUBLE:
        return variant.dValue;
      case CDPValueType.eFLOAT:
        return variant.fValue;
      case CDPValueType.eUINT64:
        return variant.ui64Value;
      case CDPValueType.eINT64:
        return variant.i64Value;
      case CDPValueType.eUINT:
        return variant.uiValue;
      case CDPValueType.eINT:
        return variant.iValue;
      case CDPValueType.eUSHORT:
        return variant.usValue;
      case CDPValueType.eSHORT:
        return variant.sValue;
      case CDPValueType.eUCHAR:
        return variant.ucValue;
      case CDPValueType.eCHAR:
        return variant.cValue;
      case CDPValueType.eBOOL:
        return variant.bValue;
      case CDPValueType.eSTRING:
        return variant.strValue;
      default:
        return null;
    }
  }

  _sendQueuedRequests() {
    for (const requestId in this.queuedRequests) {
      const req = this.queuedRequests[requestId];
      if (req === "logged_nodes") {
        this._sendLoggedNodesRequest(requestId);
      } else if (req === "log_limits") {
        this._sendLogLimitsRequest(requestId);
      } else if (Array.isArray(req) && req[0] === "node_values") {
        this._reqDataPoints(req[1], req[2], req[3], req[4], requestId);
      } else if (req === "api_version") {
        this._sendApiVersionRequest(requestId);
      } else if (req && req.type === "events") {
        this._sendEventsRequest(requestId, req.query);
      }
    }
    this.queuedRequests = {};
  }

  _getRequestId() {
    this.reqId += 1;
    return this.reqId;
  }

  _timeRequest() {
    if (!this.enableTimeSync) return;
    if ((Date.now() / 1000) > this.lastTimeRequest + 10) {
      this._updateTimeDiff();
    }
  }

  _updateTimeDiff() {
    if (!this.enableTimeSync) return;
    const requestId = this._getRequestId();
    const timeSent = Date.now() / 1000;
    this._requestTime(requestId)
      .then(timestamp => this._setTimeDiff(timestamp, timeSent))
      .catch(err => {
        if (this.storedPromises[requestId]) {
          this.storedPromises[requestId].reject(err);
        }
      });
  }

  _requestTime(reqId) {
    if (!this.enableTimeSync) {
      return Promise.resolve(0);
    }
    const requestId = reqId;
    this.lastTimeRequest = Date.now() / 1000;
    // Always send the time request.
    this._sendTimeRequest(requestId);
    // Create the promise and store the callbacks.
    const promise = new Promise((resolve, reject) => {
      this.storedPromises[requestId] = { resolve, reject };
    });
    return promise;
  }
  
  _sendTimeRequest(requestId) {
    const container = Container.create();
    container.messageType = Container.Type.eTimeRequest;
    container.timeRequest = { requestId: requestId };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }

  _setTimeDiff(timestamp, timeSent) {
    if (!this.enableTimeSync) return;
    const clientTime = this.timeReceived;
    const roundTripTime = clientTime - timeSent;
    const serverTime = (timestamp / 1e9) + roundTripTime / 2;
    const timeDiff = clientTime - serverTime;
    this.roundTripTimes[roundTripTime] = timeDiff;
    if (Object.keys(this.roundTripTimes).length !== 3) {
      this._updateTimeDiff();
    } else {
      const minRoundTrip = Math.min(...Object.keys(this.roundTripTimes).map(Number));
      this.timeDiff = this.roundTripTimes[minRoundTrip];
      this.roundTripTimes = {};
      if (!this.haveSentQueuedReq) {
        this._sendQueuedRequests();
        this.haveSentQueuedReq = true;
      }
    }
  }

  _sendLoggedNodesRequest(requestId) {
    const container = Container.create();
    container.messageType = Container.Type.eSignalInfoRequest;
    container.signalInfoRequest = { requestId: requestId };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }

  _sendLogLimitsRequest(requestId) {
    const container = Container.create();
    container.messageType = Container.Type.eCriterionLimitsRequest;
    container.criterionLimitsRequest = { requestId: requestId };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }

  _reqDataPoints(nodeNames, startS, endS, noOfDataPoints, requestId) {
    const _getDataPoints = (nodeIds) => {
      this._sendDataPointsRequest(nodeIds, startS, endS, requestId, noOfDataPoints);
    };

    const rejectRequest = (error) => {
      if (this.storedPromises[requestId]) {
        const { reject } = this.storedPromises[requestId];
        delete this.storedPromises[requestId];
        reject(error);
      }
    };

    if (!(endS < startS)) {
      this._requestNodeIds(nodeNames)
        .then(nodeIds => _getDataPoints(nodeIds))
        .catch(rejectRequest);
    } else {
      rejectRequest(new Error("InvalidRequestError on node values request: endS cannot be smaller than startS"));
    }
  }

  _requestNodeIds(nodeNames) {
    return new Promise((resolve, reject) => {
      const parseIds = () => {
        for (const name of nodeNames) {
          if (!(name in this.nameToId)) {
            reject(new Error("Node with name " + name + " does not exist."));
            return;
          }
        }
        resolve(nodeNames.map(name => this.nameToId[name]));
      };

      if (nodeNames.every(name => name in this.nameToId)) {
        parseIds();
      } else {
        this.requestLoggedNodes()
          .then(() => parseIds())
          .catch(reject);
      }
    });
  }

  _sendDataPointsRequest(nodeIds, startS, endS, requestId, noOfDataPoints) {
    const container = Container.create();
    container.messageType = Container.Type.eSignalDataRequest;
    container.signalDataRequest = {
      requestId: requestId,
      signalId: nodeIds,
      numOfDatapoints: noOfDataPoints,
      criterionMin: this.enableTimeSync ? (startS - this.timeDiff) : startS,
      criterionMax: this.enableTimeSync ? (endS - this.timeDiff) : endS
    };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }

  _sendApiVersionRequest(requestId) {
    const container = Container.create();
    container.messageType = Container.Type.eVersionRequest;
    container.versionRequest = { requestId: requestId };
    const buffer = Container.encode(container).finish();
    this.ws.send(buffer);
  }
}

module.exports = Client;
