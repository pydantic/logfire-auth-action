# Development

This Action is written in **TypeScript** (`src/`) and bundled to self-contained JavaScript (`dist/`) that the GitHub Actions runner executes. There are no runtime npm dependencies — everything the Action needs is bundled into `dist/`.

## Prerequisites

- **Node.js 24** (see [`.node-version`](.node-version))
- **pnpm** (pinned via the `packageManager` field; `corepack enable` will provision the right version)

```bash
corepack enable
pnpm install
```

## Layout

| Path                 | Purpose                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `src/main.ts`        | `runs.main` entry shim — calls `run()`, maps errors to `setFailed`           |
| `src/cleanup.ts`     | `runs.post` entry shim — calls `post()`                                      |
| `src/run.ts`         | Main logic: OIDC fetch + RFC 8693 exchange, plus pure helpers                |
| `src/post.ts`        | Cleanup logic: RFC 7009 token revocation                                     |
| `src/http-client.ts` | Built-in HTTP client (timeout, retry/backoff, proxy/CONNECT)                 |
| `src/actions.ts`     | Minimal GitHub Actions toolkit shims (inputs, outputs, state, masking)       |
| `test/`              | Vitest suite (logic + nock-mocked HTTP flows)                                |
| `dist/`              | **Committed** bundle the runner executes (`dist/main.js`, `dist/cleanup.js`) |
| `action.yml`         | Action metadata; `runs.main`/`runs.post` point at `dist/`                    |

The entry shims (`main.ts`/`cleanup.ts`) are kept trivial so the logic in `run.ts`/`post.ts` can be imported and unit-tested without triggering a real run; they're excluded from coverage.

## Scripts

| Command                            | What it does                                   |
| ---------------------------------- | ---------------------------------------------- |
| `pnpm run build`                   | Typecheck, then bundle `src/` → `dist/`        |
| `pnpm run bundle`                  | Bundle only (esbuild, `--target=node24`)       |
| `pnpm run watch`                   | Rebuild `dist/` on change (esbuild watch mode) |
| `pnpm run typecheck`               | `tsc --noEmit`                                 |
| `pnpm run test`                    | Run the Vitest suite once                      |
| `pnpm run test:watch`              | Vitest in watch mode                           |
| `pnpm run coverage`                | Tests with V8 coverage                         |
| `pnpm run lint` / `lint:fix`       | ESLint (typescript-eslint)                     |
| `pnpm run format` / `format:check` | Prettier write / check                         |
| `pnpm run all`                     | lint → typecheck → test → bundle (mirrors CI)  |

## The `dist/` bundle

`dist/` is **committed to the repository** because GitHub runs the Action straight from the ref — there is no install step on the runner. Any change under `src/` must be rebuilt and the updated `dist/` committed in the same change:

```bash
pnpm run build
git add dist
```

CI enforces this: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs lint, format check, typecheck, tests, and a build on every push/PR, then rebuilds `dist/` and **fails if the committed output differs from a fresh build** (uploading the rebuilt `dist/` as an artifact on failure so you can inspect the diff).

If the "Check dist is current" step is red, run `pnpm run build` locally and commit the result.

## Testing notes

Tests live in `test/` and run with Vitest. Coverage is gated at **100%** (statements, branches, functions, lines) for everything under `src/` except the entry shims — `pnpm run coverage` (and CI) fails below that.

- `test/run.test.ts` — pure helpers (`resolveUrl`, traceparent, `resolveAudience`, `parseScopes`, `readHttpOpts`) plus the full `run()` flow with the GitHub OIDC and exchange endpoints mocked via [nock](https://github.com/nock/nock), asserting outputs/state files, secret masking, and the error paths.
- `test/post.test.ts` — the cleanup decision branches and revoke flows (2xx success, non-2xx warn, network-error-after-retries warn, skip flag) via nock.
- `test/actions.test.ts` — the `setFailed` workflow command.
- `test/http-client.test.ts` — spins up local servers (no outbound network) for proxy resolution / `NO_PROXY` matching, retry on `5xx`, no-retry on `4xx`, timeout throw/retry, plain-HTTP proxying, and HTTPS through an `http` `CONNECT` proxy (TLS-over-tunnel). The tunnel test targets an unresolvable host so it only passes if the request genuinely traverses the tunnel socket.

The CONNECT-tunnel suite generates a throwaway self-signed cert (`CN=localhost`, `localhost`/`127.0.0.1` SANs) into a temp dir via `openssl` at setup — no key material is committed — and verifies against it with `ca`/`servername` (real TLS verification, not disabled).

> The CONNECT-tunnel suite shells out to `openssl` (present on the dev machines and `ubuntu-latest`). If `openssl` isn't on `PATH`, that suite will fail; the rest of the suite has no such requirement.

## Releasing

See [RELEASING.md](RELEASING.md) for the tag/version process — including the one-time first release that creates the `v1` tag the README references.
