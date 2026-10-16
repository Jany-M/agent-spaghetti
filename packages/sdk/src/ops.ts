// The one list of operations: REST routes, CLI usage text and (Phase 3) MCP tools are all generated from it.
import type { Snapshot, StoredEvent, Level, Switch, TestResult } from './types.ts';
import type { Action, DeclaredAction, Grant, Mode } from './permissions.ts';
import type { LiveState } from './state.ts';

export interface OpSpec { method: 'GET' | 'POST'; path: string; summary: string; usage: string }
export const OPS = {
  status:       { method: 'GET',  path: '/v1/status',       usage: 'status',                   summary: 'Last scan and live state' },
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
} as const satisfies Record<string, OpSpec>;
export type OpId = keyof typeof OPS;
export interface EnvResult<T> { envId: string; result?: T; error?: string }
export interface GrantIn { subject: string; mode: Mode; action?: Action; resource?: string }
export interface OpIO {
  status: { in: {}; out: { snapshot: Snapshot | null; live: LiveState } };
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
}
export const STREAM_PATH = '/v1/events/stream';
