import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 5175 and 3002 rather than mini-claude-code's 5174 and 3001, so both can run at once.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://127.0.0.1:3002",
    },
  },
});
