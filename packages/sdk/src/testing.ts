// The ONLY Environment test double in the repo. Fixtures (integrations/*/fixtures.json) are FakeSpec JSON.
import type { Environment, EnvKind, ExecResult, HttpResult, Inventory } from './types.ts';

export interface FakeSpec {
  id?: string; kind?: EnvKind; hosts?: string[];
  http?: Record<string, HttpResult | null>;   // "GET <url>" or "<url>" → response
  files?: Record<string, string>;             // path or glob pattern → content (glob() returns the key)
  bins?: Record<string, string>;              // name → resolved path
  exec?: Record<string, ExecResult>;          // "<cmd> <args joined by space>" → result
  lines?: Record<string, string[] | Error>;   // execLines ("<cmd> <args>") and httpLines ("<METHOD> <url>"): lines, or the error thrown at the end
  inventory?: Partial<Inventory>;
}
export const fakeInventory = (i: Partial<Inventory> = {}): Inventory =>
  ({ installed: [], processes: [], listening: [], env: {}, partial: [], ...i });

async function* replay(v: string[] | Error | undefined, key: string): AsyncIterable<string> {
  if (v === undefined) throw new Error(`no fake lines for ${key}`);
  if (v instanceof Error) throw v;
  yield* v;
}
export function fakeEnv(s: FakeSpec = {}): Environment & { calls: string[]; inputs: Record<string, string> } {
  const calls: string[] = [], inputs: Record<string, string> = {};   // inputs: stdin per exec key (last call wins)
  return {
    calls, inputs, id: s.id ?? 'windows', kind: s.kind ?? 'windows',
    async exec(cmd, args, o) { calls.push(['exec', cmd, ...args].join(' ')); if (o?.input !== undefined) inputs[[cmd, ...args].join(' ')] = String(o.input); return s.exec?.[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '', stderr: 'not found' }; },
    async http(req) { const m = req.method ?? 'GET'; calls.push(`${m} ${req.url}`); return s.http?.[`${m} ${req.url}`] ?? (m === 'GET' ? s.http?.[req.url] : undefined) ?? null; },
    execLines: (cmd, args, o) => { const k = [cmd, ...args].join(' '); calls.push(`lines ${k}`); if (o?.input !== undefined) inputs[k] = o.input; return replay(s.lines?.[k], k); },
    httpLines: req => { const k = `${req.method ?? 'GET'} ${req.url}`; calls.push(`lines ${k}`); if (req.body !== undefined) inputs[k] = req.body; return replay(s.lines?.[k], k); },
    async writeFile(p, c) { calls.push(`write ${p}`); (s.files ??= {})[p] = c; },
    async readFile(p) { return s.files?.[p] ?? null; },
    async which(b) { return s.bins?.[b] ?? null; },
    async glob(p) { return s.files && p in s.files ? p : null; },
    async hostCandidates() { return s.hosts ?? ['127.0.0.1']; },
    async inventory() { return fakeInventory(s.inventory); },
  };
}
