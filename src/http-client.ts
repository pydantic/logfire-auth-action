/**
 * Shared HTTP client for the Logfire OIDC action.
 *
 * Wraps Node's built-in http/https with three things the bare modules lack:
 *   - a per-request socket timeout, so a hung connection fails fast instead of
 *     blocking until the job-level timeout;
 *   - HTTP(S) proxy support — plain proxying for http targets and CONNECT
 *     tunneling for https targets — honoring the conventional HTTPS_PROXY /
 *     HTTP_PROXY / ALL_PROXY / NO_PROXY environment variables that Node's
 *     http/https otherwise ignore;
 *   - retry with jittered exponential backoff on transient failures (network
 *     errors, request timeouts, HTTP 408/429, and 5xx). 4xx responses are
 *     returned as-is so the caller can surface a permanent policy rejection.
 *
 * Built-in Node.js modules only — no runtime npm dependencies.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 10000;

export interface HttpResponse {
  statusCode: number | undefined;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  reason: string;
  delayMs: number;
}

export interface RequestOpts {
  /** Max retry attempts on transient failures. Default 3; 0 disables. */
  maxRetries?: number;
  /** Per-request socket timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /** Base backoff delay in milliseconds. Default 200. */
  baseDelayMs?: number;
  /** Explicit proxy override; '' / undefined falls back to the proxy env vars. */
  proxy?: string;
  /** Invoked before each retry sleep. */
  onRetry?: (info: RetryInfo) => void;
}

// --- Proxy resolution (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY) ---

/** @param noProxy comma/space-separated NO_PROXY list */
export function inNoProxy(hostname: string, port: string, noProxy: string): boolean {
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      let host = entry;
      let entryPort = '';
      const m = entry.match(/^(.+):(\d+)$/);
      if (m) {
        host = m[1]!;
        entryPort = m[2]!;
      }
      if (entryPort && entryPort !== String(port)) return false;
      // Normalize leading "*." or "." so ".example.com" matches "example.com".
      host = host.replace(/^\*?\.?/, '');
      if (!host) return false;
      return hostname === host || hostname.endsWith(`.${host}`);
    });
}

/** The port to connect to on a proxy, applying protocol defaults. */
export function resolveProxyPort(proxy: URL): number {
  if (proxy.port) return Number(proxy.port);
  return proxy.protocol === 'https:' ? 443 : 80;
}

/**
 * The SNI servername to present: an explicit override wins; otherwise the
 * hostname, unless it is an IP literal (RFC 6066 forbids SNI for IPs).
 */
export function selectServername(optionServername: unknown, hostname: string): string | undefined {
  if (typeof optionServername === 'string') return optionServername;
  return net.isIP(hostname) ? undefined : hostname;
}

/**
 * Resolve the proxy URL for a target, or '' if it should be reached directly.
 * Mirrors the de-facto `proxy-from-env` semantics.
 */
export function getProxyForUrl(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return '';
  }
  const isHttps = target.protocol === 'https:';
  const port = target.port || (isHttps ? '443' : '80');
  const noProxy = (env.NO_PROXY || env.no_proxy || '').trim();
  if (noProxy === '*') return '';
  if (noProxy && inNoProxy(target.hostname, port, noProxy)) return '';
  const proxy = isHttps
    ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy
    : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
  return (proxy || '').trim();
}

// --- Single request (timeout + optional proxy) ---

/** @param proxyUrl '' for a direct connection */
export function makeRequest(
  targetUrl: string,
  options: https.RequestOptions,
  body: string | undefined,
  proxyUrl: string,
  timeoutMs: number,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';
    let done = false;
    const succeed = (r: HttpResponse) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const fail = (e: Error) => {
      if (!done) {
        done = true;
        reject(e);
      }
    };

    const onResponse = (res: http.IncomingMessage) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () =>
        succeed({ statusCode: res.statusCode, body: data, headers: res.headers }),
      );
      res.on('error', fail);
    };

    const wire = (req: http.ClientRequest) => {
      req.on('error', fail);
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request to ${target.host} timed out after ${timeoutMs}ms`));
      });
      if (body) req.write(body);
      req.end();
    };

    // Direct connection.
    if (!proxyUrl) {
      const transport = isHttps ? https : http;
      wire(transport.request(targetUrl, options, onResponse));
      return;
    }

    const proxy = new URL(proxyUrl);
    const proxyHeaders: Record<string, string> = {};
    if (proxy.username) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
    }
    const proxyPort = resolveProxyPort(proxy);

    // Plain HTTP through a proxy: send the absolute URL as the request path.
    if (!isHttps) {
      const req = http.request(
        {
          host: proxy.hostname,
          port: proxyPort,
          method: options.method || 'GET',
          path: targetUrl,
          headers: { ...(options.headers || {}), ...proxyHeaders, Host: target.host },
        },
        onResponse,
      );
      wire(req);
      return;
    }

    // HTTPS through a proxy: open a CONNECT tunnel, then run TLS over it.
    const targetPort = target.port || '443';
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: { ...proxyHeaders, Host: `${target.hostname}:${targetPort}` },
    });
    connectReq.on('error', fail);
    connectReq.setTimeout(timeoutMs, () => {
      connectReq.destroy(
        new Error(`Proxy CONNECT to ${target.host} timed out after ${timeoutMs}ms`),
      );
    });
    connectReq.on('connect', (res: http.IncomingMessage, socket: net.Socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`Proxy CONNECT to ${target.host} failed (HTTP ${res.statusCode})`));
        return;
      }
      // Run TLS over the established tunnel. A request-level `createConnection`
      // is ignored once an Agent is involved, so route it through a one-off
      // Agent whose createConnection returns the tunneled TLS socket (the
      // https-proxy-agent pattern). Forward the caller's TLS trust settings so
      // the tunneled connection verifies like a direct https request would.
      const servername = selectServername(options.servername, target.hostname);
      const tunnelAgent = new https.Agent();
      tunnelAgent.createConnection = (() => {
        const tlsSocket = tls.connect({
          socket,
          servername,
          ca: options.ca,
          rejectUnauthorized: options.rejectUnauthorized,
        });
        tlsSocket.on('error', fail);
        return tlsSocket;
      }) as typeof tunnelAgent.createConnection;
      const req = https.request(targetUrl, { ...options, agent: tunnelAgent }, onResponse);
      wire(req);
    });
    connectReq.end();
  });
}

// --- Retry with jittered exponential backoff ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full-jitter backoff, capped. */
function backoffDelay(base: number, attempt: number): number {
  const ceiling = Math.min(base * 2 ** attempt, MAX_DELAY_MS);
  return Math.floor(Math.random() * ceiling);
}

function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === 408 ||
    status === 429 ||
    (typeof status === 'number' && status >= 500 && status <= 599)
  );
}

/** Make an HTTP(S) request, retrying transient failures. */
export async function requestWithRetry(
  url: string,
  options: https.RequestOptions,
  body?: string,
  opts: RequestOpts = {},
): Promise<HttpResponse> {
  const maxRetries = Number.isFinite(opts.maxRetries)
    ? Math.max(0, opts.maxRetries!)
    : DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseDelayMs = opts.baseDelayMs || DEFAULT_BASE_DELAY_MS;
  const onRetry = opts.onRetry || (() => {});
  const proxyUrl = opts.proxy || getProxyForUrl(url);

  let attempt = 0;
  for (;;) {
    try {
      const response = await makeRequest(url, options, body, proxyUrl, timeoutMs);
      if (attempt < maxRetries && isRetryableStatus(response.statusCode)) {
        const delayMs = backoffDelay(baseDelayMs, attempt);
        onRetry({
          attempt: attempt + 1,
          maxRetries,
          reason: `HTTP ${response.statusCode}`,
          delayMs,
        });
        await sleep(delayMs);
        attempt += 1;
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delayMs = backoffDelay(baseDelayMs, attempt);
      onRetry({ attempt: attempt + 1, maxRetries, reason: (err as Error).message, delayMs });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}
