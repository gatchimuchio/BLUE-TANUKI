"use strict";

// Test-only network boundary for a served Gateway process. GitHub traffic is
// redirected to a test-owned loopback HTTP server; all other outbound hosts fail closed.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const originalHttpRequest = http.request.bind(http);
const originalHttpGet = http.get.bind(http);
const originalNetConnect = net.connect.bind(net);
const originalTlsConnect = tls.connect.bind(tls);
const originalFetch = globalThis.fetch;
const loopbackAgent = new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
const port = Number(process.env.BT_F05_02_GITHUB_MOCK_PORT);
const loopback = new Set(["127.0.0.1", "::1", "localhost"]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("synthetic GitHub mock port is missing or invalid");
}

function networkHost(args) {
  const first = args[0];
  if (first && typeof first === "object" && !(first instanceof URL)) {
    return String(first.hostname || first.host || "localhost").replace(/:\d+$/u, "").toLowerCase();
  }
  if (first instanceof URL) return first.hostname.toLowerCase();
  if (typeof first === "string") {
    try { return new URL(first).hostname.toLowerCase(); } catch { return first.toLowerCase(); }
  }
  return typeof args[1] === "string" ? args[1].toLowerCase() : "localhost";
}

function assertLoopback(host, api = "network") {
  if (!loopback.has(host)) throw new Error("synthetic Gateway test blocked outbound " + api + " host: " + host);
}

function routeGitHubHttps(args) {
  const first = args[0];
  let options;
  let callback;
  if (first instanceof URL || typeof first === "string") {
    const url = first instanceof URL ? first : new URL(first);
    options = { protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined,
      path: url.pathname + url.search };
    if (args[1] && typeof args[1] === "object") options = { ...options, ...args[1] };
    callback = typeof args[1] === "function" ? args[1] : typeof args[2] === "function" ? args[2] : undefined;
  } else {
    options = { ...first };
    callback = typeof args[1] === "function" ? args[1] : undefined;
  }

  const requestedHost = String(options.hostname || options.host || "").replace(/:\d+$/u, "").toLowerCase();
  if (requestedHost !== "api.github.com") {
    throw new Error("synthetic Gateway test blocked HTTPS host: " + requestedHost);
  }
  const routed = { ...options, protocol: "http:", hostname: "127.0.0.1", host: "127.0.0.1", port,
    servername: undefined, agent: loopbackAgent, lookup: undefined };
  return originalHttpRequest(routed, callback);
}

http.request = function guardedHttpRequest(...args) {
  assertLoopback(networkHost(args), "HTTP");
  return originalHttpRequest(...args);
};
http.get = function guardedHttpGet(...args) {
  assertLoopback(networkHost(args), "HTTP");
  return originalHttpGet(...args);
};
https.request = function guardedGitHubHttpsRequest(...args) {
  return routeGitHubHttps(args);
};
https.get = function guardedHttpsGet(...args) {
  const request = routeGitHubHttps(args);
  request.end();
  return request;
};
net.connect = function guardedNetConnect(...args) {
  assertLoopback(networkHost(args), "socket");
  return originalNetConnect(...args);
};
net.createConnection = net.connect;
tls.connect = function guardedTlsConnect(...args) {
  assertLoopback(networkHost(args), "TLS");
  return originalTlsConnect(...args);
};
if (typeof originalFetch === "function") {
  globalThis.fetch = function guardedFetch(resource, ...args) {
    let host = "";
    try {
      host = resource instanceof URL ? resource.hostname.toLowerCase()
        : typeof resource === "string" ? new URL(resource).hostname.toLowerCase()
          : new URL(resource.url).hostname.toLowerCase();
    } catch {
      return Promise.reject(new Error("synthetic Gateway test blocked invalid fetch target"));
    }
    assertLoopback(host, "fetch");
    return originalFetch(resource, ...args);
  };
}
