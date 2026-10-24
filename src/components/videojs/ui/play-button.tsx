import "../styles/theme.css";
import { PlayButton as PlayButtonPrimitive } from "@videojs/react";
import { Pause, Play, RotateCcw } from "lucide-react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { createPlayButtonActivation } from "@/components/videojs/lib/play-button-activation";
import { Button } from "@/components/videojs/ui/button";

export type PlayButtonProps = Omit<PlayButtonPrimitive.Props, "children"> & {
  /**
   * 由业务播放器接管暂停/播放。直播、IPTV 与多画面必须传入，让暂停意图进入
   * `useWebPlayer`；点播不传时保留 Video.js 原生行为。
   */
  onTogglePause?: () => void;
};

export function PlayButton({ className, disabled, onTogglePause, ...props }: PlayButtonProps = {}) {
  const icons = (
    <>
      <RotateCcw
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "scale-media-hidden-icon opacity-0 group-data-ended/play:scale-100 group-data-ended/play:opacity-100",
        )}
      />
      <Play
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "scale-media-hidden-icon opacity-0",
          "group-not-data-ended/play:group-data-paused/play:opacity-100",
          "group-not-data-ended/play:group-data-paused/play:scale-100",
          "group-not-data-ended/play:group-not-data-started/play:opacity-100",
          "group-not-data-ended/play:group-not-data-started/play:scale-100",
        )}
      />
      <Pause
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "scale-media-hidden-icon opacity-0",
          "group-data-started/play:group-not-data-paused/play:group-not-data-ended/play:opacity-100",
          "group-data-started/play:group-not-data-paused/play:group-not-data-ended/play:scale-100",
        )}
      />
    </>
  );

  if (!onTogglePause) {
    return (
      <PlayButtonPrimitive
        render={<Button />}
        className={(state) =>
          cn("group/play r-live-media-extension-button", resolveClassName(className, state))
        }
        disabled={disabled}
        {...props}
      >
        {icons}
      </PlayButtonPrimitive>
    );
  }

  const activation = createPlayButtonActivation({
    disabled: Boolean(disabled),
    onTogglePause,
  });

  return (
    <PlayButtonPrimitive
      className={(state) =>
        cn("group/play r-live-media-extension-button", resolveClassName(className, state))
      }
      disabled={disabled}
      {...props}
      render={(elementProps) => (
        <Button
          {...elementProps}
          onClick={activation.onClick}
          onKeyDown={activation.onKeyDown}
          onKeyUp={activation.onKeyUp}
        >
          {icons}
        </Button>
      )}
    >
      {icons}
    </PlayButtonPrimitive>
  );
}
