import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

const inputDir = path.resolve(path.dirname(INPUT));

export default defineConfig({
  root: inputDir,
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: {
      input: path.resolve(INPUT),
    },
    outDir: path.resolve("dist/ui"),
    emptyOutDir: false,
  },
});
