/**
 * Bounded channel between the gRPC stream and the processing loop.
 *
 * Backpressure works in three layers:
 *   1. above the high-water mark the producer is told to pause (the gRPC
 *      stream is paused, so flow control pushes back to the server);
 *   2. it resumes below the low-water mark;
 *   3. if the queue is still full, bulk items are dropped and every mint
 *      they touched is marked as having a data gap. Items for watched mints
 *      (open or shadow positions) go to a priority lane that is never dropped.
 *
 * A dropped event never becomes a silent wrong number: the scorer refuses to
 * score any mint with a gap, and exits fall back to an RPC read of the curve.
 */

export interface QueueStats {
  depth: number;
  priorityDepth: number;
  enqueued: number;
  dropped: number;
  pauses: number;
  highWaterHits: number;
}

export class BoundedQueue<T> {
  private bulk: T[] = [];
  private bulkHead = 0;
  private priority: T[] = [];
  private waiters: Array<() => void> = [];
  private paused = false;
  readonly stats: QueueStats = { depth: 0, priorityDepth: 0, enqueued: 0, dropped: 0, pauses: 0, highWaterHits: 0 };

  constructor(
    private capacity: number,
    private onPressure: (pause: boolean) => void,
    private onDrop: (item: T) => void,
  ) {}

  private get size(): number {
    return this.bulk.length - this.bulkHead;
  }

  push(item: T, priority = false): void {
    this.stats.enqueued++;
    if (priority) {
      this.priority.push(item);
    } else if (this.size >= this.capacity) {
      this.stats.dropped++;
      this.onDrop(item);
      return;
    } else {
      this.bulk.push(item);
    }
    const high = Math.floor(this.capacity * 0.8);
    if (!this.paused && this.size >= high) {
      this.paused = true;
      this.stats.pauses++;
      this.stats.highWaterHits++;
      this.onPressure(true);
    }
    this.refresh();
    const w = this.waiters.shift();
    if (w) w();
  }

  /** Next item, priority lane first; waits when empty. */
  async take(): Promise<T> {
    for (;;) {
      const item = this.poll();
      if (item !== undefined) return item;
      await new Promise<void>((res) => this.waiters.push(res));
    }
  }

  poll(): T | undefined {
    let item: T | undefined;
    if (this.priority.length > 0) item = this.priority.shift();
    else if (this.size > 0) {
      item = this.bulk[this.bulkHead++];
      if (this.bulkHead > 4096 && this.bulkHead * 2 > this.bulk.length) {
        this.bulk = this.bulk.slice(this.bulkHead);
        this.bulkHead = 0;
      }
    }
    if (item !== undefined) {
      const low = Math.floor(this.capacity * 0.5);
      if (this.paused && this.size <= low) {
        this.paused = false;
        this.onPressure(false);
      }
      this.refresh();
    }
    return item;
  }

  private refresh(): void {
    this.stats.depth = this.size;
    this.stats.priorityDepth = this.priority.length;
  }
}
