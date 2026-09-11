import "../styles/theme.css";
import { PiPButton as PiPButtonPrimitive } from "@videojs/react";
import {
  PipEnterIcon as PipEnterIconPrimitive,
  PipExitIcon as PipExitIconPrimitive,
} from "@videojs/react/icons";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";
import { Button } from "@/components/videojs/ui/button";

export type PiPButtonProps = Omit<PiPButtonPrimitive.Props, "children">;

export function PiPButton({ className, ...props }: PiPButtonProps = {}) {
  return (
    <PiPButtonPrimitive
      render={<Button />}
      className={(state) => cn("group/pip", resolveClassName(className, state))}
      {...props}
    >
      {/* 图标尺寸与同排的播放/静音/全屏一致取 size-6：`size-media-icon` 依赖
          `--media-icon-size`，而该变量全项目都没有定义，会回落到约 16px，
          画中画按钮因此比邻居小一圈。 */}
      <PipEnterIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-not-data-pip/pip:scale-100 group-not-data-pip/pip:opacity-100",
        )}
      />
      <PipExitIconPrimitive
        className={cn(
          "col-start-1 row-start-1 size-6 drop-shadow-media-icon",
          "transition-[opacity,scale] duration-media-base ease-out",
          "opacity-0 group-data-pip/pip:scale-100 group-data-pip/pip:opacity-100",
        )}
      />
    </PiPButtonPrimitive>
  );
}
