/**
 * 生成 rLive 全平台应用图标。
 *
 * 唯一设计来源是 scripts/icon-design.ts，本脚本只负责栅格化与容器封装：
 * - 桌面（Windows/Linux/macOS）：圆角满幅 PNG + ICO + ICNS
 * - iOS：方形满幅 PNG（系统自行套用 squircle 遮罩）
 * - Android：自适应图标（满幅渐变背景 + 安全区内前景 + 单色主题层）与旧版圆角/圆形启动图标
 *
 * 用法：bun run icons
 */
import { Resvg } from "@resvg/resvg-js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTIVE_CANVAS,
  ADAPTIVE_TRANSFORM,
  buildAdaptiveForegroundSvg,
  buildIconSvg,
  discPath,
  liveDotPath,
  MASTER_CANVAS,
  MASTER_CORNER_RADIUS,
  PALETTE,
  playPath,
  playStrokeWidth,
  ringPath,
  ringStrokeWidth,
} from "./icon-design";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(repoRoot, "src-tauri", "icons");
const androidIconsDir = join(iconsDir, "android");
const androidResDir = join(repoRoot, "src-tauri", "gen", "android", "app", "src", "main", "res");

const roundedSvg = buildIconSvg("rounded");
const squareSvg = buildIconSvg("square");
const circleSvg = buildIconSvg("circle");
const foregroundSvg = buildAdaptiveForegroundSvg();

const written: string[] = [];

function writeAsset(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  written.push(path.startsWith(repoRoot) ? path.slice(repoRoot.length + 1) : path);
}

function renderPng(svg: string, size: number): Buffer {
  return new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
}

/** ------------------------------------------------------------------ 桌面 */

const desktopSizes: Array<[string, number]> = [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];

for (const [name, size] of desktopSizes) {
  writeAsset(join(iconsDir, name), renderPng(roundedSvg, size));
}

/** Windows ICO：多尺寸 PNG 容器。 */
function buildIco(sizes: number[]): Buffer {
  const images = sizes.map((size) => renderPng(roundedSvg, size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const directory = sizes.map((size, index) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[index].length;
    return entry;
  });
  return Buffer.concat([header, ...directory, ...images]);
}

writeAsset(join(iconsDir, "icon.ico"), buildIco([16, 24, 32, 48, 64, 128, 256]));

/** macOS ICNS：PNG 负载的 icns 容器。 */
function buildIcns(entries: Array<[string, number]>): Buffer {
  const chunks = entries.map(([type, size]) => {
    const png = renderPng(roundedSvg, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

writeAsset(
  join(iconsDir, "icon.icns"),
  buildIcns([
    ["icp4", 16],
    ["icp5", 32],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32],
    ["ic12", 64],
    ["ic13", 256],
    ["ic14", 512],
  ]),
);

/** --------------------------------------------------------------------- iOS */

const iosSizes: Array<[string, number]> = [
  ["AppIcon-20x20@1x.png", 20],
  ["AppIcon-20x20@2x.png", 40],
  ["AppIcon-20x20@2x-1.png", 40],
  ["AppIcon-20x20@3x.png", 60],
  ["AppIcon-29x29@1x.png", 29],
  ["AppIcon-29x29@2x.png", 58],
  ["AppIcon-29x29@2x-1.png", 58],
  ["AppIcon-29x29@3x.png", 87],
  ["AppIcon-40x40@1x.png", 40],
  ["AppIcon-40x40@2x.png", 80],
  ["AppIcon-40x40@2x-1.png", 80],
  ["AppIcon-40x40@3x.png", 120],
  ["AppIcon-60x60@2x.png", 120],
  ["AppIcon-60x60@3x.png", 180],
  ["AppIcon-76x76@1x.png", 76],
  ["AppIcon-76x76@2x.png", 152],
  ["AppIcon-83.5x83.5@2x.png", 167],
  ["AppIcon-512@2x.png", 1024],
];

for (const [name, size] of iosSizes) {
  writeAsset(join(iconsDir, "ios", name), renderPng(squareSvg, size));
}

/** ----------------------------------------------------------------- Android */

/** 各密度倍率：mdpi 为基准 1x。 */
const densities: Array<[string, number]> = [
  ["mipmap-mdpi", 1],
  ["mipmap-hdpi", 1.5],
  ["mipmap-xhdpi", 2],
  ["mipmap-xxhdpi", 3],
  ["mipmap-xxxhdpi", 4],
];

const androidFiles = new Map<string, Uint8Array | string>();

for (const [density, ratio] of densities) {
  const legacy = Math.round(48 * ratio);
  const adaptive = Math.round(ADAPTIVE_CANVAS * ratio);
  androidFiles.set(join(density, "ic_launcher.png"), renderPng(roundedSvg, legacy));
  androidFiles.set(join(density, "ic_launcher_round.png"), renderPng(circleSvg, legacy));
  androidFiles.set(join(density, "ic_launcher_foreground.png"), renderPng(foregroundSvg, adaptive));
}

const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;

androidFiles.set(join("mipmap-anydpi-v26", "ic_launcher.xml"), adaptiveXml);
androidFiles.set(join("mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptiveXml);

const fullCanvasPath = `M0,0h${ADAPTIVE_CANVAS}v${ADAPTIVE_CANVAS}h-${ADAPTIVE_CANVAS}z`;
const glowRadius = Math.round(ADAPTIVE_CANVAS * 0.42 * 1000) / 1000;

androidFiles.set(
  join("drawable", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 bun run icons 生成，请勿手工编辑；设计来源 scripts/icon-design.ts -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="${ADAPTIVE_CANVAS}dp"
    android:height="${ADAPTIVE_CANVAS}dp"
    android:viewportWidth="${ADAPTIVE_CANVAS}"
    android:viewportHeight="${ADAPTIVE_CANVAS}">
    <path android:pathData="${fullCanvasPath}">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0"
                android:startY="0"
                android:endX="${ADAPTIVE_CANVAS}"
                android:endY="${ADAPTIVE_CANVAS}">
                <item android:color="${PALETTE.backgroundFrom}" android:offset="0" />
                <item android:color="${PALETTE.backgroundTo}" android:offset="1" />
            </gradient>
        </aapt:attr>
    </path>
    <path android:pathData="${fullCanvasPath}">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="radial"
                android:centerX="${ADAPTIVE_CANVAS / 2}"
                android:centerY="${ADAPTIVE_CANVAS / 2}"
                android:gradientRadius="${glowRadius}">
                <item android:color="#4D${PALETTE.glow.slice(1)}" android:offset="0" />
                <item android:color="#00${PALETTE.glow.slice(1)}" android:offset="1" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`,
);

androidFiles.set(
  join("drawable", "ic_launcher_monochrome.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Android 13+ 主题图标单色层；由 bun run icons 生成，请勿手工编辑 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${ADAPTIVE_CANVAS}dp"
    android:height="${ADAPTIVE_CANVAS}dp"
    android:viewportWidth="${ADAPTIVE_CANVAS}"
    android:viewportHeight="${ADAPTIVE_CANVAS}">
    <path
        android:pathData="${ringPath(ADAPTIVE_TRANSFORM)}"
        android:fillColor="#00000000"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${ringStrokeWidth(ADAPTIVE_TRANSFORM)}"
        android:strokeLineCap="round" />
    <path
        android:pathData="${liveDotPath(ADAPTIVE_TRANSFORM)}"
        android:fillColor="#FFFFFFFF" />
    <path
        android:pathData="${playPath(ADAPTIVE_TRANSFORM)}"
        android:fillColor="#FFFFFFFF"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${playStrokeWidth(ADAPTIVE_TRANSFORM)}"
        android:strokeLineJoin="round" />
</vector>
`,
);

androidFiles.set(
  join("values", "ic_launcher_background.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">${PALETTE.backgroundTo}</color>
</resources>
`,
);

for (const [relativePath, data] of androidFiles) {
  writeAsset(join(androidIconsDir, relativePath), data);
  if (existsSync(androidResDir)) {
    writeAsset(join(androidResDir, relativePath), data);
  }
}

// Tauri android init 留下的默认 Android 机器人前景矢量图，已被自适应图标取代。
const staleForeground = join(androidResDir, "drawable-v24", "ic_launcher_foreground.xml");
if (existsSync(staleForeground)) {
  rmSync(staleForeground);
  rmSync(join(androidResDir, "drawable-v24"), { recursive: true, force: true });
  written.push(`removed ${staleForeground.slice(repoRoot.length + 1)}`);
}

/** ------------------------------------------------------------------ 前端 */

const webSvg = `${roundedSvg.replaceAll("><", ">\n<")}\n`;
writeAsset(join(repoRoot, "public", "rlive.svg"), webSvg);

console.log(
  [
    `master canvas ${MASTER_CANVAS} · corner radius ${MASTER_CORNER_RADIUS}`,
    `adaptive mark scale ${ADAPTIVE_TRANSFORM.scale.toFixed(4)} (${ADAPTIVE_CANVAS}dp canvas)`,
    ...written.map((path) => `  ${path}`),
    `${written.length} files`,
  ].join("\n"),
);
