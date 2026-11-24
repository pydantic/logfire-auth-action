import { describe, it, expect } from 'vitest';
import { decodeHeaders, encodeHeaders, parseHeaders } from '../src/headers';

describe('parseHeaders', () => {
  it('returns no headers for an empty input', () => {
    expect(parseHeaders('')).toEqual({});
  });

  it('parses one header per line and skips blank lines', () => {
    const input = 'CF-Access-Client-Id: abc.access\r\n\n  CF-Access-Client-Secret:  s3cret  \n';
    expect(parseHeaders(input)).toEqual({
      'CF-Access-Client-Id': 'abc.access',
      'CF-Access-Client-Secret': 's3cret',
    });
  });

  it('keeps colons in the value', () => {
    expect(parseHeaders('X-Route: a:b:c')).toEqual({ 'X-Route': 'a:b:c' });
  });

  it('allows a tab in the value', () => {
    expect(parseHeaders('X-Tab: a\tb')).toEqual({ 'X-Tab': 'a\tb' });
  });

  it('rejects a line without a name, and does not show the line', () => {
    expect(() => parseHeaders('X-Ok: 1\nsecret-without-colon')).toThrow(
      'Input "headers", line 2: write the header as "Name: value"',
    );
    expect(() => parseHeaders(': value')).toThrow(/line 1: write the header/);
  });

  it('rejects an invalid header name', () => {
    expect(() => parseHeaders('Bad Name: x')).toThrow(/"Bad Name" is not a valid HTTP header name/);
  });

  it.each([
    'Authorization',
    'content-type',
    'Content-Length',
    'HOST',
    'Proxy-Authorization',
    'User-Agent',
  ])('rejects the reserved header %s', (name) => {
    expect(() => parseHeaders(`${name}: x`)).toThrow(/is reserved, so you cannot set it/);
  });

  it('rejects a header set twice, without regard to case', () => {
    expect(() => parseHeaders('X-A: 1\nx-a: 2')).toThrow(/line 2: "x-a" is set more than once/);
  });

  it('rejects an empty value', () => {
    expect(() => parseHeaders('X-Empty:   ')).toThrow(/"X-Empty" has an empty value/);
  });

  it('rejects a control character in the value, and does not show the value', () => {
    let message = '';
    try {
      parseHeaders('X-Bad: se\x00cret');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/the value of "X-Bad" contains a character that HTTP does not allow/);
    expect(message).not.toContain('cret');
  });

  it('rejects DEL in the value', () => {
    expect(() => parseHeaders('X-Bad: a\x7fb')).toThrow(
      /contains a character that HTTP does not allow/,
    );
  });

  it('accepts Latin-1 and rejects characters outside it, without showing the value', () => {
    expect(parseHeaders('X-Name: caf\u00e9')).toEqual({ 'X-Name': 'caf\u00e9' });
    expect(() => parseHeaders('X-Price: 5\u20ac-secret')).toThrow(
      /line 1: the value of "X-Price" contains a character that HTTP does not allow/,
    );
    expect(() => parseHeaders('X-Price: 5\u20ac-secret')).not.toThrow(/secret/);
  });
});

describe('encodeHeaders / decodeHeaders', () => {
  it('round-trips the headers', () => {
    const headers = { 'CF-Access-Client-Id': 'a', 'CF-Access-Client-Secret': 'b=c"d' };
    expect(decodeHeaders(encodeHeaders(headers))).toEqual(headers);
  });

  it('encodes no headers as an empty string, and decodes it back', () => {
    expect(encodeHeaders({})).toBe('');
    expect(decodeHeaders('')).toEqual({});
  });
});
