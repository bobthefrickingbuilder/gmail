/**
 * Build config for the shared web app.
 * - Same build runs as: installed PWA on iPad (Safari → Add to Home Screen),
 *   inside the Capacitor Android app, and in any desktop browser.
 * - vite-plugin-pwa generates the service worker (offline app shell) and the
 *   web manifest (name, icons, colours, shortcuts, share target).
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export default defineConfig({
  define: { "import.meta.env.VITE_APP_VERSION": JSON.stringify(version) },
  server: { port: 5173, proxy: { "/api": "http://localhost:8787", "/download": "http://localhost:8787" } },
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "jsdom", include: ["test/**/*.test.{ts,tsx}"] },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "splash/*.png"],
      manifest: {
        name: "Email Assistant",
        short_name: "Assistant",
        description: "Private email assistant: drafts replies for your review.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#f4efe6",
        theme_color: "#2f5d50",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [{ name: "Drafts waiting", url: "/#/inbox?status=drafted", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] }],
        share_target: { action: "/#/share", method: "GET", params: { title: "title", text: "text" } },
      },
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"] },
      devOptions: { enabled: false },
    }),
  ],
});
