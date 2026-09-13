import "../../styles/theme.css";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import { SkinVariantProvider, type SkinVariant } from "@/components/videojs/skins/variant";
import { BufferingIndicator } from "@/components/videojs/ui/buffering-indicator";
import { Container } from "@/components/videojs/ui/container";
import { ErrorDialog } from "@/components/videojs/ui/error-dialog";
import { Poster } from "@/components/videojs/ui/poster";

/** 统一播放器表面的 props：媒体内容与业务控制条。 */
export interface PlayerSurfaceProps extends Omit<
  NonNullable<ComponentProps<typeof Container>>,
  "children"
> {
  children?: ReactNode;
  renderPoster?: NonNullable<ComponentProps<typeof Poster>>["renderImage"];
  /** 控制条：业务侧用 PlayerControls 组合原生控件与业务按钮后传入。 */
  controlsSlot?: ReactNode;
}

type PlayerSurfacePropsInternal = PlayerSurfaceProps & {
  variant: SkinVariant;
  hotkeys: ReactNode;
  statusIndicators: ReactNode;
  /** 全屏切换回调，从 VideoJsContainer 透传给 hotkeys */
  onToggleFullscreen?: () => void;
};

/** 直播与点播共用的媒体表面；差异仅为快捷键、状态提示与控制条形态。 */
export function PlayerSurface({
  variant,
  hotkeys,
  statusIndicators,
  children,
  className,
  renderPoster,
  controlsSlot,
  onToggleFullscreen: _onToggleFullscreen,
  ...props
}: PlayerSurfacePropsInternal) {
  return (
    <Container
      className={cn(
        "r-live-player-skin pointer-fine:not-data-controls-visible:cursor-none",
        className,
      )}
      {...props}
    >
      <SkinVariantProvider value={variant}>
        {children}
        <Poster renderImage={renderPoster} />
        <BufferingIndicator />
        <ErrorDialog />
        {controlsSlot}
        {hotkeys}
        {statusIndicators}
      </SkinVariantProvider>
    </Container>
  );
}
