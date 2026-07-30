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
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "frontend"),
    },
  },
  // Vite 8 + Rolldown: keep dependency prebundle tight for Tauri desktop.
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
    // WebView2 is Chromium-based; modern target shrinks shipped JS.
    target: "chrome120",
    // Rolldown (Vite 8) default minify is high-quality; keep source maps off in release.
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    // Keep long-lived framework code stable when feature chunks change.
    // This is Rolldown's current manual-chunk API. Priorities prevent a UI or
    // data package from recursively absorbing the React runtime it depends on.
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
  // Tauri expects a fixed port and quiet CLI noise.
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
      ignored: ["**/backend/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
