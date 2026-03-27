import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "ui",
  plugins: [react()],
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
