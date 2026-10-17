/** undefined on failure; a leading byte-order mark (some Windows tools write one) is ignored. */
export function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch { return undefined; }
}
/** JSON with comments and trailing commas (JSONC, used by several tools' config files); undefined on failure. */
export function parseJsonc(text: string | null | undefined): unknown {
  if (!text) return undefined;
  let out = '';
  for (let i = 0; i < text.length;) {                          // strings are copied as is; comments and trailing commas dropped
    const c = text[i];
    if (c === '"') { const str = /^"(?:[^"\\]|\\.)*"?/.exec(text.slice(i))![0]; out += str; i += str.length; }
    else if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e; }
    else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; }
    else if (c === ',' && /^,(?:\s|\/\/[^\n]*|\/\*(?:(?!\*\/)[\s\S])*\*\/)*[}\]]/.test(text.slice(i))) i++;
    else { out += c; i++; }
  }
  return parseJson(out);
}
export function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o != null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
export function firstNumber(obj: unknown, paths: string[] = []): number | undefined {
  for (const p of paths) { const v = pick(obj, p); if (typeof v === 'number') return v; }
  return undefined;
}
/** JSON from CLI output that may carry a banner or trailing log lines: first {…} or […] block. */
export function parseJsonLoose(text: string | null | undefined): unknown {
  const strict = parseJson(text);
  if (strict !== undefined || !text) return strict;
  const s = text.search(/[[{]/), e = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return s >= 0 && e > s ? parseJson(text.slice(s, e + 1)) : undefined;
}
