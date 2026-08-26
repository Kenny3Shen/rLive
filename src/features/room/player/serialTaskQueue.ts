/**
 * 逐个执行异步生命周期操作。
 *
 * 流代理是进程全局的，过期房间的清理必须先完成，下一个房间才能创建自己的代理。
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
