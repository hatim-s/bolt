import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/bolt/index.ts",
      fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
      formats: ["es", "cjs"],
      name: "Bolt",
    },
    rollupOptions: {
      external: ["mutative", "react"],
    },
  },
});
