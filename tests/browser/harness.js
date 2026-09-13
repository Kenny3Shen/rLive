// 浏览器内回归测试的公共装配。
//
// 由 `tests/*.browser.js` 在 `page.evaluate` 里动态 import：
//   const { setupHarness } = await import("/tests/browser/harness.js");
//
// 只解决所有夹具都要重复的三件事：复用页面已加载的 Vite 依赖（避免第二份
// React）、断言与帧等待、以及 root 装配与卸载清理。断言语义和被测组件仍留在
// 各夹具里。
//
// 该目录不进入生产构建，Vite 直接按源码服务本文件。

/**
 * 页面已加载依赖的预打包 URL（含版本参数）。
 *
 * 必须复用页面自己的实例：另起一份 React 会让 hooks 落在不同的运行时上，
 * StrictMode 的双调用与 ResizeObserver 时序都不再可信。
 */
export function dependencyUrl(name) {
  const entry = performance.getEntriesByType("resource").find((resource) => {
    const url = new URL(resource.name);
    return url.pathname.endsWith(`/deps/${name}.js`) && url.searchParams.has("v");
  });
  if (!entry) throw new Error(`请先打开 Vite 页面：未找到已加载的依赖 ${name}`);
  return entry.name;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** 两帧：让 React 提交与随后的 ResizeObserver 回调都落地。 */
export const frames = async () => {
  await frame();
  await frame();
};

/**
 * 在元素中心合成一次触摸点按。
 *
 * 桌面 WebView2 的 CDP 会话没有 `hasTouch`，`page.touchscreen.*` 会直接报错；
 * 而手势识别器只看 pointer 事件的 `pointerType`，自己派发即可，同一份夹具
 * 因此在桌面与 Android 上都能跑。真实手指微抖仍只有真机能覆盖。
 */
let touchPointerId = 1;
export function touchTap(element) {
  const box = element.getBoundingClientRect();
  const init = {
    pointerId: (touchPointerId += 1),
    pointerType: "touch",
    isPrimary: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    bubbles: true,
    cancelable: true,
  };
  element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new PointerEvent("pointerup", init));
}

/** 让元素上进行中的收尾动画直接落位，断言终点而不是中间帧。 */
export async function settleAnimations(element) {
  for (const animation of element.getAnimations()) animation.finish();
  await frames();
}

/** 轮询到条件成立；超时抛出调用方给的定位信息。 */
export async function until(predicate, message, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert(performance.now() < deadline, message);
    await frame();
  }
}

/**
 * 取页面 React 运行时并挂一个 root。
 *
 * `render` 用 `flushSync` 同步提交，断言无需再猜提交时机；`dispose` 幂等，
 * 可同时放在夹具的 finally 与显式清理里。
 *
 * @param {object} [options]
 * @param {string} [options.style] 写入宿主节点的 cssText。
 * @param {Element} [options.parent] 宿主节点的父节点，默认 `document.body`；
 *   需要落在真实页面的某个容器内（如播放表面）时传入。
 * @param {boolean} [options.strict] 默认在 StrictMode 下渲染以暴露副作用清理问题。
 *   被测组件自带一次性外部实例（如 Video.js player）时置 false，
 *   否则双挂载会重建实例，夹具持有的 ref 失效。
 */
export async function setupHarness(options = {}) {
  const { default: React } = await import(dependencyUrl("react"));
  const { default: ReactDOMClient } = await import(dependencyUrl("react-dom_client"));
  const { default: ReactDOM } = await import(dependencyUrl("react-dom"));
  const { createElement: h, createRef } = React;
  const { flushSync } = ReactDOM;

  const { style, parent = document.body, strict = true } = options;
  const host = document.createElement("div");
  if (style) host.style.cssText = style;
  parent.append(host);
  const root = ReactDOMClient.createRoot(host);
  let mounted = false;

  return {
    React,
    ReactDOM,
    h,
    createRef,
    flushSync,
    host,
    root,
    /** 同步渲染，返回后 DOM 已提交。 */
    render(element) {
      mounted = true;
      flushSync(() => root.render(strict ? h(React.StrictMode, null, element) : element));
    },
    query: (selector) => host.querySelector(selector),
    rect: (target) =>
      (typeof target === "string" ? host.querySelector(target) : target).getBoundingClientRect(),
    dispose() {
      if (mounted) {
        flushSync(() => root.unmount());
        mounted = false;
      }
      host.remove();
    },
  };
}
