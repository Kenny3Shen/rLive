import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHorizontalSwipe } from "@/shared/hooks/useHorizontalSwipe";
import { useImageZoom } from "@/shared/hooks/useImageZoom";
import { cn, normalizeImageUrl } from "@/lib/utils";

type ImageViewerProps = {
  images: string[];
  initialIndex?: number;
  onClose: () => void;
};

/** 左右切换按钮的公共画法：贴屏幕边缘、首/尾张减淡提示不可再翻。 */
function NavButton({
  label,
  icon: Icon,
  side,
  dimmed,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  side: "left" | "right";
  dimmed: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn(
        "absolute top-1/2 z-10 -translate-y-1/2 text-white hover:bg-white/10",
        side === "left" ? "left-4" : "right-4",
        dimmed && "opacity-50",
      )}
      onClick={onClick}
      aria-label={label}
    >
      <Icon className="size-6" />
    </Button>
  );
}

/**
 * 全屏图片查看器，支持缩放、平移、左右切换与关闭。
 *
 * 手势分两层，共用同一串指针事件，由本组件的合成处理器决定谁认领：
 *
 * - **缩放层**（`useImageZoom`）：触屏用双指捏合、双击与单指平移；桌面用滚轮 /
 *   触控板捏合 / `+` `-` `0` 键缩放、双击切换、放大后左键拖动。落点都从手指（或
 *   指针）底下那一帧接管，图片跟着输入动。
 * - **翻页层**（`useHorizontalSwipe`）：未放大时的横向滑动切图；桌面另有左右方向键
 *   与两侧按钮，三者边界语义一致。
 *
 * 两层的分界就是「是否放大」与「是否多指」：放大后横向拖动改为平移图片，
 * 双指则永远优先于翻页（第二根手指按下即认领，早于横滑的 10px 锁定）。
 * 翻页手势在缩放期间整段停用，因此条带不会在捏合中途被横滑拖走。
 *
 * 弹层用 `touch-none` 而不是 `touch-pan-y`：手势全部由上面两层处理，交给浏览器
 * 只会换来原生页面缩放（把整个界面连遮罩一起放大）与随之而来的 pointercancel。
 * 触屏上的图片同样不参与命中测试（见 `styles.css` 的粗指针规则），避免 Android
 * WebView 的长按图片菜单接管手势 —— 手势命中按几何判断，不依赖 `event.target`。
 *
 * 多图时三种翻页方式落在同一套 items 与同一种边界语义上：横向滑动、左右按钮、
 * 方向键都停在首/尾不环绕 —— 那里按钮已经是减淡的「不可再翻」样子，
 * 从第一张跳到最后一张既不吻合视觉暗示，也会让条带扫过整排图片。
 * 点击图片与按钮之外的区域关闭。
 *
 * 图片排在一条 `layout: "track"` 的横向条带上 —— 与页签条带同一套手势、
 * 同一条收尾曲线。刻意选 `track` 而不是只画当前一张：相邻图片此时已经挂载并
 * 解码完成，手指底下是真实的图片在平移，而不是先滑走旧图、等新图下载完再
 * 补一段动画。评论区的图片在打开查看器前已经以缩略图加载过同一 URL，
 * 多渲染几张命中缓存，代价可忽略。
 *
 * 走 Dialog 原语而不是自己画一层 `fixed inset-0 z-50`：调用点长在播放页右侧栏
 * （`relative isolate`）和评论详情抽屉的挂载点（`contain: layout paint`）里，
 * 自画的浮层会被困在那两个层叠上下文内 —— 播放器控制条与 HUD（z-30）、顶栏工具
 * （z-10）会压在图片之上，抽屉里打开时还会被裁进侧栏的方框。portal 到 body 之后
 * 顺带拿到 base-ui 的嵌套语义：从抽屉里打开时点查看器不再被抽屉当作外部点击，
 * Esc 与 Android 返回键也只关最上面这一层。
 */
export function ImageViewer({ images, initialIndex = 0, onClose }: ImageViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [open, setOpen] = useState(true);
  const {
    zoomed,
    multiTouch,
    dragging,
    bindViewport,
    onKeyDown: onZoomKeyDown,
    hitTestImage,
    suppressClick,
    onClickCapture: onZoomClickCapture,
    onDoubleClick: onZoomDoubleClick,
    onPointerDownCapture: onZoomPointerDownCapture,
    onPointerMoveCapture: onZoomPointerMoveCapture,
    onPointerUpCapture: onZoomPointerUpCapture,
    onPointerCancelCapture: onZoomPointerCancelCapture,
  } = useImageZoom({ index: currentIndex });

  // 光标反馈：放大后单指/左键就是拖动，鼠标端据此给出可操作性暗示。
  const cursorClass = zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : null;

  // 条带按绝对下标定位，因此下标本身就是 items。稳定引用：换一次数组就会让
  // 依赖它的效果重跑并把条带重新停靠一次。
  const indexes = useMemo(() => images.map((_, index) => index), [images]);
  // 放大或多指期间停用翻页：横向拖动此时属于图片平移，捏合更不能被条带抢走。
  const canSwipe = images.length > 1 && !zoomed && !multiTouch;
  const {
    bindPage,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    onClickCapture,
  } = useHorizontalSwipe({
    items: indexes,
    value: currentIndex,
    onChange: setCurrentIndex,
    enabled: canSwipe,
    layout: "track",
  });

  const goToAdjacent = useCallback(
    (delta: -1 | 1) => {
      setCurrentIndex((index) => {
        const next = index + delta;
        return next < 0 || next >= images.length ? index : next;
      });
    },
    [images.length],
  );

  const handlePrevious = useCallback(() => goToAdjacent(-1), [goToAdjacent]);

  const handleNext = useCallback(() => goToAdjacent(1), [goToAdjacent]);

  /**
   * 缩放与翻页的合成：缩放层先认领，认领到的事件不再落到翻页层。
   *
   * 未认领时照旧转交翻页层 —— 点按的收尾、横滑的锁定都还要靠它，
   * 因此这里不能按「是否处于放大态」把两层整段隔开。
   *
   * 一律不 `stopPropagation`：base-ui 的外部点击判定挂在 document 上，
   * 停掉冒泡会被读成「点在弹层之外」而把查看器关掉。
   */
  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 认领到就不再转交翻页层。这里刻意不 `preventDefault`：它会让部分浏览器跳过
      // 兼容鼠标事件，双击与按钮点击的事件链也跟着一起断。
      if (onZoomPointerDownCapture(event)) return;
      onPointerDownCapture?.(event);
    },
    [onPointerDownCapture, onZoomPointerDownCapture],
  );

  const handlePointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (onZoomPointerMoveCapture(event)) {
        event.preventDefault();
        return;
      }
      onPointerMoveCapture?.(event);
    },
    [onPointerMoveCapture, onZoomPointerMoveCapture],
  );

  const handlePointerUpCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 缩放层先收：它可能要把这一下结算成双击。未认领的按压继续交给翻页层收尾。
      if (onZoomPointerUpCapture(event)) return;
      onPointerUpCapture?.(event);
    },
    [onPointerUpCapture, onZoomPointerUpCapture],
  );

  const handlePointerCancelCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (onZoomPointerCancelCapture(event)) return;
      onPointerCancelCapture?.(event);
    },
    [onPointerCancelCapture, onZoomPointerCancelCapture],
  );

  const handleClickCapture = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (onZoomClickCapture(event)) return;
      onClickCapture?.(event);
    },
    [onClickCapture, onZoomClickCapture],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!onZoomDoubleClick(event)) return;
      event.preventDefault();
    },
    [onZoomDoubleClick],
  );

  /**
   * 键盘：缩放（`+` / `-` / `0`）先判，未消费的才走左右换图。
   *
   * 换图只在多图时有意义，而缩放对单图同样成立 —— 两者因此分开判断，
   * 不能笼统地用「图片是否多于一张」一起放行或一起拦下。
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (onZoomKeyDown(event)) {
        event.preventDefault();
        return;
      }
      if (images.length < 2) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        handleNext();
      }
    },
    [handleNext, handlePrevious, images.length, onZoomKeyDown],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      // 退场动画跑完再让调用方卸载，否则 `motion-dialog` 的收起样式永远没机会播。
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {/* 必须显式挂到 body：默认容器是「父级 portal 节点 ?? body」，从评论详情抽屉里
          打开时会落进侧栏的抽屉挂载点（`contain: layout paint`），满屏浮层被裁成侧栏那一条。 */}
      <DialogPortal container={document.body}>
        {/* 看图要压住背后播放中的画面：近全黑遮罩，模糊在这种不透明度下只是白花 GPU。
            `forceRender` 是必须的：base-ui 默认省掉嵌套弹层的遮罩，从评论详情抽屉里
            打开时没有它就只剩一张悬空的图。 */}
        <DialogOverlay
          forceRender
          className="bg-black/95 supports-backdrop-filter:backdrop-blur-none"
        />
        <DialogPopup
          ref={bindViewport}
          data-image-viewer
          data-horizontal-swipe-surface
          // `touch-none`：缩放、平移与翻页全部由这两层手势处理，交给浏览器只会
          // 换来原生页面缩放（连遮罩一起放大）与随之而来的 pointercancel。
          className="inset-0 flex items-center justify-center touch-none"
          onPointerDownCapture={handlePointerDownCapture}
          onPointerMoveCapture={handlePointerMoveCapture}
          onPointerUpCapture={handlePointerUpCapture}
          onPointerCancelCapture={handlePointerCancelCapture}
          onClickCapture={handleClickCapture}
          onDoubleClick={handleDoubleClick}
          // 点图片与按钮之外的区域关闭。命中按几何判断：触屏上图片不参与命中测试，
          // 条带又铺满整个弹层，`target` 既不是图片也不是弹层本身。三种情况不算关闭：
          // 落在按钮上的点按归按钮，刚结束缩放手势的那一下合成 click，以及放大态 ——
          // 那时图片不一定铺满视口，空白处的一点点击不该连带把缩放一起丢掉，
          // 退出走「双击复位」或关闭按钮。
          onClick={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("button")) return;
            if (suppressClick()) return;
            if (zoomed) return;
            if (hitTestImage(event.clientX, event.clientY)) return;
            setOpen(false);
          }}
          onKeyDown={handleKeyDown}
        >
          <DialogTitle className="sr-only">图片查看器</DialogTitle>

          {/* 关闭按钮 */}
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-4 top-4 z-10 text-white hover:bg-white/10"
                aria-label="关闭图片查看器"
              />
            }
          >
            <X className="size-5" />
          </DialogClose>

          {/* 左右切换按钮 */}
          {images.length > 1 && (
            <>
              <NavButton
                label="上一张"
                icon={ChevronLeft}
                side="left"
                dimmed={currentIndex === 0}
                onClick={handlePrevious}
              />
              <NavButton
                label="下一张"
                icon={ChevronRight}
                side="right"
                dimmed={currentIndex === images.length - 1}
                onClick={handleNext}
              />
            </>
          )}

          {/* 图片条带：所有图片并排在同一条轨道上，手势在真实图片之间平移。
              只裁剪横向轴，纵向保持可见以免裁掉高图。 */}
          <div data-slot="horizontal-swipe-viewport" className="absolute inset-0 overflow-x-clip">
            <div
              ref={bindPage}
              data-slot="horizontal-swipe-track"
              className="flex h-full items-center"
              style={{ width: `${images.length * 100}%` }}
            >
              {images.map((src, index) => (
                <div
                  key={src}
                  className="flex h-full shrink-0 items-center justify-center"
                  style={{ width: `${100 / images.length}%` }}
                >
                  <img
                    data-image-index={index}
                    src={normalizeImageUrl(src)}
                    alt=""
                    // 关掉原生图片拖拽：它会抢走横向手势，让图片跟着指针乱跑。
                    draggable={false}
                    // 缩放/平移写在这层 transform 上，`transform-origin` 保持居中：
                    // 页用 flex 居中，图片未变换时的中心与页中心重合，几何换算见
                    // `imageZoom.ts`。
                    className={cn(
                      "max-h-[90vh] max-w-[90vw] origin-center select-none object-contain",
                      // 鼠标端给出可操作性暗示：放大后单指/左键就是拖动。
                      cursorClass,
                    )}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* 图片计数 */}
          {images.length > 1 && (
            <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white">
              {currentIndex + 1} / {images.length}
            </div>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
