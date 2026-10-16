// `agent-spaghetti test <integration>`: generic checks driven by the manifest, plus the module's own steps.
import type { Environment, Grant, Integration, TestResult, TestStep } from '@agent-spaghetti/sdk';
import { asSubject } from '../permissions.ts';
import { parseJson, pick } from '@agent-spaghetti/sdk';
import { inspectAs } from './observe.ts';

export async function testIntegration(host: Environment, i: Integration, grants: Grant[] = []): Promise<TestResult> {
  const steps: TestStep[] = [];
  const step = async (name: string, fn: () => Promise<[boolean, string]>) => {
    const t0 = Date.now();
    const [ok, detail] = await fn().catch((e: Error) => [false, e.message] as [boolean, string]);
    steps.push({ name, ok, detail, ms: Date.now() - t0 });
    return ok;
  };
  const m = i.manifest;
  const inventory = await host.inventory(m.detect?.env ?? []);
  const { env } = asSubject(i, host, { signal: AbortSignal.timeout(60000), inventory }, grants);
  const r = await inspectAs(i, host, inventory, grants);
  await step('detect', async () => [!!r, r ? `${r.detection.why}${r.detection.version ? ` (version ${r.detection.version})` : ''}` : 'not found in this environment']);
  if (!r) return { ok: false, steps };
  if (m.detect?.http) await step('server reachable', async () => [!!r.detection.endpoint, r.detection.endpoint ?? 'no answer on any port or host']);
  if (m.models && r.detection.endpoint) await step('models', async () => [true, r.backends.map(b => b.model).join(', ') || 'none loaded']);
  const openai = m.speaks?.openai, model = r.backends[0]?.model;
  if (openai && r.detection.endpoint && model) {
    if ((m.cost ?? 'unknown') !== 'free') steps.push({ name: 'completion', ok: true, detail: 'skipped: paid target, needs consent (Phase 3)', ms: 0 });
    else await step('1-token completion', async () => {
      const res = await env.http({ method: 'POST', url: `${r.detection.endpoint}${openai.base}/chat/completions`, timeoutMs: 120000,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK' }], max_tokens: 1 }) });
      const ok = res?.status === 200 && Array.isArray(pick(parseJson(res.body), 'choices'));
      return [ok, ok ? `${model} answered` : `HTTP ${res?.status ?? 'no answer'}`];
    });
  }
  if (m.speaks?.mcpClient) await step('MCP client config', async () => {
    const text = await env.readFile(m.speaks!.mcpClient!.config);
    if (text === null) return [true, 'no config file yet'];
    const servers = pick(parseJson(text), m.speaks!.mcpClient!.key);
    if (servers === undefined && parseJson(text) === undefined) return [false, 'config file is not valid JSON'];
    return [true, servers && typeof servers === 'object' && 'agent-spaghetti' in servers ? 'agent-spaghetti entry present' : 'not connected yet (Phase 3)'];
  });
  if (i.module?.test) steps.push(...await i.module.test(env, r.detection, { signal: AbortSignal.timeout(60000), inventory }));
  return { ok: steps.every(s => s.ok), steps };
}
