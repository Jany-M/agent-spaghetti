/** Runs fn with an AbortSignal; rejects with "timeout after Nms" and always clears its timer. */
export function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  const onParent = () => ac.abort(parent?.reason);
  parent?.addEventListener('abort', onParent, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error(`timeout after ${ms}ms`)); }, ms); });
  return Promise.race([fn(ac.signal), timeout]).finally(() => { clearTimeout(timer); parent?.removeEventListener('abort', onParent); });
}
/** Bounded parallelism, results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = { status: 'fulfilled', value: await fn(items[i]) }; } catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
/** First come, first served slots (one local GPU = one request at a time). */
export class Semaphore {
  running = 0;
  private queue: Array<() => void> = [];
  limit: number;
  constructor(limit: number) { this.limit = limit; }
  get waiting() { return this.queue.length; }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.running >= this.limit) await new Promise<void>((res, rej) => {
      const go = () => { signal?.removeEventListener('abort', stop); res(); };
      const stop = () => { this.queue = this.queue.filter(f => f !== go); rej(new Error('cancelled')); };
      signal?.addEventListener('abort', stop, { once: true });
      this.queue.push(go);
    });
    this.running++;
    let done = false;
    return () => { if (done) return; done = true; this.running--; this.queue.shift()?.(); };
  }
}
