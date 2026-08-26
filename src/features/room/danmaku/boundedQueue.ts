/**
 * 定容 FIFO，避免每次溢出都使用 `Array#shift` 或头部 `splice`。
 * 繁忙房间收到的消息远多于列表能绘制的数量，
 * 淘汰最旧元素必须保持均摊 O(1)。
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

  /** 加入一个元素并返回因容量上限而被淘汰的最旧元素。 */
  push(value: T): T[] {
    this.items.push(value);
    return this.trimToCapacity();
  }

  /** 加入一批并返回因容量上限而被淘汰的最旧元素。 */
  pushAll(values: Iterable<T>): T[] {
    for (const value of values) this.items.push(value);
    return this.trimToCapacity();
  }

  /** 按 FIFO 至多取出 `limit` 个元素。 */
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
   * 不要为每个被丢弃的元素做复制。当有意义的前缀已经死亡时一次性压缩；
   * 这使队列操作保持均摊 O(1)，
   * 同时在漫长繁忙的直播中限制数组保留内存。
   */
  private compactIfUseful(): void {
    if (this.head < 128 || this.head * 2 < this.items.length) return;
    this.items = this.items.slice(this.head);
    this.head = 0;
  }
}
