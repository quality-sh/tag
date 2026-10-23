import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
import stylexVite from "@stylexjs/unplugin/vite";
import type { UserOptions } from "@stylexjs/unplugin";

// StyleX ships its Vite entry typed as `any`; it is narrowed once here.
const stylex = stylexVite as (options?: Partial<UserOptions>) => PluginOption;

// The dashboard bundle. Root is the web entry; the output lands in packages/app/dist,
// which the server serves as a single-page app.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [stylex({ useCSSLayers: false }), react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4100" },
  },
});
