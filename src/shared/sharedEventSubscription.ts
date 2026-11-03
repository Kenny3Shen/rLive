/**
 * 在多个消费者之间共享一份原生事件监听。
 *
 * 同一份查询可能被页面和常驻外壳同时订阅；每个消费者都直接 `listen` 会重复
 * 接收同一事件。这里按 subscriber 引用计数，只在第一个消费者出现时注册，
 * 并处理 StrictMode 重挂载期间迟到的异步清理。
 */
export type SharedEventSubscription<TSubscriber> = {
  (subscriber: TSubscriber): () => void;
  /**
   * 订阅并等待原生监听注册成功；失败时自动释放临时订阅。
   *
   * 查询函数在读取权威快照前用它取得监听所有权，避免快照与异步注册之间
   * 出现“事件已发生但缓存尚未建立”的窗口。
   */
  whenReady(subscriber: TSubscriber): Promise<() => void>;
};

export function createSharedEventSubscription<TSubscriber, TEvent>(
  registerNative: (onEvent: (event: TEvent) => void) => Promise<() => void>,
  notifySubscriber: (subscriber: TSubscriber, event: TEvent) => void,
): SharedEventSubscription<TSubscriber> {
  const subscriberCounts = new Map<TSubscriber, number>();
  let nativeUnlisten: (() => void) | null = null;
  let registrationPromise: Promise<void> | null = null;
  let listenerGeneration = 0;
  let readyWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  function resolveReadyWaiters() {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  function rejectReadyWaiters(error: unknown) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  function unlistenSafely(unlisten: (() => void) | null) {
    if (!unlisten) return;
    try {
      unlisten();
    } catch {
      // 原生监听器清理失败时，查询轮询仍可作为兜底。
    }
  }

  function ensureNativeListener() {
    if (nativeUnlisten) {
      resolveReadyWaiters();
      return;
    }
    if (registrationPromise || subscriberCounts.size === 0) return;
    const generation = ++listenerGeneration;
    registrationPromise = Promise.resolve()
      .then(() =>
        registerNative((event) => {
          if (generation !== listenerGeneration) return;
          for (const subscriber of subscriberCounts.keys()) {
            try {
              notifySubscriber(subscriber, event);
            } catch {
              // 一个查询客户端的回调失败不得阻止其他客户端刷新。
            }
          }
        }),
      )
      .then(
        (cleanup) => {
          registrationPromise = null;
          if (subscriberCounts.size === 0 || generation !== listenerGeneration) {
            unlistenSafely(cleanup);
            ensureNativeListener();
            return;
          }
          nativeUnlisten = cleanup;
          resolveReadyWaiters();
        },
        (error: unknown) => {
          registrationPromise = null;
          // 过期注册尚未完成时发生的重挂载需要一次全新尝试。
          if (subscriberCounts.size > 0 && generation !== listenerGeneration) {
            ensureNativeListener();
            return;
          }
          rejectReadyWaiters(error);
        },
      );
  }

  function stopNativeListenerIfUnused() {
    if (subscriberCounts.size > 0) return;
    listenerGeneration += 1;
    const cleanup = nativeUnlisten;
    nativeUnlisten = null;
    unlistenSafely(cleanup);
  }

  function subscribe(subscriber: TSubscriber) {
    subscriberCounts.set(subscriber, (subscriberCounts.get(subscriber) ?? 0) + 1);
    ensureNativeListener();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const count = subscriberCounts.get(subscriber) ?? 0;
      if (count <= 1) {
        subscriberCounts.delete(subscriber);
      } else {
        subscriberCounts.set(subscriber, count - 1);
      }
      stopNativeListenerIfUnused();
    };
  }

  function whenReady(subscriber: TSubscriber): Promise<() => void> {
    const release = subscribe(subscriber);
    if (nativeUnlisten) return Promise.resolve(release);
    return new Promise((resolve, reject) => {
      readyWaiters.push({
        resolve: () => resolve(release),
        reject: (error) => {
          release();
          reject(error);
        },
      });
      ensureNativeListener();
    });
  }

  return Object.assign(subscribe, { whenReady });
}
