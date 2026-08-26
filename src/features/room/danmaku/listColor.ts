/**
 * 平台聊天颜色是为深色视频叠加层调制的。侧栏列表复用同一字段渲染用户名，
 * 接近白色的默认值（如 Bilibili 的 `#ffffff`）在浅色表面上会不可见。
 * 只有当颜色在当前面板背景上仍可读时才保留。
 */

const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i;

/** 用于对比度检查的近似 `:root --background` / 面板填充色。 */
const LIGHT_SURFACE = "#f9f9fb";
/** 用于房间侧栏的近似 `.dark --card` 填充色。 */
const DARK_SURFACE = "#1e2030";

/**
 * WCAG 大字号下限。用户名属于短小的 UI chrome；
 * 若要求正文级对比度，两种主题下大多数饱和的 VIP 颜色都会被丢弃。
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
 * 返回列表用户名的安全内联颜色；为 `null` 时该行回退到主题
 * `text-primary` token。
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

/** 根据设置的主题模式解析当前活动列表表面。 */
export function danmakuListSurfaceFromTheme(
  theme: "system" | "light" | "dark",
  prefersDark = false,
): DanmakuListSurface {
  if (theme === "light") return "light";
  if (theme === "dark") return "dark";
  return prefersDark ? "dark" : "light";
}
