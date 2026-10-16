// The one list of settings keys (typed), stored in the store's kv table. Grants live here too.
import type { Grant } from '@agent-spaghetti/sdk';
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
} as const;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['default'] extends readonly string[] ? string[] : number;

export class Settings {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  get<K extends SettingKey>(k: K): SettingValue<K> { return (this.store.getKv<SettingValue<K>>(`setting:${k}`) ?? SETTINGS[k].default) as SettingValue<K>; }
  set<K extends SettingKey>(k: K, v: SettingValue<K>): void {
    const d = SETTINGS[k].default;
    if (Array.isArray(d) ? !Array.isArray(v) || v.some(x => typeof x !== 'string') : typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`invalid value for ${k}`);
    this.store.setKv(`setting:${k}`, v);
  }
  /** From CLI/REST text: lists are comma separated ('' = empty), numbers as numbers. */
  setText(k: string, text: string): void {
    if (!isSettingKey(k)) throw new Error(`unknown setting ${k} (known: ${Object.keys(SETTINGS).join(', ')})`);
    this.set(k, (Array.isArray(SETTINGS[k].default) ? text.split(',').map(x => x.trim()).filter(Boolean) : Number(text)) as never);
  }
  all(): Record<string, { value: unknown; help: string }> {
    return Object.fromEntries((Object.keys(SETTINGS) as SettingKey[]).map(k => [k, { value: this.get(k), help: SETTINGS[k].help }]));
  }
  grants(): Grant[] { return this.store.getKv<Grant[]>('grants') ?? []; }
  setGrants(g: Grant[]): void { this.store.setKv('grants', g); }
}
export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS;
