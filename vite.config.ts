import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "ui",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "shiro/styles.css",
        replacement: resolve(__dirname, "packages/shiro/src/styles.css")
      },
      {
        find: "shiro",
        replacement: resolve(__dirname, "packages/shiro/src/index.ts")
      }
    ]
  },
  server: {
    allowedHosts: true,
    proxy: {
      "/ui": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  },
  base: "/",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true
  }
});
