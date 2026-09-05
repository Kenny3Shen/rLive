import { useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn, normalizeImageUrl } from "@/lib/utils";

type ImageViewerProps = {
  images: string[];
  initialIndex?: number;
  onClose: () => void;
};

/**
 * 全屏图片查看器，支持左右切换与关闭。
 * 点击遮罩关闭，点击图片本身不关闭。
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

  const handlePrevious = () => {
    setCurrentIndex((index) => (index > 0 ? index - 1 : images.length - 1));
  };

  const handleNext = () => {
    setCurrentIndex((index) => (index < images.length - 1 ? index + 1 : 0));
  };

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
          className="inset-0 flex items-center justify-center"
          // 点空白处关闭；图片与按钮上的点击落在子元素上，不会命中这里。
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
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
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "absolute left-4 top-1/2 z-10 -translate-y-1/2 text-white hover:bg-white/10",
                  currentIndex === 0 && "opacity-50",
                )}
                onClick={handlePrevious}
                aria-label="上一张"
              >
                <ChevronLeft className="size-6" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "absolute right-4 top-1/2 z-10 -translate-y-1/2 text-white hover:bg-white/10",
                  currentIndex === images.length - 1 && "opacity-50",
                )}
                onClick={handleNext}
                aria-label="下一张"
              >
                <ChevronRight className="size-6" />
              </Button>
            </>
          )}

          {/* 图片 */}
          <img
            src={normalizeImageUrl(images[currentIndex])}
            alt=""
            className="max-h-[90vh] max-w-[90vw] object-contain"
          />

          {/* 图片计数 */}
          {images.length > 1 && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white">
              {currentIndex + 1} / {images.length}
            </div>
          )}
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
