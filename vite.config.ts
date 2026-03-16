import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function normalizeBuildProfile(rawValue: string | undefined): "local" | "managed" {
  return rawValue?.trim().toLowerCase() === "managed" ? "managed" : "local";
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const buildProfile = normalizeBuildProfile(
    env.VITE_ENTROPIC_BUILD_PROFILE || env.ENTROPIC_BUILD_PROFILE,
  );
  const managedBuild = buildProfile === "managed";
  const proxyTarget = env.VITE_API_PROXY_TARGET?.trim() || "https://entropic.qu.ai";

  return {
    envPrefix: ["VITE_"],
    define: {
      "import.meta.env.VITE_ENTROPIC_BUILD_PROFILE": JSON.stringify(buildProfile),
      "import.meta.env.VITE_ENTROPIC_GOOGLE_CLIENT_ID": JSON.stringify(
        env.VITE_ENTROPIC_GOOGLE_CLIENT_ID || env.ENTROPIC_GOOGLE_CLIENT_ID || "",
      ),
    },
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
