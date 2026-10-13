// 仅构建时读取基线；不 checkout、不写 src、不引入第二份 React/store/eventBus。
// 构建：bun tests/browser/danmaku-bench-build.ts
// 预览：bun tests/browser/danmaku-bench-build.ts --preview --port=1431 --host=0.0.0.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, preview } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generated = path.join(root, ".playwright-cli/danmaku-bench-baseline");
const outDir = path.join(root, ".playwright-cli/danmaku-bench-dist");
const files = ["DanmakuPanel.tsx", "danmaku/LiveDanmaku.tsx", "danmaku/danmakuAdapter.ts", "danmaku/listWindow.ts"];
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
const config = {
  configFile: false as const,
  root,
  mode: "production",
  build: { outDir, emptyOutDir: true },
};

if (process.argv.includes("--preview")) {
  const server = await preview({
    ...config,
    preview: { host: arg("host", "127.0.0.1"), port: Number(arg("port", "1431")), strictPort: true },
  });
  server.printUrls();
  console.log("页面路径：/tests/browser/danmaku-bench.html");
} else {
  // `--baseline=<commit>` 可把对照换成任意提交，用于「同一改动前后」的单会话 A/B；
  // 默认仍是长期历史基线，便于跨轮比较。
  const baseline = git("rev-parse", arg("baseline", "30e723d5"));
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const sourcePath = `src/features/room/${file}`;
    const original = execFileSync("git", ["show", `${baseline}:${sourcePath}`], { cwd: root, encoding: "utf8" });
    const rewritten = original.replace(/(from\s*|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g,
      (_match, prefix: string, quote: string, relative: string) => {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), relative));
        // 只有这四个基线模块彼此保留基线引用，其余全部指向当前共享模块。
        const baselineFile = files.find((candidate) => `src/features/room/${candidate}`.replace(/\.(tsx?|jsx?)$/, "") === resolved.replace(/\.(tsx?|jsx?)$/, ""));
        const target = baselineFile ? `@danmaku-bench-baseline/${baselineFile}` : `@/${resolved.slice(4)}`;
        return `${prefix}${quote}${target}${quote}`;
      });
    const destination = path.join(generated, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rewritten);
    hashes[sourcePath] = createHash("sha256").update(await readFile(path.join(root, sourcePath))).digest("hex");
  }
  const metadata = { baseline, currentHead: git("rev-parse", "HEAD"), builtAt: new Date().toISOString(), currentSourceSHA256: hashes };
  await build({
    ...config,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(root, "src"), "@danmaku-bench-baseline": generated }, dedupe: ["react", "react-dom", "zustand", "@tanstack/react-query"] },
    define: { __DANMAKU_BENCH_BUILD__: JSON.stringify(metadata), "process.env.NODE_ENV": JSON.stringify("production") },
    build: { ...config.build, target: "chrome120", sourcemap: false, reportCompressedSize: false,
      rolldownOptions: { input: path.join(root, "tests/browser/danmaku-bench.html") } },
  });
  await writeFile(path.join(outDir, "danmaku-bench-build.json"), JSON.stringify(metadata, null, 2));
  console.log(`生产弹幕 A/B 夹具已构建：${outDir}`);
}
