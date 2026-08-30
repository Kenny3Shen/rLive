/**
 * rLive 应用图标的唯一几何与配色来源。
 *
 * 设计约束（移动端裁剪安全）：
 * - 所有品牌内容集中在画布中心的圆形安全区内，圆形、squircle、圆角矩形任意遮罩都不会裁到内容。
 * - 背景是满幅渐变，只有背景会被裁掉，视觉上不产生缺口。
 * - Android 自适应图标前景把标记缩到 108dp 画布的中心 60dp 圆内（官方安全区为 66dp）。
 */

/** 桌面/iOS/旧版启动图标的主画布尺寸（SVG 用户单位）。 */
export const MASTER_CANVAS = 512;

/** Android 自适应图标画布（dp）。 */
export const ADAPTIVE_CANVAS = 108;

/** Android 自适应图标中标记允许占用的直径（dp），官方安全区 66dp。 */
export const ADAPTIVE_MARK_DIAMETER = 60;

/** 主画布圆角半径（22%），用于 Windows/Linux/旧版 Android 启动图标。 */
export const MASTER_CORNER_RADIUS = Math.round(MASTER_CANVAS * 0.22);

const RING_RADIUS = 157;
const RING_STROKE = 26;
const RING_GAP_DEGREES = 46;
const RING_GAP_CENTER_DEGREES = -45;
const LIVE_DOT_RADIUS = 17;
const DISC_RADIUS = RING_RADIUS - RING_STROKE / 2;

/** 标记在自身坐标系中的最大半径，用于换算各画布的缩放比例。 */
export const MARK_EXTENT = Math.max(RING_RADIUS + RING_STROKE / 2, RING_RADIUS + LIVE_DOT_RADIUS);

/** 播放三角在描边圆角前的顶点（已按包围盒居中并右移 4 做视觉补偿）。 */
const PLAY_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-71, -84],
  [-71, 84],
  [79, 0],
];
const PLAY_ROUND_STROKE = 22;

export const PALETTE = {
  backgroundFrom: "#1B2A52",
  backgroundTo: "#080C1A",
  glow: "#3E6BFF",
  ringFrom: "#3EE0F2",
  ringMid: "#5F86FF",
  ringTo: "#A96BFF",
  discFrom: "#141F3C",
  discTo: "#0A0F1F",
  playFrom: "#FFFFFF",
  playTo: "#D9E4FF",
  liveFrom: "#FF7A93",
  liveTo: "#FF3355",
} as const;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function polar(radius: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [radius * Math.cos(radians), radius * Math.sin(radians)];
}

export interface MarkTransform {
  /** 标记中心在目标画布中的坐标。 */
  center: number;
  /** 标记坐标系到目标画布的缩放比例。 */
  scale: number;
}

/** 满幅图标（桌面/iOS/旧版启动图标）的标记变换。 */
export const MASTER_TRANSFORM: MarkTransform = {
  center: MASTER_CANVAS / 2,
  scale: 1,
};

/** Android 自适应前景在 108dp 画布上的标记变换。 */
export const ADAPTIVE_TRANSFORM: MarkTransform = {
  center: ADAPTIVE_CANVAS / 2,
  scale: ADAPTIVE_MARK_DIAMETER / 2 / MARK_EXTENT,
};

/** Android 自适应前景在 512 单位画布（等比放大的 108dp）上的标记变换。 */
export const ADAPTIVE_TRANSFORM_512: MarkTransform = {
  center: MASTER_CANVAS / 2,
  scale: (ADAPTIVE_TRANSFORM.scale * MASTER_CANVAS) / ADAPTIVE_CANVAS,
};

function project({ center, scale }: MarkTransform, x: number, y: number): [number, number] {
  return [round(center + x * scale), round(center + y * scale)];
}

/** 品牌渐变环：在右上角留出缺口给 live 指示点。 */
export function ringPath(transform: MarkTransform): string {
  const start = RING_GAP_CENTER_DEGREES + RING_GAP_DEGREES / 2;
  const end = RING_GAP_CENTER_DEGREES - RING_GAP_DEGREES / 2;
  const [sx, sy] = project(transform, ...polar(RING_RADIUS, start));
  const [ex, ey] = project(transform, ...polar(RING_RADIUS, end));
  const radius = round(RING_RADIUS * transform.scale);
  return `M${sx},${sy} A${radius},${radius} 0 1 1 ${ex},${ey}`;
}

export function ringStrokeWidth(transform: MarkTransform): number {
  return round(RING_STROKE * transform.scale);
}

/** 环内深色底盘，保证播放三角与背景光晕之间始终有对比。 */
export function discPath(transform: MarkTransform): string {
  const radius = round(DISC_RADIUS * transform.scale);
  const [cx, cy] = project(transform, 0, 0);
  return `M${round(cx - radius)},${cy} a${radius},${radius} 0 1 0 ${round(radius * 2)},0 a${radius},${radius} 0 1 0 ${round(-radius * 2)},0Z`;
}

/** live 指示点，落在渐变环缺口中央。 */
export function liveDotPath(transform: MarkTransform): string {
  const [cx, cy] = project(transform, ...polar(RING_RADIUS, RING_GAP_CENTER_DEGREES));
  const radius = round(LIVE_DOT_RADIUS * transform.scale);
  return `M${round(cx - radius)},${cy} a${radius},${radius} 0 1 0 ${round(radius * 2)},0 a${radius},${radius} 0 1 0 ${round(-radius * 2)},0Z`;
}

/** 播放三角本体；圆角依靠同色圆角描边实现。 */
export function playPath(transform: MarkTransform): string {
  const [first, ...rest] = PLAY_POINTS.map(([x, y]) => project(transform, x, y));
  return `M${first[0]},${first[1]} ${rest.map(([x, y]) => `L${x},${y}`).join(" ")}Z`;
}

export function playStrokeWidth(transform: MarkTransform): number {
  return round(PLAY_ROUND_STROKE * transform.scale);
}

export interface MarkSvgOptions {
  transform: MarkTransform;
  /** 渐变 id 前缀，避免同一份 SVG 内多次引用时冲突。 */
  prefix: string;
  /** 是否绘制环内深色底盘。 */
  disc?: boolean;
}

/** 标记的渐变定义。 */
export function markDefs({ transform, prefix }: MarkSvgOptions): string {
  const gradient = (id: string, x1: number, y1: number, x2: number, y2: number, stops: string) => {
    const [gx1, gy1] = project(transform, x1, y1);
    const [gx2, gy2] = project(transform, x2, y2);
    return `<linearGradient id="${prefix}-${id}" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`;
  };
  const [dotX, dotY] = polar(RING_RADIUS, RING_GAP_CENTER_DEGREES);
  return [
    gradient(
      "ring",
      -140,
      -140,
      140,
      140,
      `<stop stop-color="${PALETTE.ringFrom}"/><stop offset=".5" stop-color="${PALETTE.ringMid}"/><stop offset="1" stop-color="${PALETTE.ringTo}"/>`,
    ),
    gradient(
      "disc",
      -120,
      -120,
      120,
      120,
      `<stop stop-color="${PALETTE.discFrom}"/><stop offset="1" stop-color="${PALETTE.discTo}"/>`,
    ),
    gradient(
      "play",
      -60,
      -84,
      60,
      84,
      `<stop stop-color="${PALETTE.playFrom}"/><stop offset="1" stop-color="${PALETTE.playTo}"/>`,
    ),
    gradient(
      "live",
      dotX - LIVE_DOT_RADIUS,
      dotY - LIVE_DOT_RADIUS,
      dotX + LIVE_DOT_RADIUS,
      dotY + LIVE_DOT_RADIUS,
      `<stop stop-color="${PALETTE.liveFrom}"/><stop offset="1" stop-color="${PALETTE.liveTo}"/>`,
    ),
  ].join("");
}

/** 标记的图形部分（不含 defs）。 */
export function markShapes(options: MarkSvgOptions): string {
  const { transform, prefix, disc = true } = options;
  const parts: string[] = [];
  if (disc) {
    parts.push(`<path d="${discPath(transform)}" fill="url(#${prefix}-disc)"/>`);
  }
  parts.push(
    `<path d="${ringPath(transform)}" fill="none" stroke="url(#${prefix}-ring)" stroke-width="${ringStrokeWidth(transform)}" stroke-linecap="round"/>`,
    `<path d="${playPath(transform)}" fill="url(#${prefix}-play)" stroke="url(#${prefix}-play)" stroke-width="${playStrokeWidth(transform)}" stroke-linejoin="round"/>`,
    `<path d="${liveDotPath(transform)}" fill="url(#${prefix}-live)"/>`,
  );
  return parts.join("");
}

export interface BackgroundOptions {
  canvas: number;
  prefix: string;
  /** 背板形状：满幅方形、圆角方形或圆形。 */
  shape: "square" | "rounded" | "circle";
}

export function backgroundDefs({ canvas, prefix }: BackgroundOptions): string {
  const glowRadius = round(canvas * 0.42);
  return [
    `<linearGradient id="${prefix}-bg" x1="0" y1="0" x2="${canvas}" y2="${canvas}" gradientUnits="userSpaceOnUse"><stop stop-color="${PALETTE.backgroundFrom}"/><stop offset="1" stop-color="${PALETTE.backgroundTo}"/></linearGradient>`,
    `<radialGradient id="${prefix}-glow" cx="${canvas / 2}" cy="${canvas / 2}" r="${glowRadius}" gradientUnits="userSpaceOnUse"><stop stop-color="${PALETTE.glow}" stop-opacity=".3"/><stop offset="1" stop-color="${PALETTE.glow}" stop-opacity="0"/></radialGradient>`,
  ].join("");
}

export function backgroundShapes({ canvas, prefix, shape }: BackgroundOptions): string {
  const clip =
    shape === "circle"
      ? `<circle cx="${canvas / 2}" cy="${canvas / 2}" r="${canvas / 2}"`
      : shape === "rounded"
        ? `<rect width="${canvas}" height="${canvas}" rx="${round((canvas * MASTER_CORNER_RADIUS) / MASTER_CANVAS)}"`
        : `<rect width="${canvas}" height="${canvas}"`;
  return `${clip} fill="url(#${prefix}-bg)"/>${clip} fill="url(#${prefix}-glow)"/>`;
}

/** 满幅图标：背景 + 居中标记。 */
export function buildIconSvg(shape: BackgroundOptions["shape"]): string {
  const background: BackgroundOptions = { canvas: MASTER_CANVAS, prefix: "b", shape };
  const mark: MarkSvgOptions = { transform: MASTER_TRANSFORM, prefix: "m" };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER_CANVAS}" height="${MASTER_CANVAS}" viewBox="0 0 ${MASTER_CANVAS} ${MASTER_CANVAS}" role="img" aria-labelledby="rlive-icon-title">`,
    `<title id="rlive-icon-title">rLive</title>`,
    `<defs>${backgroundDefs(background)}${markDefs(mark)}</defs>`,
    backgroundShapes(background),
    markShapes(mark),
    `</svg>`,
  ].join("");
}

/** Android 自适应前景：透明背景，标记缩到安全区内。 */
export function buildAdaptiveForegroundSvg(): string {
  const mark: MarkSvgOptions = { transform: ADAPTIVE_TRANSFORM_512, prefix: "m" };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER_CANVAS}" height="${MASTER_CANVAS}" viewBox="0 0 ${MASTER_CANVAS} ${MASTER_CANVAS}">`,
    `<defs>${markDefs(mark)}</defs>`,
    markShapes(mark),
    `</svg>`,
  ].join("");
}

/** Android 自适应背景：满幅渐变，与满幅图标背景一致。 */
export function buildAdaptiveBackgroundSvg(): string {
  const background: BackgroundOptions = { canvas: MASTER_CANVAS, prefix: "b", shape: "square" };
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MASTER_CANVAS}" height="${MASTER_CANVAS}" viewBox="0 0 ${MASTER_CANVAS} ${MASTER_CANVAS}">`,
    `<defs>${backgroundDefs(background)}</defs>`,
    backgroundShapes(background),
    `</svg>`,
  ].join("");
}
