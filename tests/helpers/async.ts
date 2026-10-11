/** 可由测试控制完成时机的 Promise，用于复现迟到结果、取消与清理竞态。 */
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export type Deferred<T = void> = ReturnType<typeof deferred<T>>;

/** 等到下一个宏任务，让此前排队的微任务链落地；不代替有固定 tick 要求的等待。 */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
