/**
 * 图标遮罩预览：把满幅图标与 Android 自适应图标在圆形、squircle、圆角矩形等遮罩下并排渲染，
 * 用于人工确认任何遮罩状态都不会裁到品牌内容。
 *
 * 用法：bun scripts/icon-preview.ts [输出路径]
 */
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ADAPTIVE_CANVAS,
  ADAPTIVE_TRANSFORM_512,
  backgroundDefs,
  backgroundShapes,
  buildIconSvg,
  liveDotPath,
  markDefs,
  markShapes,
  MASTER_CANVAS,
  MASTER_CORNER_RADIUS,
  playPath,
  playStrokeWidth,
  ringPath,
  ringStrokeWidth,
} from "./icon-design";

const CELL = 256;
const GAP = 28;
const LABEL_HEIGHT = 26;

interface Cell {
  label: string;
  /** 512 单位画布内的遮罩形状。 */
  mask: string;
  /** 是否绘制自适应图标（背景 + 前景），否则绘制满幅图标。 */
  adaptive: boolean;
  shape?: "square" | "rounded" | "circle";
}

const visible = (MASTER_CANVAS * 72) / ADAPTIVE_CANVAS;
const visibleOffset = (MASTER_CANVAS - visible) / 2;
const adaptiveMasks = {
  circle: `<circle cx="${MASTER_CANVAS / 2}" cy="${MASTER_CANVAS / 2}" r="${visible / 2}"/>`,
  squircle: `<rect x="${visibleOffset}" y="${visibleOffset}" width="${visible}" height="${visible}" rx="${visible * 0.28}"/>`,
  rounded: `<rect x="${visibleOffset}" y="${visibleOffset}" width="${visible}" height="${visible}" rx="${visible * 0.14}"/>`,
  square: `<rect x="${visibleOffset}" y="${visibleOffset}" width="${visible}" height="${visible}"/>`,
};
const fullMasks = {
  none: `<rect width="${MASTER_CANVAS}" height="${MASTER_CANVAS}"/>`,
  circle: `<circle cx="${MASTER_CANVAS / 2}" cy="${MASTER_CANVAS / 2}" r="${MASTER_CANVAS / 2}"/>`,
  squircle: `<rect width="${MASTER_CANVAS}" height="${MASTER_CANVAS}" rx="${MASTER_CANVAS * 0.24}"/>`,
};

const cells: Cell[] = [
  { label: "adaptive / circle", mask: adaptiveMasks.circle, adaptive: true },
  { label: "adaptive / squircle", mask: adaptiveMasks.squircle, adaptive: true },
  { label: "adaptive / rounded", mask: adaptiveMasks.rounded, adaptive: true },
  { label: "adaptive / square", mask: adaptiveMasks.square, adaptive: true },
  { label: "master rounded", mask: fullMasks.none, adaptive: false, shape: "rounded" },
  { label: "master / ios squircle", mask: fullMasks.squircle, adaptive: false, shape: "square" },
  { label: "launcher round", mask: fullMasks.circle, adaptive: false, shape: "circle" },
  { label: "master square", mask: fullMasks.none, adaptive: false, shape: "square" },
];

const columns = 4;
const rows = Math.ceil(cells.length / columns);
const width = GAP + columns * (CELL + GAP);
const height = GAP + rows * (CELL + LABEL_HEIGHT + GAP);

const body = cells
  .map((cell, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = GAP + column * (CELL + GAP);
    const y = GAP + row * (CELL + LABEL_HEIGHT + GAP);
    const scale = CELL / MASTER_CANVAS;
    const prefix = `c${index}`;
    const content = cell.adaptive
      ? [
          `<defs>${backgroundDefs({ canvas: MASTER_CANVAS, prefix: `${prefix}b`, shape: "square" })}${markDefs({ transform: ADAPTIVE_TRANSFORM_512, prefix: `${prefix}m` })}</defs>`,
          backgroundShapes({ canvas: MASTER_CANVAS, prefix: `${prefix}b`, shape: "square" }),
          markShapes({ transform: ADAPTIVE_TRANSFORM_512, prefix: `${prefix}m` }),
        ].join("")
      : buildIconSvg(cell.shape ?? "rounded")
          .replace(/^<svg[^>]*>/, "")
          .replace(/<\/svg>$/, "")
          .replaceAll('id="b-', `id="${prefix}b-`)
          .replaceAll('id="m-', `id="${prefix}m-`)
          .replaceAll("url(#b-", `url(#${prefix}b-`)
          .replaceAll("url(#m-", `url(#${prefix}m-`);
    return [
      `<clipPath id="${prefix}-clip">${cell.mask}</clipPath>`,
      `<g transform="translate(${x},${y}) scale(${scale})">`,
      `<g clip-path="url(#${prefix}-clip)">${content}</g>`,
      `</g>`,
      `<text x="${x}" y="${y + CELL + 18}" font-family="monospace" font-size="15" fill="#C7D2E8">${cell.label}</text>`,
    ].join("");
  })
  .join("");

const sizes = [192, 96, 64, 48, 32, 24, 16];
let cursor = GAP;
const smallRowY = GAP + rows * (CELL + LABEL_HEIGHT + GAP);
const smalls = sizes
  .map((size, index) => {
    const prefix = `s${index}`;
    const content = buildIconSvg("rounded")
      .replace(/^<svg[^>]*>/, "")
      .replace(/<\/svg>$/, "")
      .replaceAll('id="b-', `id="${prefix}b-`)
      .replaceAll('id="m-', `id="${prefix}m-`)
      .replaceAll("url(#b-", `url(#${prefix}b-`)
      .replaceAll("url(#m-", `url(#${prefix}m-`);
    const x = cursor;
    cursor += size + GAP;
    return `<g transform="translate(${x},${smallRowY + (192 - size)}) scale(${size / MASTER_CANVAS})">${content}</g>`;
  })
  .join("");

/** Android 13 主题图标：单色层在系统配色上的两种极端对比。 */
const monochromeShapes = (color: string) =>
  [
    `<path d="${ringPath(ADAPTIVE_TRANSFORM_512)}" fill="none" stroke="${color}" stroke-width="${ringStrokeWidth(ADAPTIVE_TRANSFORM_512)}" stroke-linecap="round"/>`,
    `<path d="${liveDotPath(ADAPTIVE_TRANSFORM_512)}" fill="${color}"/>`,
    `<path d="${playPath(ADAPTIVE_TRANSFORM_512)}" fill="${color}" stroke="${color}" stroke-width="${playStrokeWidth(ADAPTIVE_TRANSFORM_512)}" stroke-linejoin="round"/>`,
  ].join("");

const themed = [
  { background: "#3A4A6B", color: "#DCE6FF" },
  { background: "#D7DEEE", color: "#2B3A5C" },
]
  .map(({ background, color }, index) => {
    const size = 192;
    const x = cursor + GAP * 2 + index * (size + GAP);
    return `<g transform="translate(${x},${smallRowY}) scale(${size / MASTER_CANVAS})"><clipPath id="t${index}-clip">${adaptiveMasks.circle}</clipPath><g clip-path="url(#t${index}-clip)"><rect width="${MASTER_CANVAS}" height="${MASTER_CANVAS}" fill="${background}"/>${monochromeShapes(color)}</g></g>`;
  })
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 192 + GAP * 2}" viewBox="0 0 ${width} ${height + 192 + GAP * 2}">
<rect width="100%" height="100%" fill="#0F1420"/>
${body}
${smalls}
${themed}
<text x="${GAP}" y="${smallRowY + 192 + 24}" font-family="monospace" font-size="15" fill="#C7D2E8">rounded @ ${sizes.join(" / ")} px · Android 13 主题图标单色层</text>
<text x="${GAP}" y="${GAP - 8}" font-family="monospace" font-size="14" fill="#7C8AA5">mark safe radius: adaptive ${(ADAPTIVE_TRANSFORM_512.scale * 174).toFixed(1)}/512 · master corner ${MASTER_CORNER_RADIUS}</text>
</svg>`;

const output = resolve(process.argv[2] ?? "/tmp/rlive-icon-preview.png");
writeFileSync(output, new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng());
console.log(output);
