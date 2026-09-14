import { useMemo, useState } from "react";
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
 * 全屏图片查看器，支持左右切换与关闭。
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

  // 条带按绝对下标定位，因此下标本身就是 items。稳定引用：换一次数组就会让
  // 依赖它的效果重跑并把条带重新停靠一次。
  const indexes = useMemo(() => images.map((_, index) => index), [images]);
  const canSwipe = images.length > 1;
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

  const goToAdjacent = (delta: -1 | 1) => {
    setCurrentIndex((index) => {
      const next = index + delta;
      return next < 0 || next >= images.length ? index : next;
    });
  };

  const handlePrevious = () => goToAdjacent(-1);

  const handleNext = () => goToAdjacent(1);

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
          data-horizontal-swipe-surface
          // `touch-pan-y` 把横向运动交给手势、纵向留给系统，与页签条带一致。
          className="inset-0 flex items-center justify-center touch-pan-y"
          onPointerDownCapture={onPointerDownCapture}
          onPointerMoveCapture={onPointerMoveCapture}
          onPointerUpCapture={onPointerUpCapture}
          onPointerCancelCapture={onPointerCancelCapture}
          onClickCapture={onClickCapture}
          // 点图片与按钮之外的区域关闭。条带铺满整个弹层，
          // 因此不能再拿 `target === currentTarget` 判断 —— 空白处命中的是条带，
          // 不是弹层本身。
          onClick={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("img, button")) return;
            setOpen(false);
          }}
          onKeyDown={(event) => {
            if (images.length < 2) return;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              handlePrevious();
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              handleNext();
            }
          }}
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
              {images.map((src) => (
                <div
                  key={src}
                  className="flex h-full shrink-0 items-center justify-center"
                  style={{ width: `${100 / images.length}%` }}
                >
                  <img
                    src={normalizeImageUrl(src)}
                    alt=""
                    // 关掉原生图片拖拽：它会抢走横向手势，让图片跟着指针乱跑。
                    draggable={false}
                    className="max-h-[90vh] max-w-[90vw] object-contain"
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
