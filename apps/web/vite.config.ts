import aiIns from "@ai-ins/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hiveDevStatus } from "./dev-status-plugin";

export default defineConfig({
  plugins: [aiIns(), react(), hiveDevStatus()],
  server: { port: 5188 },
});
