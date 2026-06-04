/**
 * Authenticate to Logfire — main entry point (`runs.main`).
 *
 * Thin shim: runs the action logic and converts a thrown error into a failed
 * step. The logic lives in ./run so it can be unit-tested in isolation.
 */

import { run } from './run';
import { setFailed } from './actions';

void run().catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : String(error));
});
