import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: path.resolve(__dirname, "src/ui-vite"),
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist-ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/ui-vite/index.html"),
        "p2-mock": path.resolve(__dirname, "src/ui-vite/p2-mock.html"),
      },
    },
  },
  publicDir: false,
});
