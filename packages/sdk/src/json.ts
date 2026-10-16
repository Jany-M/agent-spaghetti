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
