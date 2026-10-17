/** Injectable clock so the whole pipeline can run on recorded data or in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  private t: number;
  private waiters: Array<{ at: number; resolve: () => void }> = [];
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push({ at: this.t + ms, resolve });
    });
  }
  /** Advance time, resolving every sleeper that is due, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.waiters.sort((a, b) => a.at - b.at);
      const next = this.waiters[0];
      if (!next || next.at > end) break;
      this.waiters.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    this.t = end;
  }
}
