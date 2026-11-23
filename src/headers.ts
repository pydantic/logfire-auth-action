/**
 * Extra request headers from the `headers` input.
 *
 * An access proxy in front of a Logfire instance (for example Cloudflare
 * Access) can require its own credentials on every request. The action sends
 * these headers only to the Logfire token and revocation endpoints. It never
 * sends them to the GitHub OIDC endpoint.
 */

/** Headers that the action sets, that carry Logfire or proxy credentials, or that route the request. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'content-length',
  'content-type',
  'host',
  'proxy-authorization',
  'user-agent',
]);

/** An RFC 9110 field name (`token`). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Return true if `value` has a control character other than horizontal tab, which RFC 9110 forbids. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

/**
 * Parse one `Name: value` header per line. Blank lines are ignored.
 *
 * The errors name the line number and the header name, but never the value,
 * because a value is usually a secret.
 */
export function parseHeaders(input: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  const lines = input.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const where = `Input "headers", line ${index + 1}`;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new Error(`${where}: write the header as "Name: value"`);
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const key = name.toLowerCase();
    if (!HEADER_NAME.test(name)) {
      throw new Error(`${where}: "${name}" is not a valid HTTP header name`);
    }
    if (RESERVED_HEADERS.has(key)) {
      throw new Error(`${where}: "${name}" is reserved, so you cannot set it`);
    }
    if (seen.has(key)) {
      throw new Error(`${where}: "${name}" is set more than once`);
    }
    if (!value) {
      throw new Error(`${where}: "${name}" has an empty value`);
    }
    if (hasControlCharacter(value)) {
      throw new Error(`${where}: the value of "${name}" contains a control character`);
    }
    seen.add(key);
    headers[name] = value;
  }
  return headers;
}

/** Encode the headers for the post step. An empty set encodes as an empty string. */
export function encodeHeaders(headers: Record<string, string>): string {
  return Object.keys(headers).length ? JSON.stringify(headers) : '';
}

/** Decode the headers that `encodeHeaders` wrote. */
export function decodeHeaders(state: string): Record<string, string> {
  return state ? (JSON.parse(state) as Record<string, string>) : {};
}
