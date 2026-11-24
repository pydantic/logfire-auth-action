/**
 * Minimal GitHub Actions toolkit shims — just the bits this action needs,
 * without depending on `@actions/core`. Reads/writes the same environment
 * files and workflow commands the toolkit uses.
 */

import * as fs from 'node:fs';

/** Read a `with:` input (mirrors `core.getInput`, including the dash→underscore rule). */
export function getInput(name: string): string {
  const val = process.env[`INPUT_${name.replace(/-/g, '_').toUpperCase()}`] || '';
  return val.trim();
}

/** Read saved post-step state (mirrors `core.getState`). */
export function getState(name: string): string {
  return (process.env[`STATE_${name}`] || '').trim();
}

/** Set a step output via the `GITHUB_OUTPUT` file. */
export function setOutput(name: string, value: string): void {
  const filePath = process.env.GITHUB_OUTPUT;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

/** Persist state for the post step via the `GITHUB_STATE` file. */
export function saveState(name: string, value: string): void {
  const filePath = process.env.GITHUB_STATE;
  if (filePath) {
    fs.appendFileSync(filePath, `${name}=${value}\n`);
  }
}

/**
 * Write a workflow command. The runner decodes `%25`, `%0D` and `%0A` in the
 * data, so the data is encoded the same way as `@actions/core` does it.
 */
function issueCommand(command: string, data: string): void {
  const escaped = data.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${command}::${escaped}`);
}

/** Register a value to be masked in the logs. */
export function setSecret(value: string): void {
  if (value) {
    issueCommand('add-mask', value);
  }
}

/** Mark the step failed (logs an error and sets a non-zero exit code). */
export function setFailed(message: string): void {
  issueCommand('error', message);
  process.exitCode = 1;
}

export function warning(message: string): void {
  issueCommand('warning', message);
}

export function debug(message: string): void {
  issueCommand('debug', message);
}

export function info(message: string): void {
  console.log(message);
}
