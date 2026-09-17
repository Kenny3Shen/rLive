/**
 * 短视频舞台指示器的浏览器测量夹具。
 *
 * 测的是「画面上的加载/暂停指示是否真的由 Video.js 原语渲染、且只当指示器用」：
 * 这一层是纯渲染，纯函数单测量不到 —— 需要真实 Tailwind 类名、`--media-*` 令牌
 * 与 Video.js 的 store 上下文同时成立。
 *
 * 只桩 `<video>` 的媒体状态：改元素的 `paused` / `readyState` 并派发对应事件，让
 * `playbackFeature` 的 `sync()` 读到想要的 store 状态。短视频的传输（dash.js）
 * 不参与这里，`Poster` / `BufferingIndicator` / `PlayButton` 读的都是同一个
 * playback store。
 */
const { default: React } = await import("react");
const { createRoot } = await import("react-dom/client");
// 必须显式引应用样式表：Tailwind 的 utilities 由 `@tailwindcss/vite` 从这张表里
// 生成，夹具不引它就没有任何类名生效，量出来的尺寸全是错的。
await import("/src/styles.css");
const { ShortsStage } = await import("/src/features/shorts/ShortsStage.tsx");

const h = React.createElement;
const NOOP = () => {};

const ITEM = {
  bvid: "BV1a",
  aid: "1",
  cid: 41_855_094_127,
  title: "竖屏第一条",
  cover: "",
  author: "测试 UP 主",
  author_face: null,
  author_fans: 11389,
  duration: 93,
  view: 187_172,
  danmaku: 24,
  pubdate: 1_789_292_152,
  rcmd_reason: null,
  dimension: { width: 1080, height: 1920, rotate: 0 },
};

/** 舞台读的这些字段；本夹具关心的是暂停/播放两态。 */
function playbackState(paused) {
  return {
    loading: false,
    paused,
    error: null,
    currentTime: 0,
    duration: 93,
    muted: false,
    intrinsicSize: { width: 1080, height: 1920 },
    rate: 1,
    ready: true,
    togglePlay: NOOP,
    toggleMuted: NOOP,
    seek: NOOP,
    setRate: NOOP,
    retry: NOOP,
  };
}

const host = document.getElementById("fixture");
if (!host) throw new Error("缺少 #fixture 挂载点");

let root = null;
let videoRef = null;
let surfaceTapCount = 0;

/**
 * 让 `<video>` 自报一个状态并派发事件，使 playbackFeature 同步 store。
 *
 * `paused` / `readyState` 在真实 `<video>` 上是只读的：用 `Object.defineProperty`
 * 覆盖到实例上，这是桩媒体状态的常规手法（真机由浏览器自己维护）。
 */
function setMedia(video, { paused, readyState = 4 }) {
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => readyState });
  video.dispatchEvent(new Event(paused ? "pause" : "play"));
  video.dispatchEvent(new Event(paused ? "canplay" : "playing"));
  video.dispatchEvent(new Event("timeupdate"));
}

function Stage({ paused }) {
  // 舞台本身不含 `.media-skin`：真实页面把它放在 `shorts-viewport` 上（见
  // `ShortsPage`），`--media-*` 令牌与图标前景色都从那里继承。夹具必须复刻这一层，
  // 否则 `text-media-controls-foreground` 落空、图标变成继承来的黑色。
  return h(
    "div",
    {
      "data-shorts-indicator-fixture": "",
      className: "media-skin",
      style: {
        position: "relative",
        width: "360px",
        height: "732px",
        "--media-scale-unit": "1.2rem",
      },
    },
    h(ShortsStage, {
      item: ITEM,
      playback: playbackState(paused),
      videoRef,
      mode: "play",
      danmaku: { entries: [], ensure: NOOP },
      danmakuVisible: false,
      gestureActive: false,
      onSurfaceTap: () => {
        surfaceTapCount += 1;
      },
    }),
  );
}

const frames = async () => {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  await new Promise((resolve) => requestAnimationFrame(resolve));
};

/** 量画面框里的指示器：暂停按钮、转圈图标与点按层穿透。 */
function measure() {
  const frame = host.querySelector('[data-slot="shorts-frame"]');
  if (!frame) return null;
  const playWrapper = frame.querySelector('[data-slot="shorts-play-indicator"]');
  const play = playWrapper?.querySelector("button");
  const playIcon = play?.querySelector("svg");
  const buffering = frame.querySelector('[data-slot="shorts-buffering-indicator"]');
  const bufferingIcon = buffering?.querySelector("svg");
  const rect = (node) => {
    if (!node) return null;
    const { width, height } = node.getBoundingClientRect();
    return { width: Math.round(width), height: Math.round(height) };
  };
  const cssSize = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    return { width: style.width, height: style.height };
  };
  return {
    hasPlayButton: !!play,
    playPaused: play?.hasAttribute("data-paused") ?? false,
    playStarted: play?.hasAttribute("data-started") ?? false,
    tabIndex: play?.getAttribute("tabindex") ?? null,
    wrapperPointerEvents: playWrapper ? getComputedStyle(playWrapper).pointerEvents : null,
    wrapperAriaHidden: playWrapper?.getAttribute("aria-hidden") ?? null,
    playBox: rect(play),
    // 图标有 `scale` 入场过渡（隐藏态 scale 为 0），`getBoundingClientRect` 会随
    // 动画抖动；尺寸断言改读计算样式，稳定反映 `size-media-icon` 解析出的值。
    playIconCss: cssSize(playIcon),
    // 转圈图标在未缓冲时处于 `display:none` 的容器里，量不到布局盒；
    // 读计算样式拿它解析出的宽高（`size-media-icon` → `--media-icon-size`）。
    bufferingIconCss: cssSize(bufferingIcon),
    hasBuffering: !!buffering,
    bufferingVisible: buffering?.hasAttribute("data-visible") ?? false,
  };
}

window.__shortsStageIndicator = {
  /** 渲染一次（`paused` 决定舞台是否显示暂停指示）。 */
  async render(paused) {
    window.__shortsStageIndicatorRoot ??= createRoot(host);
    root = window.__shortsStageIndicatorRoot;
    videoRef ??= React.createRef();
    surfaceTapCount = 0;
    root.render(h(Stage, { paused }));
    await frames();
    const video = host.querySelector("video");
    if (!video) throw new Error("舞台没有渲染 <video>");
    setMedia(video, { paused });
    await frames();
    return measure();
  },
  /** 让媒体进入缓冲态（starved）：`waiting` 为真且未暂停。 */
  async starve() {
    const video = host.querySelector("video");
    if (!video) throw new Error("舞台没有渲染 <video>");
    setMedia(video, { paused: false, readyState: 2 });
    await frames();
    return measure();
  },
  /** 点画面框的点按层：指示器不得截住这次点击。 */
  async tapSurface() {
    const frame = host.querySelector('[data-slot="shorts-frame"]');
    const layer = frame?.lastElementChild;
    if (!layer) throw new Error("没有找到点按层");
    layer.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await frames();
    return surfaceTapCount;
  },
  unmount() {
    root?.unmount();
    root = null;
  },
};
