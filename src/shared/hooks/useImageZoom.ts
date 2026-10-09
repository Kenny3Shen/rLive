import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  clampImageZoomTransform,
  formatImageZoomTransform,
  imageZoomAnchorTransform,
  imageZoomIsIdentity,
  imageZoomRectContains,
  imageZoomReleasedTransform,
  imageZoomStepScale,
  imageZoomWheelScale,
  IMAGE_ZOOM_DOUBLE_TAP_INTERVAL_MS,
  IMAGE_ZOOM_DOUBLE_TAP_SCALE,
  IMAGE_ZOOM_DOUBLE_TAP_SLOP_PX,
  IMAGE_ZOOM_IDENTITY,
  IMAGE_ZOOM_SETTLE_MS,
  IMAGE_ZOOM_TAP_SLOP_PX,
  IMAGE_ZOOM_WHEEL_IDLE_MS,
  type ImageZoomGeometry,
  type ImageZoomTransform,
} from "@/shared/gestures/imageZoom";
import { motionProfile, prefersReducedMotion, SWIPE_SETTLE_EASING } from "@/shared/motion/tokens";

/** 缩放/平移结束后封锁点按的时长（ms）：拖动过的按压不该再被当成「点空白关闭」。 */
const IMAGE_ZOOM_CLICK_SUPPRESSION_MS = 420;

type TrackedPointer = { x: number; y: number };

type TapState = { pointerId: number; x: number; y: number; pointerType: string; moved: boolean };

type PinchState = {
  kind: "pinch";
  /** 上一次移动时的双指距离与中点；每次移动就地推进，不跨帧保留起点。 */
  distance: number;
  midX: number;
  midY: number;
  /** 上一次移动后的变换，即本次移动的起点。 */
  transform: ImageZoomTransform;
};

type PanState = {
  kind: "pan";
  pointerId: number;
  startX: number;
  startY: number;
  startTransform: ImageZoomTransform;
  moved: boolean;
};

type ZoomGesture = PinchState | PanState;

/** 指针捕获只是增强：合成事件与已结束的指针在部分 WebView 上会抛 `NotFoundError`。 */
function capturePointer(element: HTMLElement, pointerId: number): void {
  try {
    if (!element.hasPointerCapture(pointerId)) element.setPointerCapture(pointerId);
  } catch {
    // 没有捕获也能继续：事件本来就落在满屏弹层里。
  }
}

/**
 * 滚轮与键盘的最小输入形状。
 *
 * 用结构类型而不是 React 事件：滚轮必须从原生非 passive 监听器进来（React 代理在根节点上
 * 是 passive 的，`preventDefault` 不生效），键盘则来自弹层的 React 处理器。
 */
type ImageZoomWheelInput = {
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
};

type ImageZoomKeyInput = { key: string; target: EventTarget | null };

export type UseImageZoomOptions = {
  /** 当前图片下标。图片按该下标带 `data-image-index` 标记，见 `ImageViewer`。 */
  index: number;
};

/**
 * 图片查看器的双指缩放、双击放大与放大后的平移。
 *
 * 与 `useHorizontalSwipe` 共用同一串指针事件，因此每个处理器都返回「本轮是否认领该
 * 事件」：调用方据此决定要不要继续喂给翻页手势。认领规则：
 *
 * - 第一根手指必须落在图片上（按几何判断，见下）：落到空白处的点按仍是「关闭查看器」，
 *   落到按钮上的按压归按钮。
 * - 两根及以上手指 → 双指缩放。第二根按下时立即认领，早于横滑的 10px 锁定，
 *   因此双指永远优先于翻页；调用方同时停用横滑，把手势中途的条带停回当前图。
 * - 已放大时的单指 → 平移图片，横向拖动不再翻页。
 * - 未放大时的单指 → 不认领，翻页照旧；只登记点按，用于双击放大。
 *
 * 命中按几何判断而不是 `event.target`：触屏上图片不参与命中测试的规则
 * （`styles.css` 的粗指针段）随时可能覆盖到查看器，而 pointer capture 也会把
 * `target` 改写成捕获元素；几何判断在两种情况下都成立。
 *
 * 变换直接写在 `<img>` 的 `transform` 上（与页签条带同一做法）：拖动期间逐帧写内联
 * 样式、松手交给 Web Animations，React 提交不参与每一帧。只有「是否放大」与「是否
 * 处于多指手势」两个布尔进 React 状态：前者决定命中与平移接管，后者在双指期间停用
 * 翻页。
 */
export function useImageZoom({ index }: UseImageZoomOptions) {
  /**
   * 弹层节点。
   *
   * 由 hook 自己持有：它既是平移边界的基准与查找图片的根，又是原生 wheel 监听的目标，
   * 而 JSX 的 `ref` 只能出现一次 —— 让调用方再合一次 ref 只是把这份所有权摊成两处。
   */
  const viewportRef = useRef<HTMLElement | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [multiTouch, setMultiTouch] = useState(false);
  const [dragging, setDragging] = useState(false);
  const zoomedRef = useRef(false);
  const multiTouchRef = useRef(false);
  const draggingRef = useRef(false);
  /** 已提交的变换；收尾动画途中它表示动画终点，实时值从计算样式读。 */
  const transformRef = useRef<ImageZoomTransform>(IMAGE_ZOOM_IDENTITY);
  const animationRef = useRef<Animation | null>(null);
  const pointersRef = useRef(new Map<number, TrackedPointer>());
  const gestureRef = useRef<ZoomGesture | null>(null);
  const tapRef = useRef<TapState | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; time: number } | null>(null);
  /** 最近一次按下的指针类型：原生 `dblclick` 只认鼠标那一路。 */
  const lastPointerTypeRef = useRef("");
  const suppressClickUntilRef = useRef(0);
  /** 滚轮/触控板捏合的收口计时器：事件成串到达，停手后才收一次。 */
  const wheelIdleTimerRef = useRef<number | null>(null);

  /**
   * 当前图片元素。
   *
   * 按标记现查而不是存 ref 数组：图片挂在同一条不重挂的条带上，回调 ref 在兄弟
   * 节点间交接会经过一个空窗，而手势恰好在 React 提交之间读图元时就会读到空。
   */
  const image = useCallback(() => {
    const viewport = viewportRef.current;
    return viewport?.querySelector<HTMLImageElement>(`[data-image-index="${index}"]`) ?? null;
  }, [index, viewportRef]);

  const commitZoomedState = useCallback((transform: ImageZoomTransform) => {
    const next = !imageZoomIsIdentity(transform);
    if (zoomedRef.current === next) return;
    zoomedRef.current = next;
    setZoomed(next);
  }, []);

  const commitMultiTouch = useCallback((next: boolean) => {
    if (multiTouchRef.current === next) return;
    multiTouchRef.current = next;
    setMultiTouch(next);
  }, []);

  const commitDragging = useCallback((next: boolean) => {
    if (draggingRef.current === next) return;
    draggingRef.current = next;
    setDragging(next);
  }, []);

  /** 写内联变换并把「是否放大」同步给 React。恒等值写成空串，不留无谓的合成层。 */
  const writeTransform = useCallback(
    (transform: ImageZoomTransform) => {
      transformRef.current = transform;
      const element = image();
      if (element) {
        const identity = imageZoomIsIdentity(transform);
        element.style.transform = identity ? "" : formatImageZoomTransform(transform);
        // 合成层只在缩放期间需要：静止时留在常规绘制里，避免高清图常驻显存。
        element.style.willChange = identity ? "" : "transform";
      }
      commitZoomedState(transform);
    },
    [commitZoomedState, image],
  );

  /** 动画途中从计算样式取实时变换；没有动画时就是记账值。 */
  const liveTransform = useCallback((): ImageZoomTransform => {
    const element = image();
    if (!element || !animationRef.current) return transformRef.current;
    const computed = window.getComputedStyle(element).transform;
    if (!computed || computed === "none") return transformRef.current;
    try {
      const matrix = new DOMMatrixReadOnly(computed);
      return { scale: matrix.a, x: matrix.e, y: matrix.f };
    } catch {
      return transformRef.current;
    }
  }, [image]);

  /**
   * 从收尾动画手里接管当前画面：把实时变换固化成内联样式。新手势必须从手指底下
   * 那一帧继续，而不是跳回动画终点或起点。
   */
  const takeOverLiveTransform = useCallback((): ImageZoomTransform => {
    const animation = animationRef.current;
    if (!animation) return transformRef.current;
    const stoppedAt = liveTransform();
    animationRef.current = null;
    animation.cancel();
    transformRef.current = stoppedAt;
    const element = image();
    if (element) element.style.transform = formatImageZoomTransform(stoppedAt);
    return stoppedAt;
  }, [image, liveTransform]);

  /** 把剩余行程交给合成器；`fill: both` 保证第一帧不闪回旧变换。 */
  const settleTo = useCallback(
    (target: ImageZoomTransform, duration: number) => {
      const element = image();
      if (!element) return;
      const from = takeOverLiveTransform();
      transformRef.current = target;
      // 放大要立刻锁住翻页；缩回适配尺寸则等动画跑完再解锁，
      // 否则横滑会在图片还在缩小的途中接管条带。
      if (!imageZoomIsIdentity(target)) commitZoomedState(target);
      if (
        duration <= 0 ||
        prefersReducedMotion() ||
        (from.scale === target.scale && from.x === target.x && from.y === target.y)
      ) {
        writeTransform(target);
        return;
      }
      const animation = element.animate(
        [
          { transform: formatImageZoomTransform(from) },
          { transform: formatImageZoomTransform(target) },
        ],
        { duration, easing: SWIPE_SETTLE_EASING, fill: "both" },
      );
      animationRef.current = animation;
      void animation.finished
        .then(() => {
          if (animationRef.current !== animation) return;
          animationRef.current = null;
          // 先写内联样式再取消动画：顺序颠倒会让部分 Android 合成器画出一帧未变换的层。
          writeTransform(target);
          animation.cancel();
        })
        .catch(() => {
          // 新手势或复位打断时预期会取消。
        });
    },
    [commitZoomedState, image, takeOverLiveTransform, writeTransform],
  );

  /** 当前图片是否覆盖该点（含已生效的缩放与平移）。 */
  const hitTestImage = useCallback(
    (x: number, y: number): boolean => {
      const element = image();
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return false;
      return imageZoomRectContains(rect, x, y);
    },
    [image],
  );

  /** 图片与视口几何；图片还没解码出尺寸时返回 null，本次手势不参与。 */
  const geometry = useCallback((): ImageZoomGeometry | null => {
    const element = image();
    const viewport = viewportRef.current;
    if (!element || !viewport) return null;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const viewportRect = viewport.getBoundingClientRect();
    if (!(width > 0) || !(height > 0) || !(viewportRect.width > 0) || !(viewportRect.height > 0)) {
      return null;
    }
    // 中心取图片所在页的中心而不是图片自身的 rect：rect 带缩放后的尺寸，而变换的
    // 基准是未变换的布局中心。页与视口同高，横向由条带平移，读数始终有效。
    const pageRect = (element.parentElement ?? element).getBoundingClientRect();
    return {
      width,
      height,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
      centerX: pageRect.left + pageRect.width / 2,
      centerY: pageRect.top + pageRect.height / 2,
    };
  }, [image, viewportRef]);

  /**
   * 以某点为锚点设到指定倍率，立即生效（不补间）。
   *
   * 滚轮与触控板捏合走这里：它们的输入本身就是连续小步，逐事件补间只会互相打断；
   * 停手之后由 `applyReleasedTransform` 统一收口。
   */
  const zoomAtPoint = useCallback(
    (scale: number, x: number, y: number): boolean => {
      const measured = geometry();
      if (!measured) return false;
      const current = takeOverLiveTransform();
      writeTransform(
        clampImageZoomTransform(
          imageZoomAnchorTransform(measured, current, scale, { x, y }, { x, y }),
          measured,
        ),
      );
      return true;
    },
    [geometry, takeOverLiveTransform, writeTransform],
  );

  /** 手指离开后的收口：几乎没放大的残留直接归位，否则只做范围修正。 */
  const applyReleasedTransform = useCallback(() => {
    suppressClickUntilRef.current = Date.now() + IMAGE_ZOOM_CLICK_SUPPRESSION_MS;
    const measured = geometry();
    const current = transformRef.current;
    // 几何不可用时至少把「几乎没放大」的残留收干净，别把半程缩放的合成层留下。
    const target = measured
      ? imageZoomReleasedTransform(current, measured)
      : imageZoomIsIdentity(current)
        ? IMAGE_ZOOM_IDENTITY
        : current;
    settleTo(target, IMAGE_ZOOM_SETTLE_MS);
  }, [geometry, settleTo]);

  /**
   * 双指移动：以上一次移动为基准推进，而不是把整段手势积到起点。
   *
   * 逐次推进让倍率与位移都按当前帧比例累积，手指停下时的舍入不会攒成可见的漂移；
   * 三指变双指、第二根手指中途换位这类手指数变化也随之自然成立 —— 每帧拿到的
   * 都是「这一刻的两指关系」，没有需要重设的起点快照。
   */
  const updatePinch = useCallback(() => {
    const pinch = gestureRef.current;
    if (!pinch || pinch.kind !== "pinch") return;
    const pointers = [...pointersRef.current.values()];
    if (pointers.length < 2) return;
    const measured = geometry();
    if (!measured) return;
    const [first, second] = pointers as [TrackedPointer, TrackedPointer];
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    const midX = (first.x + second.x) / 2;
    const midY = (first.y + second.y) / 2;
    const scale = pinch.transform.scale * (distance / Math.max(1, pinch.distance));
    const next = clampImageZoomTransform(
      imageZoomAnchorTransform(
        measured,
        pinch.transform,
        scale,
        { x: pinch.midX, y: pinch.midY },
        { x: midX, y: midY },
      ),
      measured,
    );
    // 钳制后的实际值才是下一次移动的起点：否则越过边界继续捏合会在回拉时先
    // 走完「看不见的余量」，读作迟滞。
    pinch.distance = distance;
    pinch.midX = midX;
    pinch.midY = midY;
    pinch.transform = next;
    writeTransform(next);
  }, [geometry, writeTransform]);

  /** 手指数变化后以当前帧重设双指基准，画面不跳。 */
  const reanchorPinch = useCallback(() => {
    const pinch = gestureRef.current;
    if (!pinch || pinch.kind !== "pinch") return;
    const pointers = [...pointersRef.current.values()];
    if (pointers.length < 2) return;
    const [first, second] = pointers as [TrackedPointer, TrackedPointer];
    pinch.distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    pinch.midX = (first.x + second.x) / 2;
    pinch.midY = (first.y + second.y) / 2;
    pinch.transform = takeOverLiveTransform();
  }, [takeOverLiveTransform]);

  const beginPinch = useCallback((): boolean => {
    const pointers = [...pointersRef.current.values()];
    if (pointers.length < 2) return false;
    const [first, second] = pointers as [TrackedPointer, TrackedPointer];
    gestureRef.current = {
      kind: "pinch",
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      midX: (first.x + second.x) / 2,
      midY: (first.y + second.y) / 2,
      transform: takeOverLiveTransform(),
    };
    tapRef.current = null;
    commitMultiTouch(true);
    return true;
  }, [commitMultiTouch, takeOverLiveTransform]);

  /** 双指落回单指时接上平移，免得松手瞬间跳回缩放前的位置。 */
  const handOffToPan = useCallback(() => {
    const remaining = [...pointersRef.current.entries()][0];
    if (!remaining) {
      gestureRef.current = null;
      commitMultiTouch(false);
      applyReleasedTransform();
      return;
    }
    gestureRef.current = {
      kind: "pan",
      pointerId: remaining[0],
      startX: remaining[1].x,
      startY: remaining[1].y,
      startTransform: takeOverLiveTransform(),
      // 从双指接管过来的单指不再算点按，抬手只做范围收口。
      moved: true,
    };
  }, [applyReleasedTransform, commitMultiTouch, takeOverLiveTransform]);

  const movePan = useCallback(
    (event: { pointerId: number; clientX: number; clientY: number }) => {
      const pan = gestureRef.current;
      if (!pan || pan.kind !== "pan" || pan.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - pan.startX;
      const deltaY = event.clientY - pan.startY;
      if (!pan.moved) {
        if (Math.hypot(deltaX, deltaY) < IMAGE_ZOOM_TAP_SLOP_PX) return;
        pan.moved = true;
        commitDragging(true);
      }
      const measured = geometry();
      if (!measured) return;
      writeTransform(
        clampImageZoomTransform(
          {
            scale: pan.startTransform.scale,
            x: pan.startTransform.x + deltaX,
            y: pan.startTransform.y + deltaY,
          },
          measured,
        ),
      );
    },
    [commitDragging, geometry, writeTransform],
  );

  /** 双击：已放大则回到适配尺寸，否则放大到落点并让它停在手指底下。 */
  const doubleTap = useCallback(
    (x: number, y: number): boolean => {
      const measured = geometry();
      if (!measured) return false;
      const current = takeOverLiveTransform();
      // 双击会被系统补发一次 click，而落点在图外时「点空白关闭」就会把查看器一并关掉。
      suppressClickUntilRef.current = Date.now() + IMAGE_ZOOM_CLICK_SUPPRESSION_MS;
      if (current.scale > 1) {
        settleTo(IMAGE_ZOOM_IDENTITY, IMAGE_ZOOM_SETTLE_MS);
        return true;
      }
      settleTo(
        clampImageZoomTransform(
          imageZoomAnchorTransform(
            measured,
            current,
            IMAGE_ZOOM_DOUBLE_TAP_SCALE,
            { x, y },
            { x, y },
          ),
          measured,
        ),
        motionProfile().enter.duration * 1000,
      );
      return true;
    },
    [geometry, settleTo, takeOverLiveTransform],
  );

  /**
   * 点按结算：两次点按落在同一点上才算双击。
   *
   * 鼠标不在这里配对：系统双击间隔可以大于这里的窗口，原生 `dblclick` 才是权威，
   * 两边都处理会在慢速双击上变成「放大又立刻缩回」。
   */
  const registerTap = useCallback(
    (tap: TapState, x: number, y: number): boolean => {
      if (tap.moved || tap.pointerType === "mouse") {
        lastTapRef.current = null;
        return false;
      }
      const now = performance.now();
      const previous = lastTapRef.current;
      const isDoubleTap =
        previous !== null &&
        now - previous.time <= IMAGE_ZOOM_DOUBLE_TAP_INTERVAL_MS &&
        Math.hypot(x - previous.x, y - previous.y) <= IMAGE_ZOOM_DOUBLE_TAP_SLOP_PX;
      if (!isDoubleTap) {
        lastTapRef.current = { x, y, time: now };
        return false;
      }
      lastTapRef.current = null;
      return doubleTap(x, y);
    },
    [doubleTap],
  );

  /** 在当前手指/指针位置启动一次平移（放大态的单指与鼠标左键共用）。 */
  const beginPan = useCallback(
    (pointerId: number, x: number, y: number): boolean => {
      // 几何不可用时不认领：宁可让出事件，也不要吞掉这次点按。
      if (!geometry()) return false;
      gestureRef.current = {
        kind: "pan",
        pointerId,
        startX: x,
        startY: y,
        startTransform: takeOverLiveTransform(),
        moved: false,
      };
      return true;
    },
    [geometry, takeOverLiveTransform],
  );

  /** 指针结束（含窗口级的兜底）。返回该事件是否属于缩放层。 */
  const finishPointer = useCallback(
    (pointerId: number, x: number, y: number, cancelled: boolean): boolean => {
      if (!pointersRef.current.has(pointerId)) return false;
      pointersRef.current.delete(pointerId);
      const viewport = viewportRef.current;
      if (viewport?.hasPointerCapture(pointerId)) {
        try {
          viewport.releasePointerCapture(pointerId);
        } catch {
          // 指针已经结束：无需释放。
        }
      }

      const gesture = gestureRef.current;
      if (gesture?.kind === "pinch") {
        // 三指变两指要换基准，双指变单指直接接上平移，
        // 都不能让画面在松手瞬间跳一下。
        if (pointersRef.current.size >= 2) {
          reanchorPinch();
          return true;
        }
        tapRef.current = null;
        handOffToPan();
        return true;
      }

      if (gesture?.kind === "pan" && gesture.pointerId === pointerId) {
        const tap = tapRef.current;
        tapRef.current = null;
        gestureRef.current = null;
        commitDragging(false);
        commitMultiTouch(false);
        if (!cancelled && !gesture.moved && tap && registerTap(tap, x, y)) return true;
        applyReleasedTransform();
        return true;
      }

      const tap = tapRef.current;
      tapRef.current = null;
      if (cancelled || !tap || tap.pointerId !== pointerId) return false;
      // 未认领的按压继续交给翻页手势收尾。
      registerTap(tap, x, y);
      return false;
    },
    [
      applyReleasedTransform,
      commitDragging,
      commitMultiTouch,
      handOffToPan,
      reanchorPinch,
      registerTap,
    ],
  );

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      lastPointerTypeRef.current = event.pointerType;
      // 鼠标只认主键：右键与中键不参与缩放。
      if (event.pointerType === "mouse" && event.button !== 0) return false;
      // 手势必须从图片上开始：落到空白处的点按仍是「关闭查看器」，
      // 落到按钮上的按压归按钮（第二根及以后的手指不再判目标，捏合允许落在图外）。
      if (pointersRef.current.size === 0) {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("button")) return false;
        if (!hitTestImage(event.clientX, event.clientY)) return false;
      }

      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // 触摸本来就有隐式捕获；鼠标没有，拖到弹层外（甚至窗口外）就会丢掉移动事件。
      if (event.pointerType === "mouse") capturePointer(event.currentTarget, event.pointerId);

      if (pointersRef.current.size >= 2) {
        if (gestureRef.current?.kind === "pinch") {
          reanchorPinch();
          return true;
        }
        return beginPinch();
      }

      if (zoomedRef.current && !beginPan(event.pointerId, event.clientX, event.clientY)) {
        return false;
      }
      tapRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pointerType: event.pointerType,
        moved: false,
      };
      // 未放大时不认领，让翻页手势同时看到这次按压。
      return gestureRef.current?.kind === "pan";
    },
    [beginPan, beginPinch, hitTestImage, reanchorPinch],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      const pointer = pointersRef.current.get(event.pointerId);
      if (!pointer) return false;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      const gesture = gestureRef.current;
      if (gesture?.kind === "pinch") {
        updatePinch();
        return true;
      }
      if (gesture?.kind === "pan" && gesture.pointerId === event.pointerId) {
        movePan(event);
        return true;
      }
      const tap = tapRef.current;
      if (tap && tap.pointerId === event.pointerId && !tap.moved) {
        // 超过容差就不再是点按：翻页的锁定距离与它同档，两者不会互相误判。
        if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > IMAGE_ZOOM_TAP_SLOP_PX) {
          tap.moved = true;
        }
      }
      return false;
    },
    [movePan, updatePinch],
  );

  const onPointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) =>
      finishPointer(event.pointerId, event.clientX, event.clientY, false),
    [finishPointer],
  );

  const onPointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) =>
      finishPointer(event.pointerId, event.clientX, event.clientY, true),
    [finishPointer],
  );

  const clearWheelIdle = useCallback(() => {
    if (wheelIdleTimerRef.current === null) return;
    window.clearTimeout(wheelIdleTimerRef.current);
    wheelIdleTimerRef.current = null;
  }, []);

  /**
   * 滚轮与触控板捏合。
   *
   * 触控板捏合在浏览器里就是 `ctrl + wheel`（每个事件 delta 只有个位数），
   * 鼠标滚轮则是 `deltaY` 约 `100` 一格：两者共用这一条通路，按 `ctrlKey` 分档灵敏度。
   * 缩放锚点取指针位置，滚轮因此读作「放大指针底下的那块」。
   *
   * 事件成串到达，逐事件补间会互相打断成抖动，所以直接写变换；停手
   * `IMAGE_ZOOM_WHEEL_IDLE_MS` 之后再由 `applyReleasedTransform` 收口一次。
   * 未放大时向下的滚轮不做任何事，翻页与关闭手势都不受影响。
   */
  const onWheel = useCallback(
    (event: ImageZoomWheelInput): boolean => {
      if (event.deltaY === 0) return false;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button")) return false;
      // 弹层是满屏模态：滚轮一律由它消费，不能让底下的页面跟着滚。
      const overImage = hitTestImage(event.clientX, event.clientY);
      const current = transformRef.current.scale;
      const next = imageZoomWheelScale(current, event.deltaY, event.deltaMode, event.ctrlKey);
      // 指针在图外，或已顶在倍率边界：只吃掉事件，不做任何变换与收口。
      if (!overImage || next === current) return true;
      if (!zoomAtPoint(next, event.clientX, event.clientY)) return true;
      // 成串的滚轮事件期间不起收尾：逐事件补间只会互相打断成抖动。
      if (wheelIdleTimerRef.current !== null) window.clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = window.setTimeout(() => {
        wheelIdleTimerRef.current = null;
        applyReleasedTransform();
      }, IMAGE_ZOOM_WHEEL_IDLE_MS);
      return true;
    },
    [applyReleasedTransform, hitTestImage, zoomAtPoint],
  );

  /**
   * 挂到弹层上的回调 ref：记录节点，并挂原生 wheel 监听。
   *
   * 不用 React 的 `onWheel`：React 在根节点上用 passive 监听器代理它，
   * `preventDefault` 无效，满屏弹层底下的页面会跟着一起滚。非 passive 的原生监听器
   * 才能真正吞掉它。返回清理函数，React 会在卸载与节点更换时调用。
   */
  const bindViewport = useCallback(
    (node: HTMLElement | null) => {
      viewportRef.current = node;
      if (!node) return;
      const handle = (event: WheelEvent) => {
        if (!onWheel(event)) return;
        event.preventDefault();
      };
      node.addEventListener("wheel", handle, { passive: false });
      return () => {
        node.removeEventListener("wheel", handle);
        if (viewportRef.current === node) viewportRef.current = null;
      };
    },
    [onWheel],
  );

  /**
   * 键盘缩放：`+` / `=` 放大、`-` / `_` 缩小、`0` 复位。
   *
   * 与方向键换图同一层（都挂在弹层上）。锚点取视口中心：键盘没有指针位置，
   * 中心是唯一读得通的落点。
   */
  const onKeyDown = useCallback(
    (event: ImageZoomKeyInput): boolean => {
      const key = event.key;
      if (key !== "+" && key !== "=" && key !== "-" && key !== "_" && key !== "0") return false;
      // 输入框里的这些键归输入框自己。
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return false;
      const viewport = viewportRef.current;
      if (!viewport) return false;
      const viewportRect = viewport.getBoundingClientRect();
      const x = viewportRect.left + viewportRect.width / 2;
      const y = viewportRect.top + viewportRect.height / 2;
      if (key === "0") {
        const measured = geometry();
        if (!measured) return false;
        settleTo(IMAGE_ZOOM_IDENTITY, IMAGE_ZOOM_SETTLE_MS);
        return true;
      }
      const next = imageZoomStepScale(transformRef.current.scale, key === "+" || key === "=" ? 1 : -1);
      if (next === transformRef.current.scale) {
        // 已在边界：仍然吃掉按键，免得它继续传给页面。
        return true;
      }
      if (!zoomAtPoint(next, x, y)) return false;
      // 键盘是一次一步的离散动作，直接收口到合法范围。
      applyReleasedTransform();
      return true;
    },
    [applyReleasedTransform, geometry, settleTo, viewportRef, zoomAtPoint],
  );

  /**
   * 原生 `dblclick`（鼠标一路）。触屏的双击由上面的点按配对处理：两种输入模态的
   * 双击间隔设置不同，各用各自的权威判定，不会互相叠加成两次切换。
   */
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>): boolean => {
      if (lastPointerTypeRef.current !== "mouse") return false;
      if (!hitTestImage(event.clientX, event.clientY)) return false;
      return doubleTap(event.clientX, event.clientY);
    },
    [doubleTap, hitTestImage],
  );

  /** 缩放后的点按抑制：Android 在双指/拖动/双击之后仍可能补发一次 click。 */
  const suppressClick = useCallback((now = Date.now()) => now < suppressClickUntilRef.current, []);

  const onClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>): boolean => {
      if (!suppressClick()) return false;
      // 按钮不受抑制：缩放手势结束后紧接着按关闭/翻页按钮必须是有效的。
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button")) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
    [suppressClick],
  );

  /**
   * 换图或外部复位：清掉每张图片的变换与在手手势，不动画。
   *
   * 复位跟随 `index`：图片挂在同一条条带上，换图不重挂节点，上一张的缩放若不在这里
   * 清掉就会跟着条带一起带到下一张。
   */
  const resetZoom = useCallback(() => {
    clearWheelIdle();
    const animation = animationRef.current;
    animationRef.current = null;
    animation?.cancel();
    pointersRef.current.clear();
    gestureRef.current = null;
    tapRef.current = null;
    lastTapRef.current = null;
    commitDragging(false);
    commitMultiTouch(false);
    const viewport = viewportRef.current;
    if (viewport) {
      for (const element of viewport.querySelectorAll("img")) {
        element.style.transform = "";
        element.style.willChange = "";
      }
    }
    writeTransform(IMAGE_ZOOM_IDENTITY);
  }, [clearWheelIdle, commitDragging, commitMultiTouch, viewportRef, writeTransform]);

  // 布局阶段复位：换图是同一条不重挂的条带，等到 paint 后再清会让上一张的缩放
  // 跟着条带闪一帧。
  useLayoutEffect(() => {
    resetZoom();
  }, [index, resetZoom]);

  /**
   * 窗口级兜底：手指在弹层外结束（拖出窗口、系统把手势收走）时补齐收尾，
   * 免得把一个半程缩放永久留在图上。挂冒泡阶段，让弹层自己的处理器先跑。
   */
  useEffect(() => {
    const onEnd = (event: PointerEvent) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      finishPointer(event.pointerId, event.clientX, event.clientY, event.type === "pointercancel");
    };
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [finishPointer]);

  useEffect(
    () => () => {
      clearWheelIdle();
      const animation = animationRef.current;
      animationRef.current = null;
      animation?.cancel();
    },
    [clearWheelIdle],
  );

  return {
    /** 当前图片处于放大态：单指由平移接管，翻页手势停用。 */
    zoomed,
    /** 多指手势进行中（含双指松手后接续的单指平移）：翻页手势必须停手。 */
    multiTouch,
    /** 正在拖动图片（任一指针）：用于把光标换成「抓取中」。 */
    dragging,
    /** 该点是否落在当前图片上；弹层的「点空白关闭」据此判定。 */
    hitTestImage,
    /** 刚结束缩放手势的短暂窗口：此问的 click 不是「点空白关闭」。 */
    suppressClick,
    onClickCapture,
    onDoubleClick,
    bindViewport,
    onKeyDown,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
  };
}
