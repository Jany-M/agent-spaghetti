// What a renderer may ask the daemon, through the Electron preload (the renderer never holds the token).
// The allowlist is derived from OPS[*].gui (ADR 0009): every op a panel or the tray menu offers; `machine` ops never.
import { OPS, type OpId, type OpIO, type StoredEvent } from '@agent-spaghetti/sdk/web';

export const BRIDGE_OPS = (Object.keys(OPS) as OpId[]).filter((id): id is BridgeOp => OPS[id].gui !== 'machine');
export type BridgeOp = { [K in OpId]: (typeof OPS)[K]['gui'] extends 'machine' ? never : K }[OpId];
export const isBridgeOp = (op: unknown): op is BridgeOp => (BRIDGE_OPS as unknown[]).includes(op);
/** Hub events, plus the connection state the main process sees. */
export type BridgeEvent = StoredEvent | { type: 'hub.up' | 'hub.down' };
export interface Bridge {
  call<K extends BridgeOp>(op: K, input?: OpIO[K]['in']): Promise<OpIO[K]['out']>;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
}
export const CHANNEL = { call: 'agent-spaghetti:call', event: 'agent-spaghetti:event' } as const;
