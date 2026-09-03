import { useEffect, useState, type MouseEvent } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { normalizeImageUrl } from "@/lib/utils";

type ImageViewerProps = {
  images: string[];
  initialIndex?: number;
  onClose: () => void;
};

/**
 * 全屏图片查看器，支持左右切换与关闭。
 * 点击遮罩关闭，点击图片本身不关闭。
 */
export function ImageViewer({ images, initialIndex = 0, onClose }: ImageViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  const handlePrevious = () => {
    setCurrentIndex((index) => (index > 0 ? index - 1 : images.length - 1));
  };

  const handleNext = () => {
    setCurrentIndex((index) => (index < images.length - 1 ? index + 1 : 0));
  };

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft") {
        handlePrevious();
      } else if (event.key === "ArrowRight") {
        handleNext();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, handlePrevious, handleNext]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95"
      onClick={handleBackdropClick}
    >
      {/* 关闭按钮 */}
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-4 top-4 z-10 text-white hover:bg-white/10"
        onClick={onClose}
        aria-label="关闭图片查看器"
      >
        <X className="size-5" />
      </Button>

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
        onClick={(e) => e.stopPropagation()}
      />

      {/* 图片计数 */}
      {images.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-sm text-white">
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>
  );
}
