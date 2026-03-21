import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/Web_Transcription/" : "/",
  plugins: [react()],
  server: {
    port: 4173,
  },
});
