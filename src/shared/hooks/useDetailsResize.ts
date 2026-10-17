import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";
import { detailsScrollTopFor, scrollDetailsContent } from "@/shared/gestures/detailsScroll";
import {
  clampDetailsSharePercent,
  DETAILS_MOMENTUM_MIN_VELOCITY,
  DETAILS_MOMENTUM_SAMPLE_LIMIT,
  DETAILS_MOMENTUM_STOP_VELOCITY,
  DETAILS_RESIZE_TAP_SUPPRESSION_MS,
  detailsContentScrollStep,
  detailsMomentumStep,
  detailsResizeCeiling,
  detailsResizeIntent,
  detailsResizeStepIsVisible,
  detailsResizeVelocity,
  detailsShareCssValue,
  detailsShareFromHeights,
  detailsShareMaxPercent,
  detailsShareMinPercent,
  type DetailsMomentumSample,
} from "@/shared/gestures/detailsResize";

type ResizeState = {
  touchId: number;
  lastY: number;
  containerWidth: number;
  containerHeight: number;
  aspectRatio: number | null;
  minPercent: number;
  maxPercent: number;
  active: boolean;
  lastPercent: number;
  scrollers: HTMLElement[];
};

/**
 * 松手后仍在推进的惯性。
 *
 * 与 `ResizeState` 分开存：惯性期间没有手指、也没有触摸身份，但它和拖动
 * 共用同一套「位移分配 → 写 CSS 变量」的路径，因此只存跑动所需的最少状态。
 */
type MomentumState = {
  velocity: number;
  lastTime: number;
  containerHeight: number;
  minPercent: number;
  maxPercent: number;
  percent: number;
  scrollers: HTMLElement[];
  frame: number | null;
};

/** 现场量出的本轮调整基准：容器尺寸、起算占比与双向边界。 */
type ResizeMetrics = {
  containerWidth: number;
  containerHeight: number;
  aspectRatio: number | null;
  percent: number;
  minPercent: number;
  maxPercent: number;
};

/**
 * 已按下、但还没开始调整占比的一次按压。
 *
 * 与 `ResizeState` 分开存是有原因的：手势**启用**的时刻不由手指决定。首次进入
 * 播放页时画幅要等媒体报出 `videoWidth/videoHeight` 才可知（`enabled` 依赖它），
 * 而手指可能在那之前就按下了。若把「按下」和「可调整」合成同一份状态，
 * 启用那一刻的重算（`ResizeObserver` 的收口）就会把这份状态当作旧手势清掉，
 * 整次拖动随之丢失 —— 这正是「首次进入有时拖不动」的根因。
 *
 * 按压因此只记录与布局无关的东西（触摸身份、起点、滚动链），
 * 布局量（容器尺寸、起算占比、上下限）等到真正接管的那一刻再现场量。
 */
type ResizePress = {
  touchId: number;
  startX: number;
  startY: number;
  /**
   * 最近一次**已派发** touchmove 的纵向位置。
   *
   * 接管那一帧的位移要算「本帧增量」（当前减上一次已派发位置），不能算「自按下
   * 以来的总位移」：总位移跨过了布局变化（画幅刚到位、舞台刚变高），算进来会让
   * 第一帧跳一下；也不能从当前位置起算（那是 0，本帧就不会认领手势，
   * 浏览器随即开始原生滚动，整次拖动依然丢）。
   */
  lastY: number;
  scrollers: HTMLElement[];
  intent: "pending" | "resize" | "swipe";
  /** 最近几次位移采样（环形，最多 `DETAILS_MOMENTUM_SAMPLE_LIMIT` 条），松手时估算速度。 */
  samples: DetailsMomentumSample[];
};

export type UseDetailsResizeOptions = {
  /** 仅移动端、上下布局、已知非 16:9 视频且不在全屏时启用。 */
  enabled: boolean;
  /** 原始源画幅，用于恢复默认舞台（满宽按比值撑高，最高占容器 70%）。 */
  aspectRatio?: number | null;
  containerRef: RefObject<HTMLElement | null>;
  detailsRef: RefObject<HTMLElement | null>;
  /** 逐帧预览不进入 React 状态；结束后由宿主提交。 */
  onPreview: (percent: number) => void;
  onCommit: (percent: number) => void;
  onClamp?: (percent: number) => void;
};

/** 只收集命中内容到页签视口内的滚动链，不滚动页面或后台页签。 */
function contentScrollers(target: Element, viewport: HTMLElement): HTMLElement[] {
  const scrollers: HTMLElement[] = [];
  for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
    if (
      node instanceof HTMLElement &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      scrollers.push(node);
    }
  }
  return scrollers;
}

/**
 * 移动端内容滑动自适应侧栏。返回值只绑定页签内容视口，Tab 栏不参与。
 *
 * touchmove 使用原生非 passive 监听器：纵向原生滚动会取消 PointerEvent，
 * React 的 passive touchmove 又无法阻止同一位移被浏览器和布局各消费一次。
 * 仅需改变占比时认领手势；到达边界的剩余位移交给命中的滚动链。完全不需调整
 * 时保留原生滚动及惯性，已由浏览器认领的不可取消事件不再抢回。
 *
 * 松手后按末段速度接着推进一段（见 `detailsMomentumStep`），并在下一次按下时
 * 立即停下并把当时的位置提交出去 —— 惯性不是“正在拖动”，但也不是可以随便
 * 推翻的临时状态。
 *
 * 监听器**不按 `enabled` 绑定**：首次进入播放页时画幅要等媒体报出尺寸才可知，
 * 手指可能先于它按下；按 `enabled` 绑定会让这一次拖动整个失效。绑定恒常、
 * 是否接管逐帧看 `enabled`，因此启用后手势能接着进行（见 `ResizePress`）。
 */
export function useDetailsResize({
  enabled,
  aspectRatio = null,
  containerRef,
  detailsRef,
  onPreview,
  onCommit,
  onClamp,
}: UseDetailsResizeOptions) {
  const stateRef = useRef<ResizeState | null>(null);
  const pressRef = useRef<ResizePress | null>(null);
  const momentumRef = useRef<MomentumState | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const callbacksRef = useRef({ onPreview, onCommit, onClamp });
  const aspectRatioRef = useRef(aspectRatio);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    callbacksRef.current = { onPreview, onCommit, onClamp };
    aspectRatioRef.current = aspectRatio;
    enabledRef.current = enabled;
  });

  const cancelPreview = useCallback(() => {
    if (previewFrameRef.current === null) return;
    window.cancelAnimationFrame(previewFrameRef.current);
    previewFrameRef.current = null;
  }, []);

  /**
   * 停下惯性并提交停在的位置。
   *
   * `commit` 为假时只清状态（几何变化、禁用、卸载都不该把当前值写回宿主 ——
   * 几何变化时宿主自己会按新边界收口，禁用时那个值已经无意义）。
   */
  const stopMomentum = useCallback((commit: boolean) => {
    const momentum = momentumRef.current;
    momentumRef.current = null;
    if (!momentum) return false;
    if (momentum.frame !== null) window.cancelAnimationFrame(momentum.frame);
    if (commit) {
      callbacksRef.current.onCommit(momentum.percent);
      suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
    }
    return true;
  }, []);

  const finish = useCallback(() => {
    const state = stateRef.current;
    stateRef.current = null;
    pressRef.current = null;
    cancelPreview();
    if (state?.active) {
      callbacksRef.current.onCommit(state.lastPercent);
      suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
    }
  }, [cancelPreview]);

  /** 量取本轮调整的基准；只在需要时读 DOM，不写任何状态。 */
  const measureResize = useCallback((): ResizeMetrics | null => {
    const container = containerRef.current;
    const details = detailsRef.current;
    if (!container || !details || container.clientHeight <= 0) return null;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const percent = detailsShareFromHeights(
      details.getBoundingClientRect().height,
      containerHeight,
    );
    const minPercent = detailsShareMinPercent(
      containerWidth,
      containerHeight,
      aspectRatioRef.current,
    );
    return {
      containerWidth,
      containerHeight,
      aspectRatio: aspectRatioRef.current,
      percent,
      minPercent,
      maxPercent: detailsResizeCeiling(percent, containerWidth, containerHeight, minPercent),
    };
  }, [containerRef, detailsRef]);

  /**
   * 真正接管一次按压：用现场量到的基准建立本轮调整。
   *
   * `lastY` 继承按压里记的上一次已派发位置，于是接管那一帧的位移正好是它自己的
   * 增量，而按下到接管之间的位移不会被追溯应用。
   */
  const beginResize = useCallback(
    (press: ResizePress): ResizeState | null => {
      const metrics = measureResize();
      if (!metrics) return null;
      const state: ResizeState = {
        touchId: press.touchId,
        lastY: press.lastY,
        containerWidth: metrics.containerWidth,
        containerHeight: metrics.containerHeight,
        aspectRatio: metrics.aspectRatio,
        minPercent: metrics.minPercent,
        maxPercent: metrics.maxPercent,
        active: false,
        lastPercent: metrics.percent,
        scrollers: press.scrollers,
      };
      stateRef.current = state;
      return state;
    },
    [measureResize],
  );

  /**
   * 惯性循环：每帧把衰减后的位移交给同一套分配逻辑，并预览占比。
   *
   * 只调 `requestAnimationFrame`（不用 WAAPI/CSS）：惯性要写的是布局占比，
   * 不是可交给合成器的位移，而且它必须与拖动手势共用 `detailsContentScrollStep`
   * 的「先滚内容、到顶再缩侧栏」规则，否则甩到底时会跳。
   */
  const startMomentum = useCallback(
    (velocity: number, state: ResizeState) => {
      momentumRef.current = {
        velocity,
        lastTime: performance.now(),
        containerHeight: state.containerHeight,
        minPercent: state.minPercent,
        maxPercent: state.maxPercent,
        percent: state.lastPercent,
        scrollers: state.scrollers,
        frame: null,
      };
      const step = (now: number) => {
        const momentum = momentumRef.current;
        if (!momentum) return;
        momentum.frame = null;
        const dt = now - momentum.lastTime;
        momentum.lastTime = now;
        const { delta, velocity: nextVelocity } = detailsMomentumStep(momentum.velocity, dt);
        momentum.velocity = nextVelocity;
        const previousPercent = momentum.percent;
        // 上滑与纯扩大布局的帧不读取滚动链；下滑先回顶才需要真实 scrollTop。
        const scrollTopBefore = detailsScrollTopFor(momentum.scrollers, delta);
        const next = detailsContentScrollStep(
          previousPercent,
          delta,
          scrollTopBefore,
          momentum.containerHeight,
          momentum.maxPercent,
          momentum.minPercent,
        );
        momentum.percent = next.percent;
        // 先消费内容滚动、再写占比：写 grid 会改布局，之后任何 scrollTop 读写都要
        // 先结算刚写的布局。纯内容滚动帧不写占比，也不触发整张网格重排。
        const scrolled = scrollDetailsContent(momentum.scrollers, next.scrollDelta);
        if (Math.abs(next.percent - previousPercent) > 1e-9) {
          callbacksRef.current.onPreview(next.percent);
        }
        // 占比与滚动都不再变化（上限处内容也到底了）：继续跑只是空转，直接停下并提交。
        const stalled = Math.abs(next.percent - previousPercent) < 1e-9 && Math.abs(scrolled) < 0.5;
        if (stalled || Math.abs(momentum.velocity) < DETAILS_MOMENTUM_STOP_VELOCITY) {
          stopMomentum(true);
          return;
        }
        momentum.frame = window.requestAnimationFrame(step);
      };
      momentumRef.current.frame = window.requestAnimationFrame(step);
    },
    [stopMomentum],
  );

  const bindContent = useCallback(
    (viewport: HTMLDivElement | null) => {
      if (!viewport) return;
      const start = (event: TouchEvent) => {
        // 再次按下：惯性让位。先把当时的位置提交出去，否则新手势会从旧起点重算，
        // 用户会看到侧栏弹回甩出去之前；并重新拉长点击抑制，否则抬起后第一下
        // 点按会落在刚被甩过去的内容上。
        if (stopMomentum(true)) {
          suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
        }
        if (event.touches.length !== 1) {
          finish();
          return;
        }
        const target = event.target;
        if (!(target instanceof Element) || !viewport.contains(target)) return;
        if (
          target.closest(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="switch"], [role="dialog"], [data-slot="scroll-area-scrollbar"]',
          )
        )
          return;
        const touch = event.touches[0];
        pressRef.current = {
          touchId: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          lastY: touch.clientY,
          scrollers: contentScrollers(target, viewport),
          intent: "pending",
          samples: [{ time: event.timeStamp, y: touch.clientY }],
        };
      };
      /**
       * 未越过锁定距离时的表态：只阻止默认行为，既不接管也不预览。
       *
       * 合成器按**第一个 touchmove 是否被阻止**决定手势归属：不阻止它就当场开始
       * 原生滚动，并把后续 touchmove 全标成 `cancelable === false`。锁定距离是
       * `10px`，而手指逐帧位移常常只有 3~4px，合成器的触摸 slop 又恰好也是这个
       * 量级（实测 9px 的首帧已经会被判给原生滚动）—— 等攒够 10px 时事件早已不可
       * 取消，`!event.cancelable` 把整次拖动丢掉。这正是「切换侧栏页签或点开信息卡
       * 标题后，第一次滑动不改变侧栏高度」的根因：只有首帧位移就 ≥10px 的大跨度
       * 滑动才抢得赢这场归属竞争。
       *
       * 只在纵向占优且这一步**真能**改变占比时按住不放：到达边界、以及下滑要先
       * 滚回内容顶部的位移照旧让给原生滚动与惯性。画幅未知、或当前根本没启用调整
       * （16:9、全屏、并排）时无从判断能否调整，也不能乐观接管 —— 一旦接管，
       * 合成器到手指抬起前都不会再开始原生滚动，用户会白划一下。`preventDefault`
       * 只作用于 touchmove，不吞 click，也不拦页签横滑用的 PointerEvent。
       */
      const claimPendingMove = (
        event: TouchEvent,
        press: ResizePress,
        offsetX: number,
        offsetY: number,
        deltaY: number,
      ) => {
        if (!event.cancelable || !enabledRef.current) return;
        if (Math.abs(offsetY) <= Math.abs(offsetX)) return;
        const metrics = measureResize();
        if (!metrics) return;
        const scrollTop = detailsScrollTopFor(press.scrollers, deltaY);
        const next = detailsContentScrollStep(
          metrics.percent,
          deltaY,
          scrollTop,
          metrics.containerHeight,
          metrics.maxPercent,
          metrics.minPercent,
        );
        if (!detailsResizeStepIsVisible(metrics.percent, next.percent, metrics.containerHeight))
          return;
        event.preventDefault();
      };
      const move = (event: TouchEvent) => {
        const press = pressRef.current;
        if (!press) return;
        if (event.touches.length !== 1) {
          finish();
          return;
        }
        const touch = Array.from(event.touches).find((item) => item.identifier === press.touchId);
        if (!touch) return;
        const previousY = press.lastY;
        press.lastY = touch.clientY;
        // 速度采样只保留最近几条（环形）：更早的位移属于上一段动作，松手时要的是末段速度。
        press.samples.push({ time: event.timeStamp, y: touch.clientY });
        if (press.samples.length > DETAILS_MOMENTUM_SAMPLE_LIMIT) press.samples.shift();
        if (press.intent === "pending") {
          press.intent = detailsResizeIntent(
            touch.clientX - press.startX,
            touch.clientY - press.startY,
          );
          if (press.intent === "pending") {
            claimPendingMove(
              event,
              press,
              touch.clientX - press.startX,
              touch.clientY - press.startY,
              touch.clientY - previousY,
            );
            return;
          }
        }
        if (press.intent === "swipe") {
          pressRef.current = null;
          return;
        }
        // 原生滚动已开始后不能再改布局，否则同一手指位移会被消费两次。
        if (!event.cancelable) return;
        // 纵向意图已定但画幅还没到（首次进入的常见时序）：留住这次按压，
        // 等 `enabled` 转真后的下一个 touchmove 再接管。
        if (!enabledRef.current) return;
        const state = stateRef.current ?? beginResize(press);
        if (!state) return;
        const delta = touch.clientY - previousY;
        const next = detailsContentScrollStep(
          state.lastPercent,
          delta,
          detailsScrollTopFor(state.scrollers, delta),
          state.containerHeight,
          state.maxPercent,
          state.minPercent,
        );
        const changed = Math.abs(next.percent - state.lastPercent) > 0.0001;
        // 尚未接管时，只有这一步**真能**改变布局才抢下归属：占比由侧栏真实高度反算，
        // 而容器高度只有整数精度，边界处会留下亚像素偏差 —— 直接比百分比会把它读成
        // 「还能再拖」，每次到达上限都恰好抢走原生滚动与惯性（见 `detailsResizeStepIsVisible`）。
        // 已接管的手势不受此限：它本来就由我们逐帧分配位移。
        if (
          !state.active &&
          !detailsResizeStepIsVisible(state.lastPercent, next.percent, state.containerHeight)
        )
          return;
        event.preventDefault();
        state.active = true;
        state.lastPercent = next.percent;
        // 与惯性同一读写顺序：滚动先于占比写入，避免写 grid 后立刻回读滚动几何。
        scrollDetailsContent(state.scrollers, next.scrollDelta);
        if (changed && previewFrameRef.current === null) {
          previewFrameRef.current = window.requestAnimationFrame(() => {
            previewFrameRef.current = null;
            if (stateRef.current === state) callbacksRef.current.onPreview(state.lastPercent);
          });
        }
      };
      /** 抬手/取消共用：`cancel` 为真时绝不接惯性（合成器收回手势，方向与速度都无意义）。 */
      const end = (event: TouchEvent, cancel: boolean) => {
        const touchId = stateRef.current?.touchId ?? pressRef.current?.touchId;
        if (touchId === undefined) return;
        if (!Array.from(event.changedTouches).some((item) => item.identifier === touchId)) return;
        // 只有真正拖过占比、且末段速度足够快的手势才接惯性：慢速松手、刚认领就
        // 抬起、以及只让内容滚了一段的手势都不该继续动侧栏。
        const state = stateRef.current;
        const samples = pressRef.current?.samples;
        const velocity = !cancel && state?.active && samples ? detailsResizeVelocity(samples) : 0;
        if (state?.active && Math.abs(velocity) >= DETAILS_MOMENTUM_MIN_VELOCITY) {
          // 惯性接手：这里不提交，等它停下再一次性写回，免得中途先落到一个
          // 马上就被覆盖的位置（React 会为它重渲染一次）。
          stateRef.current = null;
          pressRef.current = null;
          cancelPreview();
          callbacksRef.current.onPreview(state.lastPercent);
          suppressClickUntilRef.current = Date.now() + DETAILS_RESIZE_TAP_SUPPRESSION_MS;
          startMomentum(velocity, state);
          return;
        }
        finish();
      };
      const touchEnd = (event: TouchEvent) => end(event, false);
      const touchCancel = (event: TouchEvent) => end(event, true);
      const click = (event: MouseEvent) => {
        if (Date.now() >= suppressClickUntilRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      };
      viewport.addEventListener("touchstart", start, { passive: true, capture: true });
      viewport.addEventListener("touchmove", move, { passive: false, capture: true });
      viewport.addEventListener("touchend", touchEnd, true);
      viewport.addEventListener("touchcancel", touchCancel, true);
      viewport.addEventListener("click", click, true);
      // React 19 回调 ref 清理：移除监听器并丢弃未提交帧，卸载不更新宿主状态。
      return () => {
        viewport.removeEventListener("touchstart", start, true);
        viewport.removeEventListener("touchmove", move, true);
        viewport.removeEventListener("touchend", touchEnd, true);
        viewport.removeEventListener("touchcancel", touchCancel, true);
        viewport.removeEventListener("click", click, true);
        cancelPreview();
        // 卸载/解绑不提交惯性位置：宿主已经不在这一页了。
        stopMomentum(false);
        stateRef.current = null;
        pressRef.current = null;
        clearDetailsResizing(containerRef.current);
      };
    },
    [beginResize, cancelPreview, containerRef, finish, measureResize, startMomentum, stopMomentum],
  );

  /**
   * 禁用时收掉正在进行的调整（旋转、全屏、切 16:9 都会走到这里）。
   *
   * 只丢调整状态，**保留尚未接管的按压**：`enabled` 是逐帧判定的，一次按住期间
   * 它可能先假后真（画幅刚到位、刚从全屏退出）。按压在重新启用后还要能接着用，
   * 否则同一次拖动会被切成两段。
   */
  useLayoutEffect(() => {
    if (enabled) return;
    stateRef.current = null;
    // 禁用时惯性也不能再推：它写的是同一个 CSS 变量，转屏后就是错的布局。
    stopMomentum(false);
    cancelPreview();
    clearDetailsResizing(containerRef.current);
  }, [cancelPreview, containerRef, enabled, stopMomentum]);

  // 旋转/分屏/画幅变化后重算双向边界；未调整过的默认布局不参与。
  useLayoutEffect(() => {
    if (!enabled || !onClamp) return;
    const container = containerRef.current;
    if (!container) return;
    const apply = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!(width > 0) || !(height > 0)) return;
      const state = stateRef.current;
      if (state) {
        if (
          state.containerWidth === width &&
          state.containerHeight === height &&
          Object.is(state.aspectRatio, aspectRatio)
        ) {
          return;
        }
        // 几何变化让本次位移尺度失效：先提交并结束，再按新边界收口，不能等下次手势。
        finish();
      }
      // 惯性用的是旧尺寸与旧边界，同样不能继续跑；收口由下面的 clamp 接手。
      stopMomentum(false);
      const current = state?.active
        ? state.lastPercent
        : Number.parseFloat(container.style.getPropertyValue("--vod-details-share"));
      if (!Number.isFinite(current)) return;
      const minPercent = detailsShareMinPercent(width, height, aspectRatio);
      const clamped = clampDetailsSharePercent(
        current,
        detailsShareMaxPercent(width, height),
        minPercent,
      );
      if (Math.abs(clamped - current) > 0.01) callbacksRef.current.onClamp?.(clamped);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [aspectRatio, containerRef, enabled, finish, onClamp, stopMomentum]);

  return bindContent;
}

/** 高频变量不继承到内容子树；预览标记只由手势写，避免 React 播放进度提交干扰。 */
export function writeDetailsShare(container: HTMLElement | null, percent: number): void {
  if (!container) return;
  const value = detailsShareCssValue(percent);
  if (container.style.getPropertyValue("--vod-details-share") !== value) {
    container.style.setProperty("--vod-details-share", value);
  }
  if (container.dataset.vodDetailsResizing !== "true") {
    container.dataset.vodDetailsResizing = "true";
  }
}

/** 结束预览：保留最终占比，只撤掉实时调整标记。 */
export function clearDetailsResizing(container: HTMLElement | null): void {
  if (!container) return;
  delete container.dataset.vodDetailsResizing;
}
