// The one list of operations: REST routes, CLI usage text and the MCP tools (`mcp`) are all generated from it.
import type { Snapshot, StoredEvent, Level, RunRequest, RunRow, Switch, Target, TestResult } from './types.ts';
import { TASK_KINDS } from './types.ts';
import type { Action, ConsentRequest, ConsentScope, DeclaredAction, Grant, Mode } from './permissions.ts';
import type { LiveState } from './state.ts';

/** `mcp`: exposed to agents as an MCP tool with this name, description and JSON-Schema input. */
export interface OpSpec { method: 'GET' | 'POST'; path: string; summary: string; usage: string; mcp?: { name: string; description: string; input: Record<string, unknown> } }
export const OPS = {
  status:       { method: 'GET',  path: '/v1/status',       usage: 'status [--short]',         summary: 'Last scan, live state and questions waiting for you' },
  scan:         { method: 'POST', path: '/v1/scan',         usage: 'scan',                     summary: 'Scan every environment now' },
  events:       { method: 'GET',  path: '/v1/events',       usage: 'events [--follow]',        summary: 'Stored events (or follow new ones)' },
  integrations: { method: 'GET',  path: '/v1/integrations', usage: 'integrations',             summary: 'Loaded and rejected integrations' },
  switches:     { method: 'GET',  path: '/v1/switches',     usage: 'switches',                 summary: 'On/off switches in every environment' },
  switch:       { method: 'POST', path: '/v1/switch',       usage: 'on|off <switch> [--env <id>]', summary: 'Turn a switch on or off' },
  test:         { method: 'POST', path: '/v1/test',         usage: 'test <integration> [--env <id>]', summary: 'Check an integration end to end' },
  permissions:  { method: 'GET',  path: '/v1/permissions',  usage: 'permissions',              summary: 'What third-party integrations may do' },
  grant:        { method: 'POST', path: '/v1/grant',        usage: 'allow|deny <subject> [<action> <resource>]', summary: 'Grant or deny (all declared actions if none given)' },
  revoke:       { method: 'POST', path: '/v1/revoke',       usage: 'revoke <subject> [<action> <resource>]', summary: 'Remove grants (back to ask)' },
  settings:     { method: 'GET',  path: '/v1/settings',     usage: 'settings',                 summary: 'All settings with their values' },
  setting:      { method: 'POST', path: '/v1/setting',      usage: 'set <key> <value>',        summary: 'Change a setting (lists: comma separated)' },
  disable:      { method: 'POST', path: '/v1/disable',      usage: 'disable <integration>',    summary: 'Skip an integration in scans' },
  enable:       { method: 'POST', path: '/v1/enable',       usage: 'enable <integration>',     summary: 'Scan a disabled integration again' },
  report:       { method: 'GET',  path: '/v1/report',       usage: 'report [--out <file>]',    summary: 'Machine configuration report (Markdown)' },
  consent:      { method: 'POST', path: '/v1/consent',      usage: 'answer <id> allow|deny [once|job|always]', summary: 'Answer a question waiting for you (ids: status)' },
  shutdown:     { method: 'POST', path: '/v1/shutdown',     usage: 'shutdown',                 summary: 'Stop the daemon' },
  delegate:     { method: 'POST', path: '/v1/delegate',     usage: 'delegate <target> <task> [options]', summary: 'Hand a task to a local model or agent (--kind, --reason, --model)',
    mcp: { name: 'delegate', description: 'Hand a task to a local model or another agent on this machine (see `targets`). Free local models run at once; '
      + 'targets that may cost money ask the user first. Returns the result, or a run id to check with `run_status` if it takes long.',
      input: { type: 'object', additionalProperties: false, required: ['target', 'task'], properties: {
        target: { type: 'string', description: 'Target id from `targets`' }, task: { type: 'string', description: 'The full task, self-contained' },
        kind: { type: 'string', enum: [...TASK_KINDS] }, reason: { type: 'string', description: 'One line: why this is handed off' },
        model: { type: 'string', description: 'A loaded model of a model target (default: the first one)' },
        cwd: { type: 'string', description: 'Working folder for agents that edit files' } } } } },
  targets:      { method: 'GET',  path: '/v1/targets',      usage: 'targets',                  summary: 'What tasks can be handed to right now',
    mcp: { name: 'targets', description: 'List the local models and agents `delegate` can use now, with their cost class (free / metered).', input: { type: 'object', additionalProperties: false, properties: {} } } },
  runs:         { method: 'GET',  path: '/v1/runs',         usage: 'runs [<id>]',              summary: 'The run record; with an id: its hand-off chain and result',
    mcp: { name: 'run_status', description: 'Status and result of a delegated run.', input: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'integer' } } } } },
  cancel:       { method: 'POST', path: '/v1/cancel',       usage: 'cancel <id>',              summary: 'Stop a running delegation' },
  verdict:      { method: 'POST', path: '/v1/verdict',      usage: 'verdict <id> up|down|redo', summary: 'Rate a run (kept in the run record)' },
  connect:      { method: 'POST', path: '/v1/connect',      usage: 'connect <integration> [--dry-run]', summary: 'Give a client the agent-spaghetti tools (MCP + plugin)' },
  hook:         { method: 'POST', path: '/v1/hook',         usage: 'hook <client>',            summary: 'Run by client hooks (reads the hook JSON on stdin)' },
} as const satisfies Record<string, OpSpec>;
export type OpId = keyof typeof OPS;
export interface EnvResult<T> { envId: string; result?: T; error?: string }
export interface GrantIn { subject: string; mode: Mode; action?: Action; resource?: string }
export interface OpIO {
  status: { in: {}; out: { snapshot: Snapshot | null; live: LiveState; consents: ConsentRequest[] } };
  scan: { in: {}; out: { snapshot: Snapshot } };
  events: { in: { since?: number; limit?: number }; out: StoredEvent[] };
  integrations: { in: {}; out: { loaded: Array<{ id: string; name: string; source: string; levels: Level[]; disabled: boolean }>; rejected: Array<{ id: string; why: string }> } };
  switches: { in: {}; out: { switches: Switch[]; errors: Array<{ envId: string; error: string }> } };
  switch: { in: { id: string; on: boolean; envId?: string }; out: Switch };
  test: { in: { integration: string; envId?: string }; out: Array<EnvResult<TestResult>> };
  permissions: { in: {}; out: { subjects: Array<{ subject: string; declared: DeclaredAction[] }>; grants: Grant[]; pending: NonNullable<Snapshot['pending']> } };
  grant: { in: GrantIn; out: { grants: Grant[] } };
  revoke: { in: Omit<GrantIn, 'mode'>; out: { grants: Grant[] } };
  settings: { in: {}; out: Record<string, { value: unknown; help: string }> };
  setting: { in: { key: string; value: string }; out: Record<string, { value: unknown; help: string }> };
  disable: { in: { id: string }; out: { disabled: string[] } };
  enable: { in: { id: string }; out: { disabled: string[] } };
  report: { in: {}; out: { markdown: string } };
  consent: { in: { id: string; allow: boolean; scope?: ConsentScope }; out: { ok: true } };
  shutdown: { in: {}; out: { stopping: true } };
  delegate: { in: RunRequest & { source?: string; waitMs?: number }; out: RunView };
  targets: { in: {}; out: Target[] };
  runs: { in: { id?: number; since?: number; limit?: number }; out: { runs: RunRow[]; result?: string } };
  cancel: { in: { id: number }; out: { cancelled: boolean } };
  verdict: { in: { id: number; value: 'up' | 'down' | 'redo' }; out: { ok: true } };
  connect: { in: { integration: string; envId?: string; dryRun?: boolean }; out: ConnectResult };
  hook: { in: { client: string; event: string; data?: Record<string, unknown> }; out: { ok: true } };
}
/** A delegated run as callers see it: its record and, once finished, the result text. */
export interface RunView { id: number; run: RunRow; result?: string }
export type ConnectResult = import('./types.ts').Connected & { integration: string; envId: string };
export const STREAM_PATH = '/v1/events/stream';
