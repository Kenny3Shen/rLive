import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

function isDependency(id: string, packages: readonly string[]) {
  const moduleId = id.replaceAll("\\", "/");
  return packages.some((packageName) => moduleId.includes(`/node_modules/${packageName}/`));
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // 发布构建保留警告与错误，但不输出生成的 chunk 清单表。
  logLevel: command === "build" ? "warn" : "info",
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  // Vite 8 + Rolldown：为 Tauri 桌面端保持依赖预打包范围收敛。
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "zustand",
      "clsx",
      "tailwind-merge",
      "lucide-react",
    ],
  },
  build: {
    // WebView2 基于 Chromium，指定较新的目标可减小产物体积。
    target: "chrome120",
    // Rolldown（Vite 8）默认压缩质量足够，发布构建不生成 source map。
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    // 特性 chunk 变化时保持长期稳定的框架代码不受影响。
    // 这是 Rolldown 当前的 manual-chunk API，通过优先级避免 UI 或
    // 数据类依赖包递归吞掉它自身依赖的 React 运行时。
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "vendor-react",
              priority: 3,
              test: (id) =>
                isDependency(id, [
                  "react",
                  "react-dom",
                  "react-router",
                  "react-router-dom",
                  "@remix-run/router",
                  "scheduler",
                  "use-sync-external-store",
                ]),
            },
            {
              name: "vendor-base-ui",
              priority: 2,
              test: (id) => isDependency(id, ["@base-ui", "@floating-ui", "@babel/runtime"]),
            },
            {
              name: "vendor-data",
              priority: 1,
              test: (id) => isDependency(id, ["@tanstack", "zustand"]),
            },
          ],
        },
      },
    },
  },
  // Tauri 需要固定端口，并尽量减少 CLI 输出噪音。
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
}));
