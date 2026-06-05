# Authenticate to Logfire

Authenticate GitHub Actions with [Logfire](https://logfire.pydantic.dev) via OpenID Connect (OIDC). No stored secrets needed — GitHub's short-lived JWT is exchanged for a single short-lived Logfire workload token (RFC 8693). The token's scopes are pinned by the trust policy you configure once in Logfire, so what CI can do is auditable from the Logfire UI rather than from what was passed to `with:`.

The workload token is automatically revoked when the job completes via a built-in post step.

## Quick Start

```yaml
permissions:
  id-token: write # Required for OIDC

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: logfire
        uses: pydantic/logfire-auth-action@v1
        with:
          organization: myorg
          project: myapp

      - uses: actions/checkout@v4
      - run: pip install -e ".[test]"
      - run: pytest --logfire
        env:
          LOGFIRE_TOKEN: ${{ steps.logfire.outputs.token }}
          LOGFIRE_BASE_URL: ${{ steps.logfire.outputs.logfire_url }}
          TRACEPARENT: ${{ steps.logfire.outputs.traceparent }}
```

Pass the action's outputs into the steps that need them — the action itself doesn't mutate the job environment, so the same token can be wired to the SDK, the Logfire API, or the gateway proxy as needed.

## How it works

1. The action calls GitHub's OIDC provider to mint a JWT bound to this workflow run. The JWT's `aud` claim is the resolved Logfire URL (or your explicit `audience`).
2. It exchanges that JWT against Logfire's RFC 8693 token endpoint at `POST /api/oauth/token`. The exchange audience is `{resolvedUrl}/{organization}[/{project}]` so the backend can route to the right org / project — or, if you set `audience` explicitly, that value verbatim.
3. The backend matches the JWT claims against an active trust policy in the org, mints a workload JWT (`subject_type=workload`) carrying the policy's scopes, and returns it on `outputs.token`.
4. The trust policy decides which Logfire surfaces the issued token can reach. Whatever the resource server (API, OTLP intake, gateway proxy, …) requires — scope, project binding, audience — is enforced when the token is actually used, not preemptively by the action.
5. On job completion the post step calls `POST /api/oauth/revoke` (RFC 7009) so the token is invalidated immediately rather than waiting for `exp`.

## Inputs

| Input             | Required | Default               | Description                                                                                                                                                                        |
| ----------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organization`    | Yes¹     | —                     | Logfire organization slug. Mutually exclusive with `audience`                                                                                                                      |
| `project`         | No       | —                     | Logfire project slug. Narrows the issued token to a single project (when the policy is org-wide), or pins to the policy's project (when bound). Mutually exclusive with `audience` |
| `scopes`          | No       | Trust policy default  | Space-separated subset of the trust policy's scopes (e.g. `project:write_otlp project:read_otlp`)                                                                                  |
| `region`          | No       | `us`                  | Region preset: `us`, `eu`, `staging-eu`                                                                                                                                            |
| `url`             | No       | —                     | Custom Logfire API URL (overrides `region`)                                                                                                                                        |
| `audience`        | No       | resolved Logfire URL² | Full audience, used verbatim. Mutually exclusive with `organization`/`project`                                                                                                     |
| `job-id`          | No       | `github.job`          | Unique job ID for traceparent (use with matrix)                                                                                                                                    |
| `skip-cleanup`    | No       | `false`               | When `true`, skip post-job token revocation and let the token expire naturally                                                                                                     |
| `max-retries`     | No       | `3`                   | Retry attempts for transient HTTP failures (network/timeout/408/429/5xx). `0` disables                                                                                             |
| `request-timeout` | No       | `10`                  | Per-request socket timeout, in seconds                                                                                                                                             |
| `proxy`           | No       | env                   | Proxy URL; falls back to `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` env vars                                                                                                            |

¹ Required unless you provide a full `audience` that already encodes the org/project path.
² When `audience` is omitted, the GitHub OIDC JWT `aud` claim defaults to the resolved Logfire URL and the exchange audience is built as `{resolvedUrl}/{organization}[/{project}]`. When `audience` is provided it is used verbatim for both — `organization`/`project` must then be omitted.

Token TTL is fixed by the trust policy (`token_ttl_seconds`). The action cannot extend it.

## Outputs

| Output        | Description                                     |
| ------------- | ----------------------------------------------- |
| `token`       | Short-lived Logfire workload JWT                |
| `traceparent` | W3C traceparent header value                    |
| `trace_id`    | Deterministic trace ID for this workflow run    |
| `expires_in`  | Token TTL in seconds (set by the trust policy)  |
| `scopes`      | Granted scopes (may be narrower than requested) |
| `logfire_url` | Resolved Logfire API URL                        |

The dash-separated aliases `trace-id`, `expires-in`, and `logfire-url` are
deprecated and will be removed in v2; prefer the underscore names above.

## Configuration Examples

### Logfire Cloud (US — default)

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
```

### Logfire Cloud (EU)

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
    region: eu
```

### Self-Hosted Logfire

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
    url: https://logfire.internal.company.com
```

When `audience` is omitted, the GitHub OIDC JWT's `aud` claim defaults to `url` (the resolved Logfire URL), which is what your self-hosted backend validates against (`GITHUB_OIDC_AUDIENCE`). Set those equal and you don't need `audience` at all.

If your backend expects a different `aud` value (or a fully custom exchange audience), provide `audience` explicitly — but then it is used **verbatim** and must already encode the org/project path, so `organization`/`project` must be omitted:

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    url: https://logfire.internal.company.com
    audience: https://logfire.internal.company.com/myorg/myapp
```

### Narrowing scopes per workflow

The trust policy defines the upper bound. A workflow that only needs a subset can request just that:

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
    scopes: project:write_otlp
```

If the policy doesn't grant the requested scope, the exchange returns `invalid_scope` and the step fails.

### Downscoping an org-wide trust policy to a single project

A platform team often wants **one** trust policy that admits the whole org's CI — checked into IaC, audited once — and lets individual workflows narrow the issued token to a single project at runtime. To do this:

1. Create the trust policy in Logfire **without binding it to a project** (Settings → OIDC Trust Policies → leave "Project" empty). The policy is then valid for every project in the org.
2. In each workflow, pass the target project via the action's `project` input.

```yaml
# Workflow A — narrowed to `frontend`
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: frontend
    scopes: project:write_otlp
```

```yaml
# Workflow B — same org, same trust policy, different project
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: backend
    scopes: project:write_otlp
```

Under the hood the action sends the audience as `{audience}/{organization}/{project}`, and the backend pins the issued workload JWT to that one project. The token issued for `frontend` is rejected (HTTP 403) the moment it's used against any other project in the org — even though the trust policy itself remains org-wide.

Important boundaries:

- **Downscope only.** If the trust policy is _already_ bound to a project, passing a different project here is rejected (`invalid_target`). You can pass the same project as a no-op or omit it.
- **Org-wide token.** Omitting the `project` input against an org-wide policy keeps the issued token org-wide — useful for org-spanning workflows, but consider whether a project-scoped token would be a tighter fit. Resource servers that require a project binding (e.g. the OTLP intake) will reject org-wide tokens.
- **The project must exist in the same org.** A typo in the slug surfaces as `invalid_target` at exchange time rather than as a confusing scope error later.

### Gateway proxy

If the trust policy grants `project:gateway_proxy`, the same workload token authenticates LLM calls through `<logfire>/proxy/<provider>/...` — no per-provider API key needed in CI.

```yaml
- id: logfire
  uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
    scopes: project:gateway_proxy

- run: |
    curl -sf "${{ steps.logfire.outputs.logfire_url }}/proxy/openai/v1/chat/completions" \
      -H "Authorization: Bearer ${{ steps.logfire.outputs.token }}" \
      -H 'Content-Type: application/json' \
      -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "ping"}]}'
```

To run several Logfire surfaces from the same workflow, grant all the needed scopes on the trust policy and wire the same `outputs.token` to each step.

## Matrix Workflows

`GITHUB_JOB` collapses across matrix entries. Pass the matrix context via `job-id` for unique span IDs per combination:

```yaml
jobs:
  test:
    strategy:
      matrix:
        python: ['3.11', '3.12', '3.13']
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - id: logfire
        uses: pydantic/logfire-auth-action@v1
        with:
          organization: myorg
          project: myapp
          job-id: ${{ github.job }}-${{ toJson(matrix) }}

      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: ${{ matrix.python }}
      - run: pip install -e ".[test]"
      - run: pytest --logfire
        env:
          LOGFIRE_TOKEN: ${{ steps.logfire.outputs.token }}
          LOGFIRE_BASE_URL: ${{ steps.logfire.outputs.logfire_url }}
          TRACEPARENT: ${{ steps.logfire.outputs.traceparent }}
```

Each matrix combination shows up as a distinct job span in the Logfire trace.

## Distributed Tracing

The action computes deterministic trace/span IDs from the GitHub run context:

```
trace_id = SHA-256("logfire:github:trace:{run_id}:{run_attempt}")[0:32]
job_span = SHA-256("logfire:github:job:{run_id}:{run_attempt}:{job_id}")[0:16]
```

Wiring `outputs.traceparent` into the consuming step's environment as `TRACEPARENT` lets webhook spans (`workflow_run`, `workflow_job`) and SDK spans share the same trace, propagates the parent to every subsequent SDK call, and gives you cross-job correlation within a workflow run.

## Reliability & Networking

Both the GitHub OIDC request and the Logfire token exchange (and the post-job revocation) go through a small built-in HTTP client with:

- **Per-request timeout** (`request-timeout`, default 10s) — a stalled connection is aborted rather than hanging until the job-level timeout.
- **Retry with jittered exponential backoff** (`max-retries`, default 3) on transient failures: network errors, request timeouts, and HTTP `408`/`429`/`5xx`. A `4xx` policy rejection (e.g. `invalid_scope`, `invalid_target`) is **not** retried — it fails fast. Set `max-retries: 0` to disable.
- **Proxy support** — set `proxy` explicitly, or rely on the standard `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY` environment variables (Node's `https` ignores these by default). HTTPS targets are reached via a `CONNECT` tunnel.

```yaml
- uses: pydantic/logfire-auth-action@v1
  with:
    organization: myorg
    project: myapp
    max-retries: 5
    request-timeout: 20
    proxy: http://proxy.internal:8080
```

## Prerequisites

1. An **OIDC trust policy** configured in your Logfire organization (Settings → OIDC Trust Policies). The policy decides which repos/refs/environments may exchange a token and what scopes the issued token carries — see [Configuring a Trust Policy](#configuring-a-trust-policy) below.
2. **`id-token: write`** permission in the workflow.

## Configuring a Trust Policy

A trust policy is a set of **GitHub OIDC JWT claims that must match** for an exchange to succeed, plus the **scopes** and **TTL** of the token that gets issued. You configure it once in Logfire (Settings → OIDC Trust Policies, organization-level).

### 1. Extract the claim values with `gh`

The trust policy should pin at least one **immutable** anchor — `repository_owner_id` and/or `repository_id` — because numeric IDs survive repo/owner renames while `repository`/`repository_owner` strings do not. Pull them with the GitHub CLI:

```bash
# Ready-to-paste claims object for one repository (IDs as strings, the format the policy stores)
gh api repos/OWNER/REPO --jq '{
  iss: "https://token.actions.githubusercontent.com",
  repository: .full_name,
  repository_id: (.id | tostring),
  repository_owner: .owner.login,
  repository_owner_id: (.owner.id | tostring)
}'
```

```bash
# Just the owner (org/user) — for an org-wide policy that admits every repo under it
gh api users/OWNER --jq '{repository_owner: .login, repository_owner_id: (.id | tostring)}'
```

`ref`, `environment`, `event_name`, `actor`, `workflow`, etc. aren't derivable from the REST API — they depend on how the workflow runs. The **ground truth** for every claim is the token itself. Add a throwaway debug job and read the decoded payload from the run logs:

```yaml
jobs:
  debug-oidc-claims:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - name: Print this workflow's GitHub OIDC claims
        run: |
          TOKEN=$(curl -sf \
            -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=logfire" | jq -r '.value')
          # Decode the JWT payload (base64url, no padding) — print every claim
          python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))), indent=2, sort_keys=True))' "$TOKEN"
```

Copy the exact `repository`, `ref`, `environment`, … values from that output into your policy. (Use a disposable `audience` like `logfire` here — you're only inspecting claims, not exchanging.)

### 2. Create the policy in Logfire

In **Settings → OIDC Trust Policies → New policy**:

| Field                  | What to set                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Name**               | Anything memorable (1–128 chars), e.g. `ci-main-otlp`                                                                     |
| **Provider**           | `GitHub` — this auto-pins `iss = https://token.actions.githubusercontent.com` for you                                     |
| **Project**            | Leave **empty** for an org-wide policy (narrow per-workflow with the action's `project` input), or bind it to one project |
| **Claims**             | The JSON object from step 1 — the claims that must match (see examples below)                                             |
| **Allowed algorithms** | Leave `RS256` (GitHub signs with RS256)                                                                                   |
| **Scopes**             | The subset of the [scope allowlist](#available-scopes) this CI may request                                                |
| **Token TTL**          | Seconds the issued token lives, `60`–`86400` (1 min – 24 h; default `3600` = 1 h)                                         |

Then **activate** it. (An active policy must have a non-empty claim set, and each distinct claim set must be unique within the org.)

**Claim-matching rules to know:**

- Keys are case-insensitive; values for `repository`, `repository_owner`, `ref`, `environment`, and `event_name` are compared **lowercased**.
- A policy must include an immutable anchor (`repository_owner_id` or `repository_id`).
- Tokens from `pull_request_target` events are **always rejected** (a fork-PR hardening measure).
- Only the claims you list are checked; anything you omit is unconstrained. Pin enough to scope it tightly.

#### Example claim sets

```jsonc
// Only main-branch builds of one repo
{
  "repository_id": "123456789",
  "ref": "refs/heads/main",
}
```

```jsonc
// Any workflow in the whole org (broad — pair with tight scopes)
{
  "repository_owner_id": "987654",
}
```

```jsonc
// Gated on a GitHub Environment (e.g. requires approval)
{
  "repository_id": "123456789",
  "environment": "production",
}
```

(`iss` is added automatically when you pick the `GitHub` provider, so you don't list it yourself.)

### Available scopes

A requested scope must be a subset of the policy's scopes. The workload-token allowlist:

`organization:read` · `organization:read_channel` · `organization:auditlog` · `project:read` · `project:write` · `project:read_token` · `project:write_token` · `project:read_dashboard` · `project:write_dashboard` · `project:read_alert` · `project:write_alert` · `project:read_datasets` · `project:write_datasets` · `project:read_variables` · `project:gateway_proxy` · `project:read_otlp` · `project:write_otlp`

For most CI telemetry you want `project:write_otlp` (send spans/metrics) and/or `project:read_otlp` (query). See [Narrowing scopes per workflow](#narrowing-scopes-per-workflow).

## Contributing

The Action is written in TypeScript and bundled to `dist/`. See [DEVELOPMENT.md](DEVELOPMENT.md) for the build, test, and release workflow.
