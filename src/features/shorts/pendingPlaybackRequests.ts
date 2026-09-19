/**
 * Tauri invoke 不能被 AbortSignal 中止；取消的是结果所有权。
 * 在途结果、已返回但还未提交的结果，都由请求池兜底释放；claim 后交给槽位。
 */
export class PendingPlaybackRequests<T extends object> {
  private readonly pending = new Set<{ cancelled: boolean; value?: T; detach: () => void }>();

  constructor(private readonly release: (value: T) => void) {}

  async acquire(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
    const ticket = {
      cancelled: signal.aborted,
      value: undefined as T | undefined,
      detach: () => {},
    };
    const cancel = () => {
      ticket.cancelled = true;
      ticket.detach();
      this.pending.delete(ticket);
      if (ticket.value) {
        this.release(ticket.value);
        ticket.value = undefined;
      }
    };
    ticket.detach = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    this.pending.add(ticket);
    try {
      if (ticket.cancelled) throw new DOMException("取流已取消", "AbortError");
      const value = await request();
      if (ticket.cancelled) {
        this.release(value);
        throw new DOMException("取流已取消", "AbortError");
      }
      ticket.value = value;
      return value;
    } catch (error) {
      ticket.detach();
      this.pending.delete(ticket);
      throw error;
    }
  }

  claim(value: T): void {
    for (const ticket of this.pending) {
      if (ticket.value !== value) continue;
      ticket.detach();
      this.pending.delete(ticket);
      return;
    }
  }

  /** 幂等；旧请求迟到后仍释放，但允许 StrictMode 重新建立新请求。 */
  clear(): void {
    for (const ticket of this.pending) {
      ticket.cancelled = true;
      ticket.detach();
      if (ticket.value) this.release(ticket.value);
    }
    this.pending.clear();
  }
}
