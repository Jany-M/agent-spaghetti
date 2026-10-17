// The one list of core settings keys (typed), stored in the store's kv table, plus each integration's own settings
// (module `settings`, keys prefixed with its id). Grants live here too.
import type { Grant, Integration, SettingDef } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

export const SETTINGS = {
  disabled: { default: [] as string[], help: 'Integrations the scan skips (hub-side off switch)' },
  llmHosts: { default: [] as string[], help: 'Extra hosts to probe for local servers (added to LLM_HOSTS)' },
  'events.retentionDays': { default: 14, help: 'Days of events kept in the store' },
  'connect.auto': { default: [] as string[], help: 'Clients connected to agent-spaghetti on every scan ("Always connect")' },
  'connect.never': { default: [] as string[], help: 'Clients never connected and never asked about ("Don\'t connect")' },
  'scan.everyMin': { default: 10, help: 'Minutes between automatic full rescans (0 = only on start, on demand and when a tool starts or stops)' },
  'observe.toolPollMs': { default: 3000, help: 'How often running tools and model servers are re-checked' },
  'observe.sessionPollMs': { default: 2000, help: 'How often agent sessions are polled (tools without an event stream)' },
  'backend.concurrency': { default: 1, help: 'Requests a local model server runs at once (the rest wait in its queue)' },
  'consent.timeoutSec': { default: 120, help: 'Seconds a delegation waits for your answer before it is denied' },
  'delegate.deadlineSec': { default: 1800, help: 'Longest a delegated run may take' },
  'delegate.maxHops': { default: 8, help: 'Most hand-offs in one chain (hops plus nested delegations); stops loops' },
  'dispatcher.model': { default: '', help: 'Model the dispatcher thinks with: <target>:<model> from targets (empty = off: auto hand-offs go to the best-ranked target)' },
  'gateway.port': { default: 0, help: 'Port of the model gateway on 127.0.0.1, the OpenAI-compatible endpoint tools can use (0 = off; e.g. 4141)' },
  'gateway.routes': { default: [] as string[], help: 'Each tool\'s model through the gateway: <tool>=<target>:<model> or <tool>=auto (Tools → the tool → Model)' },
  'dispatcher.stuckMin': { default: 10, help: 'Minutes without progress before the dispatcher hands a run to another target (once per chain)' },
} as const;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['default'] extends readonly string[] ? string[] : (typeof SETTINGS)[K]['default'] extends string ? string : number;

const valid = (d: SettingDef['default'], v: unknown) => (Array.isArray(d) ? Array.isArray(v) && v.every(x => typeof x === 'string')
  : typeof d === 'string' ? typeof v === 'string' : typeof v === 'number' && Number.isFinite(v));

export class Settings {
  private store: Store;
  private tools: () => Integration[];
  /** `tools`: the loaded integrations, whose modules may declare their own settings. */
  constructor(store: Store, tools: () => Integration[] = () => []) { this.store = store; this.tools = tools; }
  private defs(): Record<string, SettingDef> {
    return { ...SETTINGS, ...Object.fromEntries(this.tools().flatMap(i => Object.entries(i.module?.settings ?? {}).map(([k, d]) => [`${i.manifest.id}.${k}`, d]))) };
  }
  private value(k: string, d: SettingDef) { return this.store.getKv(`setting:${k}`) ?? d.default; }
  get<K extends SettingKey>(k: K): SettingValue<K> { return this.value(k, SETTINGS[k]) as SettingValue<K>; }
  set<K extends SettingKey>(k: K, v: SettingValue<K>): void { this.put(k, SETTINGS[k], v); }
  private put(k: string, d: SettingDef, v: unknown) {
    if (!valid(d.default, v)) throw new Error(`invalid value for ${k}`);
    this.store.setKv(`setting:${k}`, v);
  }
  /** From CLI/REST text: lists are comma separated ('' = empty), numbers as numbers, text as is. */
  setText(k: string, text: string): void {
    const d = this.defs()[k];
    if (!d) throw new Error(`unknown setting ${k} (known: ${Object.keys(this.defs()).join(', ')})`);
    this.put(k, d, Array.isArray(d.default) ? text.split(',').map(x => x.trim()).filter(Boolean) : typeof d.default === 'string' ? text.trim() : Number(text));
  }
  all(): Record<string, { value: unknown; help: string }> {
    return Object.fromEntries(Object.entries(this.defs()).map(([k, d]) => [k, { value: this.value(k, d), help: d.help }]));
  }
  /** One tool's own settings without the prefix (<id>.model → { model: … }), for its module hooks. */
  optionsOf(id: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.defs()).filter(([k]) => k.startsWith(`${id}.`)).map(([k, d]) => [k.slice(id.length + 1), String(this.value(k, d))]));
  }
  grants(): Grant[] { return this.store.getKv<Grant[]>('grants') ?? []; }
  setGrants(g: Grant[]): void { this.store.setKv('grants', g); }
}
