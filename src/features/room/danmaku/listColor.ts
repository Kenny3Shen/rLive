/**
 * Platform chat colours are painted for dark video overlays. The side-panel
 * list reuses the same field for usernames, so near-white defaults such as
 * Bilibili's `#ffffff` become invisible on a light surface. Keep the colour
 * only when it stays readable against the active panel background.
 */

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

/** Approximate `:root --background` / panel fill used for contrast checks. */
const LIGHT_SURFACE = "#f9f9fb";
/** Approximate `.dark --card` fill used for the room side panel. */
const DARK_SURFACE = "#1e2030";

/**
 * WCAG large-text floor. Usernames are short UI chrome; requiring full body
 * text contrast would drop most saturated VIP colours on both themes.
 */
const MIN_CONTRAST = 3;

export type DanmakuListSurface = "light" | "dark";

function opaqueHex(color: string): string | null {
  const trimmed = color.trim();
  if (!HEX_COLOR.test(trimmed)) return null;
  const hex = trimmed.slice(1);
  const full =
    hex.length === 3 || hex.length === 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
  return `#${full.slice(0, 6).toLowerCase()}`;
}

function channelLuminance(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const full = color.slice(1);
  const r = channelLuminance(Number.parseInt(full.slice(0, 2), 16));
  const g = channelLuminance(Number.parseInt(full.slice(2, 4), 16));
  const b = channelLuminance(Number.parseInt(full.slice(4, 6), 16));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Returns a safe inline colour for the list username, or `null` so the row
 * falls back to the theme `text-primary` token.
 */
export function resolveDanmakuListUserColor(
  color: string | null | undefined,
  surface: DanmakuListSurface,
): string | null {
  if (typeof color !== "string") return null;
  const safe = opaqueHex(color);
  if (!safe) return null;

  const background = surface === "light" ? LIGHT_SURFACE : DARK_SURFACE;
  return contrastRatio(safe, background) >= MIN_CONTRAST ? safe : null;
}

/** Resolve the active list surface from the settings theme mode. */
export function danmakuListSurfaceFromTheme(
  theme: "system" | "light" | "dark",
  prefersDark = false,
): DanmakuListSurface {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}
