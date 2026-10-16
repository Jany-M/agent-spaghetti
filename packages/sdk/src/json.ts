export function parseJson(text: string | null | undefined): unknown {   // undefined on failure
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
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
