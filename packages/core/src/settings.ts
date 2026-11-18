// The one list of core settings keys (typed), stored in the store's kv table, plus each integration's own settings
// (module `settings`, keys prefixed with its id). Grants live here too.
import type { Grant, Integration, SettingChoices, SettingDef } from '@agent-spaghetti/sdk';
import { JEV_DEFAULTS } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

export const SETTINGS = {
  disabled: { default: [] as string[], help: 'Integrations the scan skips (hub-side off switch)', choices: { from: 'tools' } },
  llmHosts: { default: [] as string[], help: 'Extra hosts to probe for local servers (added to LLM_HOSTS)' },
  'events.retentionDays': { default: 14, help: 'Days of events kept in the store' },
  'connect.auto': { default: [] as string[], help: 'Clients connected to agent-spaghetti on every scan ("Always connect")', choices: { from: 'clients' } },
  'connect.never': { default: [] as string[], help: 'Clients never connected and never asked about ("Don\'t connect")', choices: { from: 'clients' } },
  'scan.everyMin': { default: 10, help: 'Minutes between automatic full rescans (0 = only on start, on demand and when a tool starts or stops)' },
  'observe.toolPollMs': { default: 3000, help: 'How often running tools and model servers are re-checked' },
  'observe.sessionPollMs': { default: 2000, help: 'How often agent sessions are polled (tools without an event stream)' },
  'backend.concurrency': { default: 1, help: 'Requests a local model server runs at once (the rest wait in its queue)' },
  'consent.timeoutSec': { default: 120, help: 'Seconds a delegation waits for your answer before it is denied' },
  'tools.cost': { default: [] as string[], help: 'What a tool costs when you know better than the scan: <tool>=free|metered|unknown (Tools → the tool → Cost). Paid and unknown ones ask before use' },
  'delegate.deadlineSec': { default: 1800, help: 'Longest a delegated run may take' },
  'agents.use': { default: [] as string[], help: 'A tool\'s own agents (e.g. Hermes profiles) to use or not: <tool>:<agent>=on|off. Without an entry, agents on a paid provider or a local model of their own are off, the rest on (Tools → the tool)' },
  'delegate.models': { default: [] as string[], help: 'The model (or agent) an agent target uses when a task names none, instead of the tool\'s own default: <target>=<model>, or for one task kind or difficulty <target>:<kind|difficulty>=<model> (e.g. <agent>:research=<its researcher agent>, <agent>:heavy=<its strongest model>)' },
  'delegate.maxHops': { default: 8, help: 'Most hand-offs in one chain (hops plus nested delegations); stops loops' },
  'dispatcher.model': { default: '', help: 'Model the dispatcher thinks with: <target>:<model> from targets (empty = off: auto hand-offs go to the best-ranked target)', choices: { from: 'models', extra: [''] } },
  'dispatcher.stuckMin': { default: 10, help: 'Minutes without progress before the dispatcher hands a run to another target (once per chain)' },
  'gateway.port': { default: 4141, help: 'Port of the model gateway on 127.0.0.1: the OpenAI-compatible endpoint that lets tools use your local models through Agent Spaghetti. Tools that can take it by themselves (VS Code) are set up when connected; 0 = off' },
  'routing.learn': { default: true, help: 'Order targets for each kind of task by how their past runs went (finished, failed, your grades); off: cost, tier and queue only' },
  'routing.stretch': { default: true, help: 'A free target one tier below the task may try it first (a failure escalates)' },
  'routing.escalate': { default: true, help: 'When a target Agent Spaghetti chose fails or answers nothing, the next one in the ranking tries (once per chain; paid ones ask first)' },
  'routing.offload': { default: JEV_DEFAULTS.offload as string[], help: 'Kinds of task connected tools are told to hand off on their own, to a free target (none = only when you ask); read by a tool when it starts', choices: { from: 'kinds' } },
  'routing.prefer': { default: [] as string[], help: 'Your pick per kind of task, tried first: <kind>=<target> (Routing panel)' },
  'routing.never': { default: [] as string[], help: 'Targets never used for a kind of task: <kind>=<target> (Routing panel)' },
  'routing.tiers': { default: [] as string[], help: 'The hardest task a target takes, when its size does not say: <target>[:model]=light|medium|heavy' },
  debug: { default: false, help: 'Records what requests through the gateway look like (the message as the tool sent it, how it was read, where it went; secrets removed) as events in Activity, to find out how a tool talks to Agent Spaghetti. Off by default: the text can include your prompts' },
  'gateway.routes': { default: [] as string[], help: 'Each tool\'s model through the gateway: <tool>=<target>:<model> or <tool>=auto (Tools → the tool → Model)' },
} as const;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = (typeof SETTINGS)[K]['default'] extends readonly string[] ? string[] : (typeof SETTINGS)[K]['default'] extends string ? string
  : (typeof SETTINGS)[K]['default'] extends boolean ? boolean : number;

const valid = (d: SettingDef['default'], v: unknown) => (Array.isArray(d) ? Array.isArray(v) && v.every(x => typeof x === 'string')
  : typeof d === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === typeof d);
const BOOL: Record<string, boolean> = { on: true, true: true, yes: true, '1': true, off: false, false: false, no: false, '0': false };

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
  /** From CLI/REST text: lists are comma separated ('' = empty), numbers as numbers, switches as on/off, text as is. */
  setText(k: string, text: string): void {
    const d = this.defs()[k];
    if (!d) throw new Error(`unknown setting ${k} (known: ${Object.keys(this.defs()).join(', ')})`);
    this.put(k, d, Array.isArray(d.default) ? text.split(',').map(x => x.trim()).filter(Boolean) : typeof d.default === 'string' ? text.trim()
      : typeof d.default === 'boolean' ? BOOL[text.trim().toLowerCase()] : Number(text));
  }
  all(): Record<string, { value: unknown; help: string; choices?: SettingChoices }> {
    return Object.fromEntries(Object.entries(this.defs()).map(([k, d]) => [k, { value: this.value(k, d), help: d.help, ...(d.choices ? { choices: d.choices } : {}) }]));
  }
  /** One tool's own settings without the prefix (<id>.model → { model: … }), for its module hooks. */
  optionsOf(id: string): Record<string, string> {
    return Object.fromEntries(Object.entries(this.defs()).filter(([k]) => k.startsWith(`${id}.`)).map(([k, d]) => [k.slice(id.length + 1), String(this.value(k, d))]));
  }
  grants(): Grant[] { return this.store.getKv<Grant[]>('grants') ?? []; }
  setGrants(g: Grant[]): void { this.store.setKv('grants', g); }
}
