import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import nock from 'nock';
import {
  resolveUrl,
  computeTraceId,
  computeJobSpanId,
  resolveAudience,
  parseScopes,
  readHttpOpts,
  run,
} from '../src/run';

/** nock hands the request body to the reply callback as a urlencoded string. */
function parseForm(body: unknown): Record<string, string> {
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
  if (body && typeof body === 'object') return body as Record<string, string>;
  return {};
}

describe('resolveUrl', () => {
  it('maps region presets', () => {
    expect(resolveUrl('us', '')).toBe('https://logfire-us.pydantic.dev');
    expect(resolveUrl('eu', '')).toBe('https://logfire-eu.pydantic.dev');
    expect(resolveUrl('staging-eu', '')).toBe('https://logfire-eu.pydantic.info');
  });

  it('defaults to us when nothing is given', () => {
    expect(resolveUrl('', '')).toBe('https://logfire-us.pydantic.dev');
  });

  it('prefers an explicit url over region', () => {
    expect(resolveUrl('eu', 'https://logfire.internal')).toBe('https://logfire.internal');
  });

  it('throws on an unknown region', () => {
    expect(() => resolveUrl('moon', '')).toThrow(/Unknown region/);
  });
});

describe('traceparent helpers', () => {
  it('produces 32-hex trace ids and 16-hex span ids', () => {
    expect(computeTraceId('42', '1')).toMatch(/^[0-9a-f]{32}$/);
    expect(computeJobSpanId('42', '1', 'build')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(computeTraceId('42', '1')).toBe(computeTraceId('42', '1'));
    expect(computeJobSpanId('42', '1', 'build')).toBe(computeJobSpanId('42', '1', 'build'));
  });

  it('varies the span id per job (matrix combinations)', () => {
    expect(computeJobSpanId('42', '1', 'a')).not.toBe(computeJobSpanId('42', '1', 'b'));
  });
});

describe('resolveAudience', () => {
  const base = 'https://logfire.test';

  it('uses an explicit audience verbatim for both', () => {
    expect(
      resolveAudience({
        audienceInput: 'https://aud/x',
        organization: '',
        project: '',
        resolvedUrl: base,
      }),
    ).toEqual({ oidcAudience: 'https://aud/x', exchangeAudience: 'https://aud/x' });
  });

  it('builds an org-only audience path', () => {
    expect(
      resolveAudience({ audienceInput: '', organization: 'acme', project: '', resolvedUrl: base }),
    ).toEqual({ oidcAudience: `${base}/acme`, exchangeAudience: `${base}/acme` });
  });

  it('builds an org/project audience path', () => {
    expect(
      resolveAudience({
        audienceInput: '',
        organization: 'acme',
        project: 'app',
        resolvedUrl: base,
      }),
    ).toEqual({ oidcAudience: `${base}/acme/app`, exchangeAudience: `${base}/acme/app` });
  });

  it('rejects audience combined with organization', () => {
    expect(() =>
      resolveAudience({
        audienceInput: 'https://aud',
        organization: 'acme',
        project: '',
        resolvedUrl: base,
      }),
    ).toThrow(/cannot be combined/);
  });

  it('rejects audience combined with project', () => {
    expect(() =>
      resolveAudience({
        audienceInput: 'https://aud',
        organization: '',
        project: 'app',
        resolvedUrl: base,
      }),
    ).toThrow(/cannot be combined/);
  });

  it('requires organization when no audience is given', () => {
    expect(() =>
      resolveAudience({ audienceInput: '', organization: '', project: '', resolvedUrl: base }),
    ).toThrow(/organization/);
  });
});

describe('parseScopes', () => {
  it('returns empty for empty input', () => {
    expect(parseScopes('')).toBe('');
    expect(parseScopes('   ')).toBe('');
  });

  it('collapses arbitrary whitespace to single spaces', () => {
    expect(parseScopes('project:write_otlp   project:read_otlp\nproject:read')).toBe(
      'project:write_otlp project:read_otlp project:read',
    );
  });
});

describe('readHttpOpts', () => {
  let envBackup: NodeJS.ProcessEnv;
  beforeEach(() => {
    envBackup = { ...process.env };
    for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_')) delete process.env[k];
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
    Object.assign(process.env, envBackup);
  });

  it('defaults to undefined options when nothing is set', () => {
    const opts = readHttpOpts();
    expect(opts.maxRetries).toBeUndefined();
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.proxy).toBeUndefined();
  });

  it('parses numeric inputs and proxy', () => {
    process.env.INPUT_MAX_RETRIES = '5';
    process.env.INPUT_REQUEST_TIMEOUT = '20';
    process.env.INPUT_PROXY = 'http://proxy:8080';
    const opts = readHttpOpts();
    expect(opts.maxRetries).toBe(5);
    expect(opts.timeoutMs).toBe(20000);
    expect(opts.proxy).toBe('http://proxy:8080');
  });

  it('clamps a negative retry count to zero', () => {
    process.env.INPUT_MAX_RETRIES = '-3';
    expect(readHttpOpts().maxRetries).toBe(0);
  });
});

describe('run() — full OIDC → exchange flow', () => {
  let envBackup: NodeJS.ProcessEnv;
  let tmpDir: string;
  let outputFile: string;
  let stateFile: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    envBackup = { ...process.env };
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'logfire-run-'));
    outputFile = join(tmpDir, 'output');
    stateFile = join(tmpDir, 'state');

    // Clear any INPUT_*/GITHUB_*/ACTIONS_* the host environment may carry.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('INPUT_') || k.startsWith('STATE_')) delete process.env[k];
    }
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_STATE = stateFile;
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.GITHUB_JOB = 'test';
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.test/token?api-version=2.0';
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'request-token';

    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });

    nock.disableNetConnect();
  });

  afterEach(() => {
    logSpy.mockRestore();
    nock.cleanAll();
    nock.enableNetConnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in envBackup)) delete process.env[k];
    }
    Object.assign(process.env, envBackup);
  });

  function readKv(file: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  it('mints a token, writes outputs/state, and masks secrets', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_PROJECT = 'app';
    process.env.INPUT_URL = 'https://logfire.test';
    process.env.INPUT_SCOPES = 'project:write_otlp   project:read_otlp';

    const oidc = nock('https://oidc.test')
      .get('/token')
      .query(true)
      .matchHeader('authorization', 'bearer request-token')
      .reply(200, { value: 'header.payload.signature' });

    let exchangeBody: Record<string, string> = {};
    const exchange = nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(200, (_uri, body) => {
        exchangeBody = parseForm(body);
        return { access_token: 'WORKLOAD-TOKEN', expires_in: 600, scope: 'project:write_otlp' };
      });

    await run();

    expect(oidc.isDone()).toBe(true);
    expect(exchange.isDone()).toBe(true);

    // Exchange request carried the derived audience and normalized scopes.
    expect(exchangeBody?.grant_type).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(exchangeBody?.audience).toBe('https://logfire.test/acme/app');
    expect(exchangeBody?.scope).toBe('project:write_otlp project:read_otlp');
    expect(exchangeBody?.subject_token).toBe('header.payload.signature');

    const outputs = readKv(outputFile);
    expect(outputs.token).toBe('WORKLOAD-TOKEN');
    expect(outputs['expires-in']).toBe('600');
    expect(outputs.scopes).toBe('project:write_otlp');
    expect(outputs['logfire-url']).toBe('https://logfire.test');
    expect(outputs['trace-id']).toBe(computeTraceId('100', '1'));
    expect(outputs.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const state = readKv(stateFile);
    expect(state.access_token).toBe('WORKLOAD-TOKEN');
    expect(state.logfire_url).toBe('https://logfire.test');
    expect(state.skip_cleanup).toBe('');

    // Both the subject token and the workload token are masked.
    expect(logs).toContain('::add-mask::header.payload.signature');
    expect(logs).toContain('::add-mask::WORKLOAD-TOKEN');
  });

  it('persists skip_cleanup when requested', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';
    process.env.INPUT_SKIP_CLEANUP = 'true';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(200, { access_token: 'T', expires_in: 600 });

    await run();

    expect(readKv(stateFile).skip_cleanup).toBe('true');
  });

  it('retries a transient OIDC failure (exercises the retry callback)', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    nock('https://oidc.test').get('/token').query(true).reply(503, 'busy');
    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(200, { access_token: 'T', expires_in: 600 });

    await run();

    expect(logs.some((l) => l.startsWith('::debug::Retry 1/'))).toBe(true);
  });

  it('falls back to default run context when env vars are absent', async () => {
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    delete process.env.GITHUB_JOB;
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';
    process.env.INPUT_JOB_ID = 'custom-job';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(200, { access_token: 'T', expires_in: 600 });

    await run();

    // runId '' and runAttempt default '1'.
    expect(readKv(outputFile)['trace-id']).toBe(computeTraceId('', '1'));
  });

  it('derives an empty job id when neither job-id nor GITHUB_JOB is set', async () => {
    delete process.env.GITHUB_JOB;
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(200, { access_token: 'T', expires_in: 600 });

    await run();

    const span = computeJobSpanId('100', '1', '');
    expect(readKv(outputFile).traceparent).toContain(`-${span}-`);
  });

  it('uses the exchange error code when no description is present', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test').post('/api/oauth/token').reply(400, { error: 'invalid_target' });

    await expect(run()).rejects.toThrow(/Token exchange failed \(HTTP 400\): invalid_target/);
  });

  it('falls back to the raw body when the error JSON has no error fields', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test').post('/api/oauth/token').reply(400, { unexpected: true });

    await expect(run()).rejects.toThrow(
      /Token exchange failed \(HTTP 400\): \{"unexpected":true\}/,
    );
  });

  it('throws when the exchange rejects with a 4xx policy error', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';
    process.env.INPUT_SCOPES = 'project:admin';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test')
      .post('/api/oauth/token')
      .reply(400, { error: 'invalid_scope', error_description: 'scope outside trust policy' });

    await expect(run()).rejects.toThrow(/Token exchange failed.*scope outside trust policy/);
  });

  it('throws when the OIDC provider returns an error status', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    // 401 is not retryable, so this fails immediately.
    nock('https://oidc.test').get('/token').query(true).reply(401, 'unauthorized');

    await expect(run()).rejects.toThrow(/Failed to get GitHub OIDC token \(HTTP 401\)/);
  });

  it('surfaces a non-JSON exchange error body verbatim', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';

    nock('https://oidc.test').get('/token').query(true).reply(200, { value: 'a.b.c' });
    nock('https://logfire.test').post('/api/oauth/token').reply(400, 'plain text failure');

    await expect(run()).rejects.toThrow(/Token exchange failed \(HTTP 400\): plain text failure/);
  });

  it('throws when GitHub OIDC is unavailable', async () => {
    process.env.INPUT_ORGANIZATION = 'acme';
    process.env.INPUT_URL = 'https://logfire.test';
    delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;

    await expect(run()).rejects.toThrow(/GitHub OIDC not available/);
  });

  it('throws when organization and audience are absent', async () => {
    process.env.INPUT_URL = 'https://logfire.test';
    await expect(run()).rejects.toThrow(/organization/);
  });
});
