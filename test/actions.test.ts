import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFailed, setOutput, saveState, setSecret } from '../src/actions';

describe('actions toolkit shims', () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const prevExitCode = process.exitCode;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = prevExitCode;
    for (const k of Object.keys(process.env)) if (!(k in envBackup)) delete process.env[k];
    Object.assign(process.env, envBackup);
  });

  it('setFailed emits an error command and sets a non-zero exit code', () => {
    setFailed('boom');
    expect(logs).toContain('::error::boom');
    expect(process.exitCode).toBe(1);
  });

  it('setOutput is a no-op when GITHUB_OUTPUT is unset', () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => setOutput('k', 'v')).not.toThrow();
  });

  it('saveState is a no-op when GITHUB_STATE is unset', () => {
    delete process.env.GITHUB_STATE;
    expect(() => saveState('k', 'v')).not.toThrow();
  });

  it('setSecret ignores an empty value', () => {
    setSecret('');
    expect(logs).toEqual([]);
  });
});
