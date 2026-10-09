// dist/pen2fig-core.js: the engine as one script for agents without the plugin. Load it inside
// use_figma with `new Function(src + ";return P2F")()` (or store it in plugin data once).
import { build } from "esbuild";
await build({ entryPoints: ["src/index.ts"], bundle: true, minify: true, format: "iife", globalName: "P2F", target: "es2017", outfile: "dist/pen2fig-core.js", logLevel: "warning" });
