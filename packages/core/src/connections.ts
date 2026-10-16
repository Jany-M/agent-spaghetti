// Connection preferences (ADR 0009): what to do with each found client after a scan. Pure; the daemon executes it.
import type { Detection } from '@agent-spaghetti/sdk';

export interface ConnectStep { id: string; do: 'connect' | 'disconnect' | 'ask' }
/** Clients = detections with `connected` defined. Never → disconnect if connected; always → connect if not; neither → ask once per daemon run. */
export function connectionPlan(detections: Detection[], pref: { auto: string[]; never: string[] }, asked: ReadonlySet<string>): ConnectStep[] {
  const connected = new Map<string, boolean>();
  for (const d of detections) if (d.connected !== undefined) connected.set(d.integration, (connected.get(d.integration) ?? false) || d.connected);
  const out: ConnectStep[] = [];
  for (const [id, on] of connected) {
    if (pref.never.includes(id)) { if (on) out.push({ id, do: 'disconnect' }); }
    else if (pref.auto.includes(id)) { if (!on) out.push({ id, do: 'connect' }); }
    else if (!on && !asked.has(id)) out.push({ id, do: 'ask' });
  }
  return out;
}
/** The connect question's three answers, in the consent queue's terms. */
export const CONNECT_LABELS = { once: 'Connect for this session', always: 'Always connect', deny: "Don't connect" };
