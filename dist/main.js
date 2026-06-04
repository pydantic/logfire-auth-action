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

// src/run.ts
var crypto = __toESM(require("node:crypto"));

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
var fs = __toESM(require("node:fs"));
function getInput(name) {
  const val = process.env[`INPUT_${name.replace(/-/g, "_").toUpperCase()}`] || "";
  return val.trim();
}
function setOutput(name, value) {
  const filePath = process.env.GITHUB_OUTPUT;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}
`);
  }
}
function saveState(name, value) {
  const filePath = process.env.GITHUB_STATE;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}
`);
  }
}
function setSecret(value) {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}
function setFailed(message) {
  console.log(`::error::${message}`);
  process.exitCode = 1;
}
function debug(message) {
  console.log(`::debug::${message}`);
}
function info(message) {
  console.log(message);
}

// src/run.ts
var TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
var JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
async function exchangeToken(tokenUrl, { subjectToken, audience, scope }, httpOpts) {
  const params = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subjectToken,
    subject_token_type: JWT_TOKEN_TYPE,
    audience
  });
  if (scope) {
    params.set("scope", scope);
  }
  const formBody = params.toString();
  const response = await requestWithRetry(
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(formBody)
      }
    },
    formBody,
    httpOpts
  );
  if (response.statusCode !== 200) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body);
      detail = parsed.error_description || parsed.error || detail;
    } catch {
    }
    throw new Error(`Token exchange failed (HTTP ${response.statusCode}): ${detail}`);
  }
  return JSON.parse(response.body);
}
async function getIDToken(audience, httpOpts) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error(
      'GitHub OIDC not available. Ensure the job has "permissions: id-token: write" and the workflow uses a supported event trigger.'
    );
  }
  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await requestWithRetry(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `bearer ${requestToken}`,
        Accept: "application/json"
      }
    },
    void 0,
    httpOpts
  );
  if (response.statusCode !== 200) {
    throw new Error(
      `Failed to get GitHub OIDC token (HTTP ${response.statusCode}): ${response.body}`
    );
  }
  return JSON.parse(response.body).value;
}
function sha256hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
function computeTraceId(runId, runAttempt) {
  return sha256hex(`logfire:github:trace:${runId}:${runAttempt}`).substring(0, 32);
}
function computeJobSpanId(runId, runAttempt, jobName) {
  return sha256hex(`logfire:github:job:${runId}:${runAttempt}:${jobName}`).substring(0, 16);
}
var REGION_URLS = {
  us: "https://logfire-us.pydantic.dev",
  eu: "https://logfire-eu.pydantic.dev",
  "staging-eu": "https://logfire-eu.pydantic.info"
};
function resolveUrl(region, url) {
  if (url) return url;
  if (region) {
    const resolved = REGION_URLS[region];
    if (!resolved) {
      throw new Error(
        `Unknown region '${region}'. Use: us, eu, staging-eu, or provide a custom url.`
      );
    }
    return resolved;
  }
  return REGION_URLS.us;
}
function resolveAudience({
  audienceInput,
  organization,
  project,
  resolvedUrl
}) {
  if (audienceInput && (organization || project)) {
    throw new Error(
      'Input "audience" cannot be combined with "organization" or "project". Provide a full audience that already encodes the org/project path, or omit "audience" and pass "organization" (+ optional "project") instead.'
    );
  }
  if (audienceInput) {
    return { oidcAudience: audienceInput, exchangeAudience: audienceInput };
  }
  if (!organization) {
    throw new Error('Input "organization" is required (unless a full "audience" is provided)');
  }
  const exchangeAudience = project ? `${resolvedUrl}/${organization}/${project}` : `${resolvedUrl}/${organization}`;
  return { oidcAudience: exchangeAudience, exchangeAudience };
}
function parseScopes(scopesInput) {
  return scopesInput ? scopesInput.split(/\s+/).filter(Boolean).join(" ") : "";
}
function readHttpOpts() {
  const maxRetriesInput = parseInt(getInput("max-retries"), 10);
  const timeoutInput = parseInt(getInput("request-timeout"), 10);
  return {
    maxRetries: Number.isNaN(maxRetriesInput) ? void 0 : Math.max(0, maxRetriesInput),
    timeoutMs: Number.isNaN(timeoutInput) ? void 0 : Math.max(1, timeoutInput) * 1e3,
    proxy: getInput("proxy") || void 0,
    onRetry: (r) => debug(`Retry ${r.attempt}/${r.maxRetries} in ${r.delayMs}ms (${r.reason})`)
  };
}
async function run() {
  const region = getInput("region");
  const url = getInput("url");
  const resolvedUrl = resolveUrl(region, url);
  setOutput("logfire-url", resolvedUrl);
  debug(`Resolved Logfire URL: ${resolvedUrl}`);
  const httpOpts = readHttpOpts();
  const runId = process.env.GITHUB_RUN_ID || "";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  const jobId = getInput("job-id") || process.env.GITHUB_JOB || "";
  const traceId = computeTraceId(runId, runAttempt);
  const jobSpanId = computeJobSpanId(runId, runAttempt, jobId);
  const traceparent = `00-${traceId}-${jobSpanId}-01`;
  setOutput("traceparent", traceparent);
  setOutput("trace-id", traceId);
  debug(`Traceparent: ${traceparent}`);
  const { oidcAudience, exchangeAudience } = resolveAudience({
    audienceInput: getInput("audience"),
    organization: getInput("organization"),
    project: getInput("project"),
    resolvedUrl
  });
  const subjectToken = await getIDToken(oidcAudience, httpOpts);
  setSecret(subjectToken);
  const scope = parseScopes(getInput("scopes"));
  const result = await exchangeToken(
    `${resolvedUrl}/api/oauth/token`,
    { subjectToken, audience: exchangeAudience, scope },
    httpOpts
  );
  const accessToken = result.access_token;
  const expiresIn = result.expires_in;
  const grantedScopes = result.scope || "";
  setSecret(accessToken);
  setOutput("token", accessToken);
  setOutput("expires-in", String(expiresIn));
  setOutput("scopes", grantedScopes);
  const skipCleanup = getInput("skip-cleanup").toLowerCase() === "true";
  saveState("access_token", accessToken);
  saveState("logfire_url", resolvedUrl);
  saveState("skip_cleanup", skipCleanup ? "true" : "");
  info(
    `Logfire OIDC authentication successful (expires in ${expiresIn}s, scopes: ${grantedScopes})`
  );
}

// src/main.ts
void run().catch((error) => {
  setFailed(error instanceof Error ? error.message : String(error));
});
