/**
 * A fixed-capacity FIFO that avoids `Array#shift` / front `splice` on every
 * overflow. Busy rooms can receive many more messages than the list can
 * paint, so evicting the oldest item has to stay O(1) amortized.
 */
export class BoundedQueue<T> {
  private items: T[] = [];
  private head = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get length(): number {
    return this.items.length - this.head;
  }

  clear(): void {
    this.items = [];
    this.head = 0;
  }

  /** Adds one item and returns any oldest items evicted by the capacity cap. */
  push(value: T): T[] {
    this.items.push(value);
    return this.trimToCapacity();
  }

  /** Adds a batch and returns any oldest items evicted by the capacity cap. */
  pushAll(values: Iterable<T>): T[] {
    for (const value of values) this.items.push(value);
    return this.trimToCapacity();
  }

  /** Takes at most `limit` items in FIFO order. */
  take(limit: number): T[] {
    const count = Math.min(this.length, Math.max(0, Math.floor(limit)));
    if (count === 0) return [];

    const end = this.head + count;
    const batch = this.items.slice(this.head, end);
    this.head = end;
    if (this.head === this.items.length) {
      this.clear();
    } else {
      this.compactIfUseful();
    }
    return batch;
  }

  private trimToCapacity(): T[] {
    const overflow = this.length - this.capacity;
    if (overflow <= 0) return [];
    const discarded = this.items.slice(this.head, this.head + overflow);
    this.head += overflow;
    this.compactIfUseful();
    return discarded;
  }

  /**
   * Do not copy for every dropped item. Once a meaningful prefix is dead,
   * compact it in one copy; this keeps queue operations O(1) amortized while
   * bounding retained array memory during a long, busy stream.
   */
  private compactIfUseful(): void {
    if (this.head < 128 || this.head * 2 < this.items.length) return;
    this.items = this.items.slice(this.head);
    this.head = 0;
  }
}
