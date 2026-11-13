import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  // Vendored skills stay byte-identical to skills-lock.json.
  fmt: { ignorePatterns: [".agents/**", "public/urtuu.mjs"] },
  // The local channel ships as one self-contained file the Worker serves at /urtuu.mjs.
  pack: {
    entry: { urtuu: "src/channel.ts" },
    outDir: "public",
    clean: false,
    format: "esm",
    platform: "node",
    noExternal: [/.*/],
  },
});
