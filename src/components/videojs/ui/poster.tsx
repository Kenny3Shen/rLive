import "../styles/theme.css";
import { Poster as PosterPrimitive } from "@videojs/react";

import { cn, resolveClassName } from "@/components/videojs/lib/resolve-class-name";

export interface PosterProps extends Omit<PosterPrimitive.ImageProps, "children" | "render"> {
  /** Draws the poster image in place of the one the skin renders. */
  renderImage?: PosterPrimitive.ImageProps["render"];

  children?: PosterPrimitive.RootProps["children"];

  /**
   * 追加到 `<img>` 上的类名。
   *
   * 与 `className`（落在 Root 的定位层）分开：封面图自己的裁切方式（`object-cover`
   * 之类）必须作用在 `img` 上，而 `object-media` 默认 `contain`。铺满形态的舞台
   * 要把它换成 cover，否则封面与出画后的第一帧构图不一致，换片时会跳一下。
   */
  imageClassName?: PosterPrimitive.ImageProps["className"];
}

export function Poster({
  children,
  className,
  imageClassName,
  renderImage,
  ...props
}: PosterProps = {}) {
  return (
    <PosterPrimitive.Root
      className={(state) =>
        cn(
          "pointer-events-none layer-media",
          "transition-opacity duration-media-slower not-data-visible:opacity-0",
          resolveClassName(className, state),
        )
      }
    >
      <PosterPrimitive.Image
        render={renderImage}
        className={cn(
          "layer-media object-media [&:not([src]):not([srcset])]:invisible",
          imageClassName,
        )}
        {...props}
      />

      {children}
    </PosterPrimitive.Root>
  );
}
