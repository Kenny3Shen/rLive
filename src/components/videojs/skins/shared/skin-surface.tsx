import "../../styles/theme.css";
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import { SkinVariantProvider, type SkinVariant } from "@/components/videojs/skins/variant";
import { BufferingIndicator } from "@/components/videojs/ui/buffering-indicator";
import { Container } from "@/components/videojs/ui/container";
import { ErrorDialog } from "@/components/videojs/ui/error-dialog";
import { Poster } from "@/components/videojs/ui/poster";

/** 每种皮肤对外的 props：媒体表面内容 + 由业务组合的控制条。 */
export interface PlayerSkinProps extends Omit<
  NonNullable<ComponentProps<typeof Container>>,
  "children"
> {
  children?: ReactNode;
  renderPoster?: NonNullable<ComponentProps<typeof Poster>>["renderImage"];
  /** 控制条：业务侧用 PlayerControls 组合原生控件与业务按钮后传入。 */
  controlsSlot?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

type PlayerSkinSurfaceProps = PlayerSkinProps & {
  /** 极简皮肤传 `minimal`，对应 `styles/theme.css` 的 `[data-theme]` 规则。 */
  theme: "default" | "minimal";
  preset: "video" | "live-video";
  variant: SkinVariant;
  hotkeys: ReactNode;
  statusIndicators: ReactNode;
};

/**
 * 四种皮肤（默认 / 极简 × 直播 / 点播）共用的媒体表面：同一层 Container 结构、
 * 同一套原生覆盖层，差异仅在 `data-theme`、`data-preset`，以及调用方注入的
 * 快捷键与状态提示。控制层按 `SkinVariant` 从 `PlayerControls` 取得对应形态。
 */
export function PlayerSkinSurface({
  theme,
  preset,
  variant,
  hotkeys,
  statusIndicators,
  children,
  className,
  renderPoster,
  containerRef,
  controlsSlot,
  ...props
}: PlayerSkinSurfaceProps) {
  return (
    <Container
      className={cn(
        "r-live-player-skin pointer-fine:not-data-controls-visible:cursor-none",
        className,
      )}
      data-theme={theme}
      data-preset={preset}
      ref={containerRef}
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
