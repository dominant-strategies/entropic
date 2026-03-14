import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const managedBuild = env.ENTROPIC_BUILD_PROFILE?.trim().toLowerCase() === "managed";
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim() || "https://entropic.qu.ai";

  return {
    envPrefix: ["VITE_", "ENTROPIC_"],
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5174,
      strictPort: true,
      allowedHosts: ["host.docker.internal", "localhost", "127.0.0.1"],
      proxy: managedBuild
        ? {
            "/api": {
              target: proxyTarget,
              changeOrigin: true,
              secure: true,
            },
          }
        : undefined,
      watch: {
        ignored: [
          "**/src-tauri/target/**",
          "**/src-tauri/target-*/*",
        ],
      },
    },
    clearScreen: false,
  };
});
