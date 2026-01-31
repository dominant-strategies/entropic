import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",  // Bind to all interfaces (needed for Docker)
    port: 5174,
    strictPort: true,
  },
  // Tauri expects a fixed port
  clearScreen: false,
});
