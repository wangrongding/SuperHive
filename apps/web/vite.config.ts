import aiIns from "@ai-ins/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [aiIns(), react()],
  server: { port: 5188 },
});
