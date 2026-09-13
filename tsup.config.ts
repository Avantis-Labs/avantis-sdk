import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "es2022",
  external: [
    "viem",
    "react",
    "wagmi",
    "@tanstack/react-query",
    "socket.io-client",
    "pusher-js",
  ],
});
