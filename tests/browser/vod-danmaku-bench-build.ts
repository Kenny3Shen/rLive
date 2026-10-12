// 真实 VOD 页面单一 production A/B 构建：只替换 VideoDanmakuList，播放器 / IPC / 数据源完全共用。
// 不 checkout、不写 src；基线只在构建时读 git。产物仅供主窗口测试，不得作为发布包。
// 构建：bun tests/browser/vod-danmaku-bench-build.ts
// 预览：bun tests/browser/vod-danmaku-bench-build.ts --preview --port=1436
// 版本选择：sessionStorage.setItem('__vodDanmakuListVariant', 'baseline' | 'current') 后重载。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generated = path.join(root, ".playwright-cli/vod-danmaku-ab-source");
const outDir = path.join(root, ".playwright-cli/vod-danmaku-ab-dist");
const sourcePath = "src/features/video/VideoDanmakuList.tsx";
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

if (process.argv.includes("--preview")) {
  const server = await preview({
    root,
    build: { outDir },
    preview: { host: "127.0.0.1", port: Number(arg("port", "1436")), strictPort: true },
  });
  server.printUrls();
} else {
  const baseline = git("rev-parse", arg("baseline", "407fd71d"));
  const original = execFileSync("git", ["show", `${baseline}:${sourcePath}`], { cwd: root, encoding: "utf8" });
  // 基线仍复用当前公共依赖；只对比列表的全量 DOM 与虚拟化实现。
  const rewritten = original.replace(/(from\s*)(["'])(\.\/[^"']+)\2/g,
    (_match, prefix: string, quote: string, relative: string) =>
      `${prefix}${quote}@/features/video/${relative.slice(2)}${quote}`);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const metadata = {
    baseline,
    currentHead: git("rev-parse", "HEAD"),
    builtAt: new Date().toISOString(),
    sourcePath,
    baselineSourceSHA256: hash(original),
    currentSourceSHA256: hash(await readFile(path.join(root, sourcePath), "utf8")),
  };
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, "baseline.tsx"), rewritten);
  const wrapper = path.join(generated, "selection.tsx");
  await writeFile(wrapper, `import { VideoDanmakuList as Baseline } from "./baseline";
import { VideoDanmakuList as Current } from "@/features/video/VideoDanmakuList";
const variant = sessionStorage.getItem("__vodDanmakuListVariant") === "baseline" ? "baseline" : "current";
window.__vodDanmakuBuild = { ...${JSON.stringify(metadata)}, variant };
export const VideoDanmakuList = variant === "baseline" ? Baseline : Current;
`);
  await build({
    root,
    mode: "production",
    plugins: [{
      name: "vod-danmaku-list-ab",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "./VideoDanmakuList" && importer?.replaceAll("\\", "/").endsWith("/features/video/VideoSidebar.tsx")) return wrapper;
      },
      // .playwright-cli 被自动扫描忽略；必须显式扫描基线，否则其独有的
      // content-visibility 类会被 Tailwind 丢掉，A/B 就偷偷变成了「移除 CSS」实验。
      transform: {
        order: "pre",
        handler(code, id) {
          if (id === path.join(root, "src/styles.css")) {
            return `${code}\n@source "${path.join(generated, "baseline.tsx")}";\n`;
          }
        },
      },
    }],
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
  });
  await writeFile(path.join(outDir, "vod-danmaku-build.json"), JSON.stringify(metadata, null, 2));
  console.log(`真实 VOD 单构建 A/B 已生成：${outDir}`);
}
