// 弹幕 P1 单构建 A/B：把基线渲染器与当前渲染器编入同一页面，同一夹具内前后对照。
//
// P1 的两项收益是时间轴操作的延迟尖峰，不是稳态 FPS。用两个独立构建或两个环境比
// 数字没有意义（文档已记录过「不同夹具的数字不能相减」），所以这里把基线
// `danmakuRenderer.ts` 通过别名编进同一个 bundle，由测试脚本显式选择实现。
//
// 构建：bun tests/browser/danmaku-timeline-ab-build.ts
// 预览：bun tests/browser/danmaku-timeline-ab-build.ts --preview --port=1437
//
// 页面内选择实现：
//   window.__danmakuTimelineBenchVariant = 'baseline' | 'current'
// 然后调用 window.__danmakuTimelineBench.run(config)。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>弹幕 P1 时间轴 A/B</title>
    <style>
      body { margin: 0; background: #111; color: #eee; font: 14px/1.5 system-ui, sans-serif; }
      #bench-status { padding: 8px 12px; }
    </style>
  </head>
  <body>
    <div id="bench-status">加载单构建 A/B 渲染器…</div>
    <script type="module">
      // 同页同时包含基线与本轮实现，由 sessionStorage 选择。
      // 不能用页面内变量：runner 每轮都要 reload，变量会被重置，两个 variant 就会
      // 都落到默认实现上，得到一份看起来合理但完全无效的 A/B。
      import { resolveRenderer, build } from "/danmaku-timeline-ab.js";
      window.__danmakuTimelineBenchRenderer = resolveRenderer();
      window.__danmakuTimelineBenchBuild = build;
      window.__danmakuTimelineBenchVariant = sessionStorage.getItem("__danmakuTimelineBenchVariant") || "current";
      document.getElementById("bench-status").textContent =
        "A/B 就绪 · " + window.__danmakuTimelineBenchVariant +
        " · 基线 " + build.baseline.slice(0, 7) + " · 当前 " + build.currentHead.slice(0, 7);
    </script>
  </body>
</html>
`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generated = path.join(root, ".playwright-cli/danmaku-timeline-ab-source");
const outDir = path.join(root, ".playwright-cli/danmaku-timeline-ab-dist");
const sourcePath = "src/features/room/danmaku/danmakuRenderer.ts";
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

if (process.argv.includes("--preview")) {
  const server = await preview({
    root,
    build: { outDir },
    preview: { host: "127.0.0.1", port: Number(arg("port", "1437")), strictPort: true },
  });
  server.printUrls();
} else {
  // `f2c05886` 是本轮 P1 落地前的最后一次提交，渲染器文件与基线完全一致。
  const baseline = git("rev-parse", arg("baseline", "f2c05886"));
  const original = execFileSync("git", ["show", `${baseline}:${sourcePath}`], { cwd: root, encoding: "utf8" });
  // 基线只改内部实现，公开 API 与依赖不变，因此可以直接放到生成目录。
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
  await writeFile(path.join(generated, "baseline.ts"), original);
  const entry = path.join(generated, "entry.ts");
  await writeFile(
    entry,
    `import { DanmakuRenderer as Baseline } from "./baseline";
import { DanmakuRenderer as Current } from "@/features/room/danmaku/danmakuRenderer";

export function resolveRenderer() {
  // variant 必须跨 reload 保留（runner 每轮重载页面），所以读 sessionStorage 而不是页面变量。
  return sessionStorage.getItem("__danmakuTimelineBenchVariant") === "baseline" ? Baseline : Current;
}
export const build = ${JSON.stringify(metadata)};
`,
  );
  // 夹具主体以真实源码参与构建：A/B 页面与单版本路径共用同一份采样逻辑，
  // 否则两条路径的“耗时”口径会静默分叉。
  const benchEntry = path.join(root, "tests/browser/danmaku-timeline-bench.ts");
  await build({
    root,
    mode: "production",
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      target: "chrome120",
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry: { "danmaku-timeline-ab": entry, "danmaku-timeline-bench": benchEntry }, formats: ["es"] },
    },
  });
  await writeFile(path.join(outDir, "danmaku-timeline-ab-build.json"), JSON.stringify(metadata, null, 2));
  // preview 只服务 outDir；A/B 页面直接写成 index.html，`http://127.0.0.1:<port>/` 即可用。
  await writeFile(path.join(outDir, "index.html"), html);
  console.log(`弹幕 P1 时间轴单构建 A/B 已生成：${outDir}`);
}
