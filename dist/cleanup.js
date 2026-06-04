"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/http-client.ts
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
var net = __toESM(require("node:net"));
var tls = __toESM(require("node:tls"));
var DEFAULT_TIMEOUT_MS = 1e4;
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_BASE_DELAY_MS = 200;
var MAX_DELAY_MS = 1e4;
function inNoProxy(hostname, port, noProxy) {
  return noProxy.split(/[\s,]+/).filter(Boolean).some((entry) => {
    let host = entry;
    let entryPort = "";
    const m = entry.match(/^(.+):(\d+)$/);
    if (m) {
      host = m[1];
      entryPort = m[2];
    }
    if (entryPort && entryPort !== String(port)) return false;
    host = host.replace(/^\*?\.?/, "");
    if (!host) return false;
    return hostname === host || hostname.endsWith(`.${host}`);
  });
}
function resolveProxyPort(proxy) {
  if (proxy.port) return Number(proxy.port);
  return proxy.protocol === "https:" ? 443 : 80;
}
function selectServername(optionServername, hostname) {
  if (typeof optionServername === "string") return optionServername;
  return net.isIP(hostname) ? void 0 : hostname;
}
function getProxyForUrl(targetUrl, env = process.env) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return "";
  }
  const isHttps = target.protocol === "https:";
  const port = target.port || (isHttps ? "443" : "80");
  const noProxy = (env.NO_PROXY || env.no_proxy || "").trim();
  if (noProxy === "*") return "";
  if (noProxy && inNoProxy(target.hostname, port, noProxy)) return "";
  const proxy = isHttps ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return (proxy || "").trim();
}
function makeRequest(targetUrl, options, body, proxyUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const isHttps = target.protocol === "https:";
    let done = false;
    const succeed = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const fail = (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    };
    const onResponse = (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on(
        "end",
        () => succeed({ statusCode: res.statusCode, body: data, headers: res.headers })
      );
      res.on("error", fail);
    };
    const wire = (req) => {
      req.on("error", fail);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms`));
      });
      if (body) req.write(body);
      req.end();
    };
    if (!proxyUrl) {
      const transport = isHttps ? https : http;
      wire(transport.request(targetUrl, options, onResponse));
      return;
    }
    const proxy = new URL(proxyUrl);
    const proxyHeaders = {};
    if (proxy.username) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyHeaders["Proxy-Authorization"] = `Basic ${Buffer.from(creds).toString("base64")}`;
    }
    const proxyPort = resolveProxyPort(proxy);
    if (!isHttps) {
      const req = http.request(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: options.method || "GET",
          path: targetUrl,
          headers: { ...options.headers || {}, ...proxyHeaders, Host: target.host }
        },
        onResponse
      );
      wire(req);
      return;
    }
    const targetPort = target.port || "443";
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: "CONNECT",
      path: `${target.hostname}:${targetPort}`,
      headers: { ...proxyHeaders, Host: `${target.hostname}:${targetPort}` }
    });
    connectReq.on("error", fail);
    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(
        new Error(`Proxy CONNECT to ${target.host} timed out after ${timeoutMs}ms`)
      );
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT to ${target.host} failed (HTTP ${res.statusCode})`));
        return;
      }
      const servername = selectServername(options.servername, target.hostname);
      const tunnelAgent = new https.Agent();
      tunnelAgent.createConnection = (() => {
        const tlsSocket = tls.connect({
          socket,
          servername,
          ca: options.ca,
          rejectUnauthorized: options.rejectUnauthorized
        });
        tlsSocket.on("error", fail);
        return tlsSocket;
      });
      const req = https.request(targetUrl, { ...options, agent: tunnelAgent }, onResponse);
      wire(req);
    });
    connectReq.end();
  });
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffDelay(base, attempt) {
  const ceiling = Math.min(base * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(Math.random() * ceiling);
}
function isRetryableStatus(status) {
  return status === 408 || status === 429 || typeof status === "number" && status >= 500 && status <= 599;
}
async function requestWithRetry(url, options, body, opts = {}) {
  const maxRetries = Number.isFinite(opts.maxRetries) ? Math.max(0, opts.maxRetries) : DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseDelayMs = opts.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const onRetry = opts.onRetry || (() => {
  });
  const proxyUrl = opts.proxy || getProxyForUrl(url);
  let attempt = 0;
  for (; ; ) {
    try {
      const response = await makeRequest(url, options, body, proxyUrl, timeoutMs);
      if (attempt < maxRetries && isRetryableStatus(response.statusCode)) {
        const delayMs = backoffDelay(baseDelayMs, attempt);
        onRetry({
          attempt: attempt + 1,
          maxRetries,
          reason: `HTTP ${response.statusCode}`,
          delayMs
        });
        await sleep(delayMs);
        attempt += 1;
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delayMs = backoffDelay(baseDelayMs, attempt);
      onRetry({ attempt: attempt + 1, maxRetries, reason: err.message, delayMs });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

// src/actions.ts
function getState(name) {
  return (process.env[`STATE_${name}`] || "").trim();
}
function warning(message) {
  console.log(`::warning::${message}`);
}
function debug(message) {
  console.log(`::debug::${message}`);
}

// src/post.ts
async function revokeToken(revokeUrl, token) {
  const formBody = new URLSearchParams({
    token,
    token_type_hint: "access_token"
  }).toString();
  const response = await requestWithRetry(
    revokeUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formBody)
      }
    },
    formBody,
    {
      onRetry: (r) => debug(`Revoke retry ${r.attempt}/${r.maxRetries} in ${r.delayMs}ms (${r.reason})`)
    }
  );
  return typeof response.statusCode === "number" && response.statusCode >= 200 && response.statusCode < 300;
}
async function post() {
  const accessToken = getState("access_token");
  const logfireUrl = getState("logfire_url");
  if (getState("skip_cleanup") === "true") {
    debug("skip-cleanup is set; leaving the token to expire naturally");
    return;
  }
  if (!accessToken) {
    debug("No token to revoke");
    return;
  }
  if (!logfireUrl) {
    warning("Cannot revoke token: Logfire URL not saved from main step");
    return;
  }
  try {
    const ok = await revokeToken(`${logfireUrl}/api/oauth/revoke`, accessToken);
    if (ok) {
      debug("Revoked workload token");
    } else {
      warning("Token revocation returned non-200 (token will expire naturally)");
    }
  } catch (error) {
    warning(`Token revocation failed: ${error.message} (token will expire naturally)`);
  }
}

// src/cleanup.ts
void post();
