import "../../styles/theme.css";
import type { ComponentProps, ReactNode, Ref } from "react";

import { cn } from "@/components/videojs/lib/resolve-class-name";
import { BufferingIndicator } from "@/components/videojs/ui/buffering-indicator";
import { Container } from "@/components/videojs/ui/container";
import { ErrorDialog } from "@/components/videojs/ui/error-dialog";
import { Poster } from "@/components/videojs/ui/poster";
import { SkinVariantProvider } from "@/components/videojs/skins/variant";

import { LiveVideoHotkeys } from "./hotkeys";
import { LiveVideoStatusIndicators } from "./status-indicators";

export interface DefaultLiveVideoSkinProps extends Omit<
  NonNullable<ComponentProps<typeof Container>>,
  "children"
> {
  children?: ReactNode;
  renderPoster?: NonNullable<ComponentProps<typeof Poster>>["renderImage"];
  /** 控制条：业务侧用 PlayerControls 组合原生控件与业务按钮后传入。 */
  controlsSlot?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

export function DefaultLiveVideoSkin({
  children,
  className,
  renderPoster,
  containerRef,
  controlsSlot,
  ...props
}: DefaultLiveVideoSkinProps = {}) {
  return (
    <Container
      className={cn("r-live-player-skin pointer-fine:not-data-controls-visible:cursor-none", className)}
      data-theme="default"
      data-preset="live-video"
      ref={containerRef}
      {...props}
    >
      <SkinVariantProvider value="live">
        {children}
        <Poster renderImage={renderPoster} />
        <BufferingIndicator />
        <ErrorDialog />
        {controlsSlot}
        <LiveVideoHotkeys />
        <LiveVideoStatusIndicators />
      </SkinVariantProvider>
    </Container>
  );
}
