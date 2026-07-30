/**
 * Runs asynchronous lifecycle operations one at a time.
 *
 * The stream proxy is process-global, so a stale room cleanup must finish
 * before the next room creates its proxy. Rejections are isolated so a failed
 * operation never prevents later teardown or startup work.
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
