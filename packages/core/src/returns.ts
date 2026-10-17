// Where a finished chain's result goes when its caller is no longer waiting (ADR 0010): resumed into the caller's own session
// when its engine can continue one, injected into its chat when it takes tasks there, else kept as an unread result the caller
// collects (`run_status` without an id, Runs). Resumed and injected results are report runs: recorded, never asked about.
import type { Delivery, RunRow, Target } from '@agent-spaghetti/sdk';
import type { Ledger } from './ledger.ts';
import type { Chain, Runner } from './runner.ts';

/** The message a caller gets back: what came of the work it handed off. */
export function reportText(chainId: number, hops: RunRow[], last: RunRow, result: string | undefined): string {
  const route = hops.map(h => h.target).join(' → ');
  const head = last.outcome === 'done' ? `The work you handed off (run ${chainId}: ${route}) is done. Result:`
    : `The work you handed off (run ${chainId}: ${route}) ended: ${last.outcome}${last.error ? ` (${last.error})` : ''}.`;
  const note = last.outcome === 'done' && last.error ? `\n\nNote: ${last.error}` : '';   // e.g. a next hop that could not start
  return `${head}\n\n${result?.trim() || '(no output)'}${note}`;
}

export function deliver(c: Chain, last: RunRow, origin: Target | undefined, ledger: Ledger, runner: Runner): Delivery {
  const p = c.parentRunId ? ledger.get(c.parentRunId) : null, parent = p?.target === c.source ? p : null;   // the caller's own run, when it was one
  const session = c.returnSession ?? parent?.session;
  const how: Delivery | null = origin?.resumable && session ? 'resumed' : origin?.engine === 'chat' ? 'injected' : null;
  if (how) {
    const { done } = runner.start(last.target, { target: c.source, kind: 'report', reason: `result of hand-off ${c.id}`, session, model: parent?.model, returnTo: 'none',
      parentRunId: last.id, task: reportText(c.id, ledger.hops(c.id), last, ledger.result(last)) }, { preapproved: true });
    void done.then(r => { if (r.outcome !== 'done') runner.setDelivered(c.id, 'unread'); });   // the session could not take it: kept for the caller
    return how;
  }
  return 'unread';
}
