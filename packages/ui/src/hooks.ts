// The panels' only data path: one op over the bridge, refreshed on hub events; actions report their errors.
import { useCallback, useEffect, useState } from 'react';
import type { OpIO } from '@agent-spaghetti/sdk/web';
import type { Bridge, BridgeOp } from './bridge.ts';

/** An op's result, re-fetched (coalesced) whenever the hub reports something. */
export function useOp<K extends BridgeOp>(bridge: Bridge, op: K, input?: OpIO[K]['in']) {
  const key = JSON.stringify(input ?? {});
  const [data, setData] = useState<OpIO[K]['out'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setData(await bridge.call(op, JSON.parse(key))); setError(null); } catch (e) { setError((e as Error).message); }
  }, [bridge, op, key]);
  useEffect(() => {
    void reload();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = bridge.onEvent(() => { clearTimeout(t); t = setTimeout(reload, 300); });
    return () => { off(); clearTimeout(t); };
  }, [bridge, reload]);
  return { data, error, reload };
}

/** Runs one action at a time; its error is shown until the next one. */
export function useAct(after?: () => unknown) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setError(null);
    void fn().catch((e: Error) => setError(e.message)).finally(() => { setBusy(null); void after?.(); });
  };
  return { busy, error, act };
}
