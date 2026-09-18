/**
 * 短视频进度条的浏览器测量夹具。
 *
 * 测的是「进度条换成 Video.js 原语之后，几何与行为仍满足底栏契约」：
 *
 * - 页面的换片手势按 `data-slot="shorts-seek"` 跳过从这里开始的按压，因此这个钩子
 *   必须留在 20px 命中层上；命中层只向上撑开，视觉轨道只有 3px 且占布局。
 * - 原语的行为：拖动改的是 `--media-slider-fill`，释放才 commit 一次 seek；拖动期
 *   间不逐帧 seek（DASH 取流会崩）。
 * - 预览气泡：位置夹在轨道内，缩略图按 B 站单格 160×90 原尺寸显示。
 *
 * 用真实 `<video>` 桩媒体状态：`TimeSlider` 读的是播放器 store，而 store 由
 * `timeFeature` / `bufferFeature` 从元素同步。短路 media 的传输（测试环境不取流）。
 */
const { default: React } = await import("react");
const { createRoot } = await import("react-dom/client");
// 必须显式引应用样式表：Tailwind 的 utilities 由 `@tailwindcss/vite` 从这张表里
// 生成，夹具不引它就没有任何类名生效，量出来的尺寸全是错的。
await import("/src/styles.css");
const { ShortsSeekBar } = await import("/src/features/shorts/ShortsSeekBar.tsx");
const { ShortsSeekPlayer, ShortsSeekBridge } = await import(
  "/src/features/shorts/shortsSeekPlayer.ts"
);

const h = React.createElement;
const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");

/*
 * 合成 PointerEvent 没有真实的活动指针，`setPointerCapture` 会招 `NotFoundError`。
 * 原语没有 try/catch（它假定指针真实存在），一旦抛出会跳过 `input.patch`，拖动就
 * 完全不动。夹具把捕获三件套做成 no-op，模拟真实输入下的成功路径。
 */
const captureState = new Set();
HTMLElement.prototype.setPointerCapture = function setPointerCapture(id) {
  captureState.add(this);
  return undefined;
};
HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(id) {
  captureState.delete(this);
};
HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(id) {
  return captureState.has(this);
};

/**
 * 2×2 一张图、每格 160×90 的最小快照，与单测同一份。
 *
 * 图源用内联 SVG（显式 1600×900）而不是真实 CDN：`ThumbnailCore.resize` 要用
 * `naturalWidth` 反推缩放，找不到的图会让容器退化成 0×0，量不到 160×90。
 */
const SHEET_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='900'%3E%3Crect width='1600' height='900' fill='%23333'/%3E%3C/svg%3E";
const THUMBNAILS = [
  { url: SHEET_SRC, startTime: 0, width: 160, height: 90, coords: { x: 0, y: 0 } },
  { url: SHEET_SRC, startTime: 10, width: 160, height: 90, coords: { x: 160, y: 0 } },
];

let root = null;
let videoRef = null;
let armed = 0;
let seekCount = 0;
let seekValues = [];

/**
 * 让 `<video>` 自报可 seek 的媒体状态。
 *
 * `duration` / `currentTime` / `readyState` 在未加载媒体时不可用，`hasTimeRange`
 * 会判 false，进度条因此渲染成 disabled；而 `seek` 还会先 `hasMetadata` 再写
 * `currentTime`，readyState 不够时它一直等 `loadedmetadata`。这里把这三个读数
 * 覆盖成我们要的值，并派发 `loadedmetadata` / `progress`，让两个 feature 同步。
 */
function stubMedia(video) {
  const state = { t: 0 };
  Object.defineProperty(video, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(video, "duration", { configurable: true, get: () => 93 });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => state.t,
    set: (value) => {
      state.t = value;
      seekCount += 1;
      seekValues.push(value);
      video.dispatchEvent(new Event("timeupdate"));
      // `timeFeature.seek` 等 `seeked` 才返回；不等也不会重试，但派发能让状态闭环。
      video.dispatchEvent(new Event("seeked"));
    },
  });
  // buffered / seekable 是只读的：给一段可读区间。`TimeRanges` 构造不出来，
  // 用最小结构满足 `serializeTimeRanges`。
  const range = { length: 1, start: () => 0, end: () => 30 };
  Object.defineProperty(video, "buffered", { configurable: true, get: () => range });
  Object.defineProperty(video, "seekable", { configurable: true, get: () => range });
  video.dispatchEvent(new Event("loadedmetadata"));
  video.dispatchEvent(new Event("progress"));
  video.dispatchEvent(new Event("timeupdate"));
}

function Fixture({ onArmed }) {
  const ref = React.useRef(null);
  // 必须渲染在 Player 里：`TimeSlider` 读不到 store 的 time feature 时直接 return null。
  return h(
    ShortsSeekPlayer,
    null,
    h("video", { ref, muted: true, playsInline: true }),
    h(ShortsSeekBridge, { videoRef: ref, active: "a" }),
    h(ShortsSeekBar, { thumbnails: THUMBNAILS, onArmed }),
  );
}

window.__shortsSeek = {
  // 同一个 root 复用宿主：夹具从干净 DOM 开始，不需要重复 import。
  async mount() {
    if (root) return;
    armed = 0;
    seekCount = 0;
    seekValues = [];
    root = createRoot(host);
    await new Promise((resolve) => {
      root.render(h(Fixture, { onArmed: () => (armed += 1) }));
      // 让 ref 回调、feature attach 与 store 同步都落地。
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    videoRef = host.querySelector("video");
    stubMedia(videoRef);
    // 等 store 因派发的事件重渲染出非 disabled 的进度条。
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  },

  /** 命中层与视觉轨道、以及 `data-slot` 钩子的几何。 */
  geometry() {
    const hit = host.querySelector('[data-slot="shorts-seek"]');
    const track = hit?.firstElementChild;
    const thumb = host.querySelector('[role="slider"]');
    const rect = (node) => {
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      host: rect(host),
      hit: rect(hit),
      track: rect(track),
      // 键盘与 ARIA 都挂在原语的 Thumb（它才是 role=slider/可聚焦元素），命中层只负责
      // 接指针并挂 `data-slot`。
      thumb: rect(thumb),
      thumbRole: thumb?.getAttribute("role"),
      thumbTabIndex: thumb?.getAttribute("tabindex"),
      ariaDisabled: thumb?.getAttribute("aria-disabled"),
      ariaValueNow: thumb?.getAttribute("aria-valuenow"),
    };
  },

  /** 合成一次从按下到抬起的横向拖动，返回此时的 CSS 变量与提交的 seek。 */
  async drag(ratio) {
    const hit = host.querySelector('[data-slot="shorts-seek"]');
    const box = hit.getBoundingClientRect();
    const before = seekCount;
    const y = box.top + box.height / 2;
    const down = { pointerId: 91, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true };
    hit.dispatchEvent(new PointerEvent("pointerdown", { ...down, clientX: box.left + 2, clientY: y }));
    for (const step of [0.25, 0.5, ratio]) {
      hit.dispatchEvent(
        new PointerEvent("pointermove", {
          ...down,
          clientX: box.left + box.width * step,
          clientY: y,
        }),
      );
    }
    // CSS 变量由 slider 的 `syncStyles` 写在 React 提交之后，必须等一帧再读，否则
    // 读到的是按下前的那份。
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const during = {
      fill: hit.style.getPropertyValue("--media-slider-fill"),
      pointer: hit.style.getPropertyValue("--media-slider-pointer"),
      dragging: hit.hasAttribute("data-dragging"),
      seekingBeforeRelease: seekCount - before,
    };
    hit.dispatchEvent(
      new PointerEvent("pointerup", { ...down, clientX: box.left + box.width * ratio, clientY: y }),
    );
    // 真实浏览器在 pointerup 之后会自动释放捕获并派发 `lostpointercapture`，而原语
    // 靠这个事件收尾（`endDrag`）。合成事件不会自动发生，夹具必须补上，否则下一个
    // 悬停的 pointermove 会被当成这次拖动仍在继续。
    hit.dispatchEvent(new PointerEvent("lostpointercapture", { ...down }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { during, commits: seekCount - before, last: seekValues.at(-1) };
  },

  /** 悬停（`data-pointing`）时的预览几何与缩略图尺寸。 */
  async hover(ratio) {
    const hit = host.querySelector('[data-slot="shorts-seek"]');
    const box = hit.getBoundingClientRect();
    // 悬停是 `pointermove`、不是 `pointerenter`：原语在 `onPointerMove` 里打上
    // `pointing`，没有真实鼠标时合成事件只能送 pointermove。
    hit.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 92,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 0,
        bubbles: true,
        clientX: box.left + box.width * ratio,
        clientY: box.top + box.height / 2,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    // 预览有 `opacity/scale` 入场过渡：与断言的 160×90 无关，但量几何前让它落位。
    // 图片本身也必须先 load —— `ThumbnailCore` 用 `naturalWidth` 反推缩放。
    await new Promise((resolve) => setTimeout(resolve, 350));
    const preview = hit.querySelector('[class*="bottom-"]');
    const image = hit.querySelector("img");
    const thumbnail = image?.parentElement ?? null;
    const rect = (node) => {
      if (!node) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      pointing: hit.hasAttribute("data-pointing"),
      preview: rect(preview),
      thumbnail: rect(thumbnail),
      thumbnailsPresent: hit.querySelectorAll("img").length,
      track: rect(hit.firstElementChild),
    };
  },

  /** 键盘：焦点在 Thumb 上时，左右键应 seek ±5s（原语 step）。 */
  async key(key) {
    const thumb = host.querySelector('[role="slider"][tabindex="0"]');
    thumb.focus();
    thumb.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { last: seekValues.at(-1), count: seekCount };
  },

  armed: () => armed,
  seekCount: () => seekCount,
};
