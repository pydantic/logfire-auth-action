/**
 * Authenticate to Logfire — main logic.
 *
 * Authenticates GitHub Actions with Logfire via RFC 8693 token exchange:
 * 1. Resolves the Logfire API URL from region/url inputs
 * 2. Computes a deterministic traceparent from the run context
 * 3. Fetches a GitHub OIDC JWT
 * 4. Exchanges it for a short-lived Logfire workload token
 *    (`POST /api/oauth/token`). The trust policy decides which scopes the
 *    issued token carries and therefore which Logfire surfaces it can reach.
 * 5. Saves state for the post-action revocation step
 *
 * `run()` throws on failure; the entry shim turns that into `setFailed`.
 */

import * as crypto from 'node:crypto';
import { requestWithRetry, type RequestOpts } from './http-client';
import { getInput, setOutput, saveState, setSecret, debug, info } from './actions';
import { USER_AGENT } from './version';

// --- RFC 8693 token exchange ---

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
}

interface ExchangeParams {
  subjectToken: string;
  audience: string;
  scope: string;
}

export async function exchangeToken(
  tokenUrl: string,
  { subjectToken, audience, scope }: ExchangeParams,
  httpOpts: RequestOpts,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subjectToken,
    subject_token_type: JWT_TOKEN_TYPE,
    audience,
  });
  if (scope) {
    params.set('scope', scope);
  }
  const formBody = params.toString();

  const response = await requestWithRetry(
    tokenUrl,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    },
    formBody,
    httpOpts,
  );

  if (response.statusCode !== 200) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body) as { error_description?: string; error?: string };
      detail = parsed.error_description || parsed.error || detail;
    } catch {
      /* use raw body */
    }
    throw new Error(`Token exchange failed (HTTP ${response.statusCode}): ${detail}`);
  }

  return JSON.parse(response.body) as TokenResponse;
}

// --- GitHub OIDC token fetching ---

export async function getIDToken(audience: string, httpOpts: RequestOpts): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      'GitHub OIDC not available. Ensure the job has "permissions: id-token: write" ' +
        'and the workflow uses a supported event trigger.',
    );
  }

  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const response = await requestWithRetry(
    url,
    {
      method: 'GET',
      headers: {
        Authorization: `bearer ${requestToken}`,
        Accept: 'application/json',
      },
    },
    undefined,
    httpOpts,
  );

  if (response.statusCode !== 200) {
    throw new Error(
      `Failed to get GitHub OIDC token (HTTP ${response.statusCode}): ${response.body}`,
    );
  }

  return (JSON.parse(response.body) as { value: string }).value;
}

// --- Traceparent computation ---

function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function computeTraceId(runId: string, runAttempt: string): string {
  return sha256hex(`logfire:github:trace:${runId}:${runAttempt}`).substring(0, 32);
}

export function computeJobSpanId(runId: string, runAttempt: string, jobName: string): string {
  return sha256hex(`logfire:github:job:${runId}:${runAttempt}:${jobName}`).substring(0, 16);
}

// --- URL resolution ---

const REGION_URLS: Record<string, string> = {
  us: 'https://logfire-us.pydantic.dev',
  eu: 'https://logfire-eu.pydantic.dev',
  'staging-eu': 'https://logfire-eu.pydantic.info',
};

export function resolveUrl(region: string, url: string): string {
  if (url) return url;
  if (region) {
    const resolved = REGION_URLS[region];
    if (!resolved) {
      throw new Error(
        `Unknown region '${region}'. Use: us, eu, staging-eu, or provide a custom url.`,
      );
    }
    return resolved;
  }
  return REGION_URLS.us!;
}

// --- Audience resolution ---

export interface AudienceInputs {
  audienceInput: string;
  organization: string;
  project: string;
  resolvedUrl: string;
}

export interface ResolvedAudience {
  /** `aud` claim requested for the GitHub OIDC JWT. */
  oidcAudience: string;
  /** RFC 8693 `audience` form parameter sent to the exchange. */
  exchangeAudience: string;
}

/**
 * The OIDC JWT `aud` claim and the RFC 8693 exchange audience are always set to
 * the same value — the backend's audience check requires them to match. Two
 * mutually-exclusive modes:
 *   - Explicit `audience`: used verbatim. It must already encode whatever
 *     org/project path the backend expects, so `organization`/`project` are
 *     rejected to avoid an ambiguous double-encoding.
 *   - Otherwise: built from `organization` (+ optional `project`) as a path
 *     under the resolved Logfire URL, which the backend parses to route.
 */
export function resolveAudience({
  audienceInput,
  organization,
  project,
  resolvedUrl,
}: AudienceInputs): ResolvedAudience {
  if (audienceInput && (organization || project)) {
    throw new Error(
      'Input "audience" cannot be combined with "organization" or "project". ' +
        'Provide a full audience that already encodes the org/project path, or ' +
        'omit "audience" and pass "organization" (+ optional "project") instead.',
    );
  }

  if (audienceInput) {
    return { oidcAudience: audienceInput, exchangeAudience: audienceInput };
  }

  if (!organization) {
    throw new Error('Input "organization" is required (unless a full "audience" is provided)');
  }
  const exchangeAudience = project
    ? `${resolvedUrl}/${organization}/${project}`
    : `${resolvedUrl}/${organization}`;
  return { oidcAudience: exchangeAudience, exchangeAudience };
}

// --- Scope parsing ---

/**
 * Scopes are space-separated, per the OAuth / RFC 8693 convention. Collapse any
 * whitespace (newlines, double spaces) the input may carry into single
 * separators. Validity is enforced by the exchange endpoint against the policy.
 */
export function parseScopes(scopesInput: string): string {
  return scopesInput ? scopesInput.split(/\s+/).filter(Boolean).join(' ') : '';
}

// --- HTTP options from inputs ---

export function readHttpOpts(): RequestOpts {
  const maxRetriesInput = parseInt(getInput('max-retries'), 10);
  const timeoutInput = parseInt(getInput('request-timeout'), 10);
  return {
    maxRetries: Number.isNaN(maxRetriesInput) ? undefined : Math.max(0, maxRetriesInput),
    timeoutMs: Number.isNaN(timeoutInput) ? undefined : Math.max(1, timeoutInput) * 1000,
    proxy: getInput('proxy') || undefined,
    onRetry: (r) => debug(`Retry ${r.attempt}/${r.maxRetries} in ${r.delayMs}ms (${r.reason})`),
  };
}

// --- Orchestration ---

export async function run(): Promise<void> {
  // 1. Resolve URL
  const region = getInput('region');
  const url = getInput('url');
  const resolvedUrl = resolveUrl(region, url);

  setOutput('logfire-url', resolvedUrl);
  debug(`Resolved Logfire URL: ${resolvedUrl}`);

  const httpOpts = readHttpOpts();

  // 2. Compute traceparent. For matrix jobs, GITHUB_JOB collapses across matrix
  //    entries — incorporate `job-id` so each combination gets a unique span id.
  const runId = process.env.GITHUB_RUN_ID || '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  const jobId = getInput('job-id') || process.env.GITHUB_JOB || '';

  const traceId = computeTraceId(runId, runAttempt);
  const jobSpanId = computeJobSpanId(runId, runAttempt, jobId);
  const traceparent = `00-${traceId}-${jobSpanId}-01`;

  setOutput('traceparent', traceparent);
  setOutput('trace-id', traceId);
  debug(`Traceparent: ${traceparent}`);

  // 3. Resolve the audience.
  const { oidcAudience, exchangeAudience } = resolveAudience({
    audienceInput: getInput('audience'),
    organization: getInput('organization'),
    project: getInput('project'),
    resolvedUrl,
  });

  // 4. Fetch the GitHub OIDC JWT
  const subjectToken = await getIDToken(oidcAudience, httpOpts);
  setSecret(subjectToken);

  const scope = parseScopes(getInput('scopes'));

  // 5. Exchange the OIDC JWT for a Logfire workload token. If the trust policy
  //    rejects the request (claims don't match, requested scope outside the
  //    policy, etc.) the exchange returns an RFC 6749 §5.2 error envelope and
  //    this throws, failing the step.
  const result = await exchangeToken(
    `${resolvedUrl}/api/oauth/token`,
    { subjectToken, audience: exchangeAudience, scope },
    httpOpts,
  );

  const accessToken = result.access_token;
  const expiresIn = result.expires_in;
  const grantedScopes = result.scope || '';

  setSecret(accessToken);

  setOutput('token', accessToken);
  setOutput('expires-in', String(expiresIn));
  setOutput('scopes', grantedScopes);

  // 6. Save state for the post-action revocation step. `skip-cleanup` is
  //    persisted here (rather than read in the post step) because input env
  //    vars aren't guaranteed in the post context.
  const skipCleanup = getInput('skip-cleanup').toLowerCase() === 'true';
  saveState('access_token', accessToken);
  saveState('logfire_url', resolvedUrl);
  saveState('skip_cleanup', skipCleanup ? 'true' : '');

  info(
    `Logfire OIDC authentication successful (expires in ${expiresIn}s, scopes: ${grantedScopes})`,
  );
}
