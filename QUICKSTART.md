---

```md
# Quick Start Guide – CDPLogger Client

This guide shows how to quickly get started using the CDPLogger Client in both **Node.js** and **Browser** environments.

---

## Installation

### Node.js

```bash
npm install cdp-logger-client ws
```

---

## Usage

### Node.js Example

```js
// Import client and setup WebSocket
const cdplogger = require('cdp-logger-client');
global.WebSocket = require('ws');

// Create client instance
const client = new cdplogger.Client('127.0.0.1:17000');

// Fetch API version
client.requestApiVersion().then(console.log);

// List logged nodes
client.requestLoggedNodes().then(nodes => {
  nodes.forEach(n => console.log(n.name));
});
```

---

### Browser Example

```html
<!-- Add these in your HTML -->
<script src="protobuf.min.js"></script>
<script src="containerPb.js"></script>
<script src="client.js"></script>

<script>
  const client = new cdplogger.Client("ws://127.0.0.1:17000");

  client.requestApiVersion().then(console.log);

  client.requestLoggedNodes().then(nodes => {
    nodes.forEach(n => console.log(n.name));
  });
</script>
```

---

## Prerequisites

- CDP Studio application running with **CDPLogger**
- WebSocket port open (e.g., `17000`)
- For Node.js: install `ws` as WebSocket polyfill

---

## Learn More

- [Full README](https://github.com/CDPTechnologies/JavascriptCDPLoggerClient)
- [CDP Logger Docs](https://cdpstudio.com/manual/cdp/cdplogger/cdplogger-iloggerndex.html)

```

---

