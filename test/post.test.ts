import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nock from 'nock';
import { post } from '../src/post';

/** nock hands the request body to the reply callback as a urlencoded string. */
function parseForm(body: unknown): Record<string, string> {
  if (typeof body === 'string') return Object.fromEntries(new URLSearchParams(body));
  if (body && typeof body === 'object') return body as Record<string, string>;
  return {};
}

describe('post() — token revocation cleanup', () => {
  let envBackup: NodeJS.ProcessEnv;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('STATE_')) delete process.env[k];
    }
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
    for (const k of Object.keys(process.env)) {
      if (!(k in envBackup)) delete process.env[k];
    }
    Object.assign(process.env, envBackup);
  });

  it('revokes the token and logs success', async () => {
    process.env.STATE_access_token = 'WORKLOAD-TOKEN';
    process.env.STATE_logfire_url = 'https://logfire.test';

    let revokeBody: Record<string, string> = {};
    const scope = nock('https://logfire.test')
      .post('/api/oauth/revoke')
      .reply(200, (_uri, body) => {
        revokeBody = parseForm(body);
        return '';
      });

    await post();

    expect(scope.isDone()).toBe(true);
    expect(revokeBody.token).toBe('WORKLOAD-TOKEN');
    expect(revokeBody.token_type_hint).toBe('access_token');
    expect(logs).toContain('::debug::Revoked workload token');
  });

  it('skips revocation when skip_cleanup is set (no network call)', async () => {
    process.env.STATE_access_token = 'WORKLOAD-TOKEN';
    process.env.STATE_logfire_url = 'https://logfire.test';
    process.env.STATE_skip_cleanup = 'true';

    // No interceptor registered — if post() made a request, nock would throw.
    await post();

    expect(logs.some((l) => l.includes('skip-cleanup is set'))).toBe(true);
  });

  it('no-ops when there is no token', async () => {
    await post();
    expect(logs).toContain('::debug::No token to revoke');
  });

  it('warns when the Logfire URL was not saved', async () => {
    process.env.STATE_access_token = 'WORKLOAD-TOKEN';
    await post();
    expect(logs.some((l) => l.includes('::warning::Cannot revoke token'))).toBe(true);
  });

  it('warns (without failing) when revocation returns a non-2xx', async () => {
    process.env.STATE_access_token = 'WORKLOAD-TOKEN';
    process.env.STATE_logfire_url = 'https://logfire.test';

    // 400 is not retryable, so this is a single call.
    nock('https://logfire.test').post('/api/oauth/revoke').reply(400, 'bad request');

    await post();

    expect(logs.some((l) => l.includes('::warning::Token revocation returned non-200'))).toBe(true);
  });

  it('warns (without failing) when revocation throws after retries', async () => {
    process.env.STATE_access_token = 'WORKLOAD-TOKEN';
    process.env.STATE_logfire_url = 'https://logfire.test';

    // Network error is retryable: initial attempt + 3 retries = 4 errors.
    nock('https://logfire.test')
      .post('/api/oauth/revoke')
      .times(4)
      .replyWithError('socket hang up');

    await post();

    expect(logs.some((l) => l.includes('::warning::Token revocation failed'))).toBe(true);
  }, 10000);
});
