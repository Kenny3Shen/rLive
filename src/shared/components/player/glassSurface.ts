/**
 * Single source of truth for the frosted materials used by player chrome and
 * room surfaces.
 *
 * Two materials exist, defined as `@utility` classes in `src/styles.css`:
 * - `glass-surface` — app context. Tinted from `--popover`, heavier blur.
 * - `glass-surface-overlay` — over video. Darker fill and a deliberately
 *   lighter blur, because every decoded frame changes the backdrop.
 *
 * Callers pass their context instead of re-deriving the class pair plus the
 * border/text/shadow trim at each popover and drawer.
 */

/** `true` when the surface floats over video and needs the darker material. */
export type GlassSurfaceContext = { overlay?: boolean };

/**
 * Material class for a glass panel.
 *
 * The `glass` prop on `PopoverContent`/`DrawerContent`/`SelectContent` only
 * drops the opaque `bg-popover` default; the material itself comes from here,
 * so both must be set together.
 */
export function glassSurfaceClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "glass-surface-overlay" : "glass-surface";
}

/**
 * Trim that rides along with the over-video material: hairline border, white
 * text and a deeper shadow. Empty in the app context, where the shared
 * popover/drawer tokens already read correctly against `--popover`.
 */
export function glassSurfaceTrimClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "border border-white/10 text-white shadow-xl" : "";
}

/** Material plus trim, for panels that want the whole treatment in one class. */
export function glassPanelClass(context: GlassSurfaceContext = {}): string {
  const trim = glassSurfaceTrimClass(context);
  const material = glassSurfaceClass(context);
  return trim ? `${material} ${trim}` : material;
}

/**
 * Interactive row inside an over-video glass panel. Selected state is carried
 * by an explicit fill rather than the `secondary` button variant, whose opaque
 * token would punch a hole in the material.
 */
export function glassOptionClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay
    ? "text-white hover:bg-white/12 hover:text-white data-highlighted:bg-white/12 data-highlighted:text-white data-selected:bg-white/18 data-selected:text-white data-selected:hover:bg-white/18 data-selected:data-highlighted:bg-white/18"
    : "";
}

/** Selected fill for a row inside an over-video glass panel. */
export function glassOptionSelectedClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "bg-white/18 text-white" : "";
}

/** Separators and muted labels need lifting against the darker overlay fill. */
export function glassSeparatorClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "bg-white/10" : "";
}

export function glassMutedTextClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "text-white/60" : "";
}

/**
 * Section title inside a glass popover/drawer (播放设置、字幕设置、定时关闭…).
 * Compact main heading — keeps player chrome titles consistent.
 */
export function glassTitleClass({ overlay = false }: GlassSurfaceContext = {}): string {
  return overlay ? "text-sm font-semibold text-white" : "text-sm font-semibold text-foreground";
}
