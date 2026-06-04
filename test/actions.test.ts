import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFailed } from '../src/actions';

describe('setFailed', () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  const prevExitCode = process.exitCode;

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(String(msg));
    });
  });
  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = prevExitCode;
  });

  it('emits an error command and sets a non-zero exit code', () => {
    setFailed('boom');
    expect(logs).toContain('::error::boom');
    expect(process.exitCode).toBe(1);
  });
});
