// The one list of secret patterns: used by the bus/logger redaction, the manifest loader and the CI secret scan.
export interface SecretRule { name: string; re: RegExp; scope: 'always' | 'repo' }   // 'repo' = only for the committed-files scan

export const SECRET_RULES: SecretRule[] = [
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, scope: 'always' },
  { name: 'uri-with-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, scope: 'always' },
  { name: 'generic-api-key', re: /\b(?:sk|rk|pk|npg|rnd)[-_][A-Za-z0-9_-]{20,}\b/, scope: 'always' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/, scope: 'always' },
  { name: 'private-lan-ip', re: /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, scope: 'repo' },
];
const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential)/i;

export function scanText(text: string, scope: 'always' | 'repo' = 'always'): string[] {
  return SECRET_RULES.filter(r => (scope === 'repo' || r.scope === 'always') && r.re.test(text)).map(r => r.name);
}

export function redact<T>(value: T): T {
  const walk = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return SECRET_KEY.test(key) || scanText(v).length ? '[redacted]' : v;
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value) as T;
}
