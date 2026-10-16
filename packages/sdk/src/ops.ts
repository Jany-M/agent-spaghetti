// The one list of operations: REST routes, CLI usage text and (Phase 3) MCP tools are all generated from it.
import type { Snapshot, StoredEvent, Level } from './types.ts';

export interface OpSpec { method: 'GET' | 'POST'; path: string; summary: string; usage: string }
export const OPS = {
  status:       { method: 'GET',  path: '/v1/status',       usage: 'status',       summary: 'Last scan and live state' },
  scan:         { method: 'POST', path: '/v1/scan',         usage: 'scan',         summary: 'Scan every environment now' },
  events:       { method: 'GET',  path: '/v1/events',       usage: 'events [--follow]', summary: 'Stored events (or follow new ones)' },
  integrations: { method: 'GET',  path: '/v1/integrations', usage: 'integrations', summary: 'Loaded and rejected integrations' },
} as const satisfies Record<string, OpSpec>;
export type OpId = keyof typeof OPS;
export interface OpIO {
  status: { in: {}; out: { snapshot: Snapshot | null } };
  scan: { in: {}; out: { snapshot: Snapshot } };
  events: { in: { since?: number; limit?: number }; out: StoredEvent[] };
  integrations: { in: {}; out: { loaded: Array<{ id: string; name: string; source: string; levels: Level[] }>; rejected: Array<{ id: string; why: string }> } };
}
export const STREAM_PATH = '/v1/events/stream';
