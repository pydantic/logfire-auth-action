/**
 * Authenticate to Logfire — post entry point (`runs.post`).
 *
 * Thin shim around ./post so the cleanup logic can be unit-tested in isolation.
 */

import { post } from './post';

void post();
