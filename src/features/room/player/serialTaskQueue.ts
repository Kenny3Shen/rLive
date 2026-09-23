/**
 * 逐个执行异步生命周期操作。
 *
 * 队列的串行边界由持有者决定：播放器按实例创建，并在重渲染之间保持稳定。
 * 同实例的清理和后续启动有序执行，不让一个播放器阻塞其他独立会话。
 * 拒绝被隔离，使一次失败的操作绝不阻碍后续的销毁或启动工作。
 */
export type SerialTaskQueue = {
  enqueue<T>(task: () => Promise<T> | T): Promise<T>;
};

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
      const run = tail.then(task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}
