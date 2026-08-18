import { Slider as SliderPrimitive } from "@base-ui/react/slider";

import { cn } from "@/lib/utils";

function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  variant = "default",
  buffered,
  ...props
}: SliderPrimitive.Root.Props & {
  variant?: "default" | "player";
  /** Percentage of media already buffered, rendered below the played range. */
  buffered?: number;
}) {
  // Base UI accepts a scalar for a single-thumb slider and an array only for
  // a range slider.  Keep the rendered thumb count in sync with that value.
  const values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [value ?? defaultValue ?? min];
  const bufferedPercent = Number.isFinite(buffered)
    ? Math.max(0, Math.min(100, Number(buffered)))
    : 0;

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      data-variant={variant}
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className={cn(
          "relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col",
          variant === "player" && "group/player-slider h-5 cursor-pointer",
        )}
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className={cn(
            "relative grow overflow-hidden rounded-full select-none data-horizontal:h-1 data-horizontal:w-full data-vertical:h-full data-vertical:w-1",
            variant === "player"
              ? "bg-white/25 transition-[height] duration-150 group-hover/player-slider:data-horizontal:h-1.5 group-focus-within/player-slider:data-horizontal:h-1.5 motion-reduce:transition-none"
              : "bg-muted",
          )}
        >
          {variant === "player" && bufferedPercent > 0 && (
            <span
              data-slot="slider-buffer"
              className="absolute inset-y-0 left-0 bg-white/35 transition-[width] duration-150 motion-reduce:transition-none"
              style={{ width: `${bufferedPercent}%` }}
              aria-hidden
            />
          )}
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="relative bg-primary select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: values.length }, (_, index) => (
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            key={index}
            className={cn(
              "relative block size-3 shrink-0 rounded-full select-none after:absolute after:-inset-2 disabled:pointer-events-none disabled:opacity-50",
              variant === "player"
                ? "border-0 bg-white opacity-0 shadow-sm ring-white/40 transition-[opacity,box-shadow] group-hover/player-slider:opacity-100 group-focus-within/player-slider:opacity-100 hover:ring-3 active:opacity-100 active:ring-3"
                : "border border-ring bg-primary-foreground ring-ring/50 transition-[color,box-shadow] hover:ring-3 active:ring-3",
            )}
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
