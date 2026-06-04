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

/** Register a value to be masked in the logs. */
export function setSecret(value: string): void {
  if (value) {
    console.log(`::add-mask::${value}`);
  }
}

/** Mark the step failed (logs an error and sets a non-zero exit code). */
export function setFailed(message: string): void {
  console.log(`::error::${message}`);
  process.exitCode = 1;
}

export function warning(message: string): void {
  console.log(`::warning::${message}`);
}

export function debug(message: string): void {
  console.log(`::debug::${message}`);
}

export function info(message: string): void {
  console.log(message);
}
