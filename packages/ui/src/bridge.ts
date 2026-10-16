// What a renderer may ask the daemon, through the Electron preload (the renderer never holds the token).
// The one allowlist: the main process refuses every other op.
import type { OpIO, StoredEvent } from '@agent-spaghetti/sdk/web';

export const BRIDGE_OPS = ['status', 'scan', 'consent', 'switches', 'switch'] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];
export const isBridgeOp = (op: unknown): op is BridgeOp => (BRIDGE_OPS as readonly unknown[]).includes(op);
/** Hub events, plus the connection state the main process sees. */
export type BridgeEvent = StoredEvent | { type: 'hub.up' | 'hub.down' };
export interface Bridge {
  call<K extends BridgeOp>(op: K, input?: OpIO[K]['in']): Promise<OpIO[K]['out']>;
  onEvent(fn: (e: BridgeEvent) => void): () => void;
}
export const CHANNEL = { call: 'agent-spaghetti:call', event: 'agent-spaghetti:event' } as const;
