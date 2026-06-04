import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getProxyForUrl,
  inNoProxy,
  requestWithRetry,
  resolveProxyPort,
  selectServername,
} from '../src/http-client';

/**
 * Generate a throwaway self-signed cert (CN=localhost) into a fresh temp dir.
 * Done at test time rather than committing key material to the repo.
 */
function makeSelfSignedCert(): { dir: string; key: Buffer; cert: Buffer } {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'logfire-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  return { dir, key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** Start a server and resolve once it is listening, returning its port. */
function listen(server: http.Server | https.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });
}

describe('getProxyForUrl', () => {
  it('returns empty when no proxy env is set', () => {
    expect(getProxyForUrl('https://x.com', {})).toBe('');
  });

  it('uses HTTPS_PROXY for https targets', () => {
    expect(getProxyForUrl('https://x.com', { HTTPS_PROXY: 'http://p:8080' })).toBe('http://p:8080');
  });

  it('uses HTTP_PROXY for http targets', () => {
    expect(getProxyForUrl('http://x.com', { HTTP_PROXY: 'http://p:8080' })).toBe('http://p:8080');
  });

  it('does not fall back from https to HTTP_PROXY', () => {
    expect(getProxyForUrl('https://x.com', { HTTP_PROXY: 'http://p:8080' })).toBe('');
  });

  it('falls back to ALL_PROXY', () => {
    expect(getProxyForUrl('https://x.com', { ALL_PROXY: 'http://all:1' })).toBe('http://all:1');
  });

  it('honors NO_PROXY=*', () => {
    expect(getProxyForUrl('https://x.com', { HTTPS_PROXY: 'http://p', NO_PROXY: '*' })).toBe('');
  });

  it('honors NO_PROXY suffix match', () => {
    expect(
      getProxyForUrl('https://api.x.com', { HTTPS_PROXY: 'http://p', NO_PROXY: 'x.com' }),
    ).toBe('');
  });

  it('proxies when NO_PROXY does not match', () => {
    expect(
      getProxyForUrl('https://x.com', { HTTPS_PROXY: 'http://p', NO_PROXY: 'other.com' }),
    ).toBe('http://p');
  });

  it('ignores NO_PROXY entry with a mismatched port', () => {
    expect(
      getProxyForUrl('https://x.com:8443', { HTTPS_PROXY: 'http://p', NO_PROXY: 'x.com:443' }),
    ).toBe('http://p');
  });

  it('returns empty for an unparseable target URL', () => {
    expect(getProxyForUrl('http://[not a url', { HTTPS_PROXY: 'http://p' })).toBe('');
  });

  it('ignores a NO_PROXY entry that normalizes to empty', () => {
    // "." normalizes to an empty host and must not match anything.
    expect(getProxyForUrl('https://x.com', { HTTPS_PROXY: 'http://p', NO_PROXY: '.' })).toBe(
      'http://p',
    );
  });
});

describe('resolveProxyPort', () => {
  it('uses the explicit port', () => {
    expect(resolveProxyPort(new URL('http://p:8080'))).toBe(8080);
  });
  it('defaults http to 80', () => {
    expect(resolveProxyPort(new URL('http://p'))).toBe(80);
  });
  it('defaults https to 443', () => {
    expect(resolveProxyPort(new URL('https://p'))).toBe(443);
  });
});

describe('selectServername', () => {
  it('prefers an explicit servername', () => {
    expect(selectServername('localhost', '127.0.0.1')).toBe('localhost');
  });
  it('uses the hostname when it is not an IP', () => {
    expect(selectServername(undefined, 'example.com')).toBe('example.com');
  });
  it('omits SNI for an IPv4 literal', () => {
    expect(selectServername(undefined, '127.0.0.1')).toBeUndefined();
  });
  it('omits SNI for an IPv6 literal', () => {
    expect(selectServername(undefined, '::1')).toBeUndefined();
  });
});

describe('inNoProxy', () => {
  it('matches a leading-dot subdomain entry', () => {
    expect(inNoProxy('a.example.com', '443', '.example.com')).toBe(true);
  });

  it('matches a wildcard base exactly', () => {
    expect(inNoProxy('example.com', '443', '*.example.com')).toBe(true);
  });

  it('does not produce false suffix matches', () => {
    expect(inNoProxy('notexample.com', '443', 'example.com')).toBe(false);
  });
});

describe('requestWithRetry', () => {
  it('retries 5xx then succeeds', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      if (hits < 3) {
        res.writeHead(503);
        res.end('try later');
        return;
      }
      res.writeHead(200);
      res.end('ok-after-retries');
    });
    const port = await listen(server);
    const reasons: string[] = [];

    const r = await requestWithRetry(`http://127.0.0.1:${port}/`, { method: 'GET' }, undefined, {
      baseDelayMs: 5,
      onRetry: (i) => reasons.push(i.reason),
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('ok-after-retries');
    expect(hits).toBe(3);
    expect(reasons).toEqual(['HTTP 503', 'HTTP 503']);
    server.close();
  });

  it('does not retry a 4xx response', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(400);
      res.end('nope');
    });
    const port = await listen(server);
    let retried = 0;

    const r = await requestWithRetry(`http://127.0.0.1:${port}/`, { method: 'GET' }, undefined, {
      baseDelayMs: 5,
      onRetry: () => (retried += 1),
    });

    expect(r.statusCode).toBe(400);
    expect(retried).toBe(0);
    server.close();
  });

  it('throws on timeout when no retries remain', async () => {
    const server = http.createServer(() => {
      /* never responds */
    });
    const port = await listen(server);

    await expect(
      requestWithRetry(`http://127.0.0.1:${port}/`, { method: 'GET' }, undefined, {
        timeoutMs: 150,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/timed out/);
    server.close();
  });

  it('retries a timeout then gives up', async () => {
    const server = http.createServer(() => {
      /* never responds */
    });
    const port = await listen(server);
    let retried = 0;

    await expect(
      requestWithRetry(`http://127.0.0.1:${port}/`, { method: 'GET' }, undefined, {
        timeoutMs: 80,
        maxRetries: 2,
        baseDelayMs: 5,
        onRetry: () => (retried += 1),
      }),
    ).rejects.toThrow(/timed out/);
    expect(retried).toBe(2);
    server.close();
  });

  it('retries without an onRetry callback', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(hits < 2 ? 503 : 200);
      res.end(hits < 2 ? 'wait' : 'ok');
    });
    const port = await listen(server);

    // No onRetry provided — exercises the default no-op.
    const r = await requestWithRetry(`http://127.0.0.1:${port}/`, { method: 'GET' }, undefined, {
      baseDelayMs: 1,
    });

    expect(r.statusCode).toBe(200);
    expect(hits).toBe(2);
    server.close();
  });

  it('proxies through an authenticated proxy and defaults the method to GET', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('auth-ok');
    });
    const upPort = await listen(upstream);

    let proxyAuth: string | undefined;
    let seenMethod: string | undefined;
    const proxy = http.createServer((req, res) => {
      proxyAuth = req.headers['proxy-authorization'];
      seenMethod = req.method;
      const u = new URL(req.url!);
      http.get({ host: u.hostname, port: u.port, path: u.pathname }, (pr) => {
        let d = '';
        pr.on('data', (c) => (d += c));
        pr.on('end', () => {
          res.writeHead(pr.statusCode!);
          res.end(d);
        });
      });
    });
    const proxyPort = await listen(proxy);

    // No `method` in options → defaults to GET. Proxy URL carries credentials.
    const r = await requestWithRetry(`http://127.0.0.1:${upPort}/y`, {}, undefined, {
      proxy: `http://user:p%40ss@127.0.0.1:${proxyPort}`,
      maxRetries: 0,
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('auth-ok');
    expect(seenMethod).toBe('GET');
    expect(proxyAuth).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`);
    upstream.close();
    proxy.close();
  });

  it('proxies plain HTTP using the absolute-form request path', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('plain-ok');
    });
    const upPort = await listen(upstream);

    let seenPath: string | undefined;
    const proxy = http.createServer((req, res) => {
      seenPath = req.url;
      const u = new URL(req.url!);
      http.get({ host: u.hostname, port: u.port, path: u.pathname }, (pr) => {
        let d = '';
        pr.on('data', (c) => (d += c));
        pr.on('end', () => {
          res.writeHead(pr.statusCode!);
          res.end(d);
        });
      });
    });
    const proxyPort = await listen(proxy);

    const r = await requestWithRetry(`http://127.0.0.1:${upPort}/x`, { method: 'GET' }, undefined, {
      proxy: `http://127.0.0.1:${proxyPort}`,
      maxRetries: 0,
    });

    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('plain-ok');
    expect(seenPath).toBe(`http://127.0.0.1:${upPort}/x`);
    upstream.close();
    proxy.close();
  });
});

describe('requestWithRetry over a CONNECT proxy (TLS tunnel)', () => {
  let cert: { dir: string; key: Buffer; cert: Buffer };

  beforeAll(() => {
    cert = makeSelfSignedCert();
  });
  afterAll(() => {
    fs.rmSync(cert.dir, { recursive: true, force: true });
  });

  it('tunnels an https request through an http CONNECT proxy', async () => {
    const upstream = https.createServer(
      {
        key: cert.key,
        cert: cert.cert,
      },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('tunneled-ok');
      },
    );
    const upPort = await listen(upstream);

    let connectTarget: string | undefined;
    // The proxy ignores the requested host and routes to the real upstream.
    // The client targets `tunnel.invalid`, which does NOT resolve — so the
    // request can only succeed if it genuinely goes through the tunnel socket
    // (i.e. our custom Agent.createConnection is honored), not a direct dial.
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      connectTarget = req.url;
      const up = net.connect(upPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      });
      up.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => up.destroy());
    });
    const proxyPort = await listen(proxy);

    // Verify against the generated CA with servername 'localhost' (the cert's
    // SAN) — exercises real TLS verification through the tunnel.
    const r = await requestWithRetry(
      `https://tunnel.invalid/`,
      { method: 'GET', ca: cert.cert, servername: 'localhost' },
      undefined,
      { proxy: `http://127.0.0.1:${proxyPort}`, timeoutMs: 5000, maxRetries: 1 },
    );

    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('tunneled-ok');
    expect(connectTarget).toBe('tunnel.invalid:443');
    upstream.close();
    proxy.close();
  });

  it('rejects when the proxy refuses the CONNECT', async () => {
    const proxy = http.createServer();
    proxy.on('connect', (_req, clientSocket) => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });
    const proxyPort = await listen(proxy);

    // Portless https target → CONNECT path uses the default 443.
    await expect(
      requestWithRetry(`https://example.invalid/`, { method: 'GET' }, undefined, {
        proxy: `http://127.0.0.1:${proxyPort}`,
        timeoutMs: 2000,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/Proxy CONNECT to example\.invalid failed \(HTTP 502\)/);
    proxy.close();
  });

  it('rejects when the proxy never completes the CONNECT (timeout)', async () => {
    // Raw TCP server that accepts the socket but never answers the CONNECT.
    const proxy = net.createServer(() => {
      /* hold the connection open, send nothing */
    });
    const proxyPort = await listen(proxy as unknown as http.Server);

    await expect(
      requestWithRetry(`https://example.invalid/`, { method: 'GET' }, undefined, {
        proxy: `http://127.0.0.1:${proxyPort}`,
        timeoutMs: 150,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/Proxy CONNECT to example\.invalid timed out/);
    proxy.close();
  });
});
