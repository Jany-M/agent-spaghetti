// The panels' only data path: one op over the bridge, refreshed on hub events; actions report their errors.
import { useCallback, useEffect, useState } from 'react';
import { isTrace, type OpIO, type StoredEvent } from '@agent-spaghetti/sdk/web';
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
    const off = bridge.onEvent(e => { if ('id' in e && isTrace(e)) return; clearTimeout(t); t = setTimeout(reload, 300); });   // live-only traces change no op's data
    return () => { off(); clearTimeout(t); };
  }, [bridge, reload]);
  return { data, error, reload };
}

/** The latest stored events (`keep` of them), then new ones as they come; `live` adds the live-only trace events (never stored). */
export function useEvents(bridge: Bridge, keep: number, live = false) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  useEffect(() => {
    let on = true;
    void bridge.call('status').then(s => bridge.call('events', { since: Math.max(0, s.live.lastEventId - keep), limit: keep }))
      .then(ev => { if (on) setEvents(l => [...ev, ...l.filter(x => !ev.some(y => y.id === x.id))].slice(-keep)); }).catch(() => {});
    const off = bridge.onEvent(e => { if ('id' in e && (live || !isTrace(e))) setEvents(l => [...l.filter(x => x.id !== e.id), e].slice(-keep)); });
    return () => { on = false; off(); };
  }, [bridge, keep, live]);
  return [events, setEvents] as const;
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
