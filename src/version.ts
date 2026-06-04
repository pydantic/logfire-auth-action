/**
 * User-Agent identifying this action on every request to Logfire, so
 * server-side telemetry can attribute traffic to the action and its version.
 *
 * Name and version come from package.json — the same source of truth the
 * release script tags from — so the header stays in sync automatically. esbuild
 * inlines these values at bundle time; no package.json ships in `dist/`.
 */

import { name, version } from '../package.json';

// Strip the npm scope: "@pydantic/logfire-auth-action" -> "logfire-auth-action".
const shortName = name.replace(/^@[^/]+\//, '');

export const USER_AGENT = `${shortName}/${version}`;
