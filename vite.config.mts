import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const catalogServerBase =
    process.env.GPT_SWITCH_SERVER_BASE || env.GPT_SWITCH_SERVER_BASE || "";

  return {
    plugins: [react()],
    root: ".",
    base: "./",
    define: {
      "import.meta.env.GPT_SWITCH_SERVER_BASE":
        JSON.stringify(catalogServerBase),
    },
    build: {
      outDir: "dist/renderer",
      emptyOutDir: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            antd: ["antd", "@ant-design/icons"],
          },
        },
      },
    },
    server: {
      port: 5174,
      strictPort: false,
    },
  };
});
