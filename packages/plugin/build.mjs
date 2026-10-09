import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/code.ts"], bundle: true, outfile: "dist/code.js", target: "es2017", format: "iife", logLevel: "warning" });
writeFileSync("dist/ui.html", readFileSync("src/ui.html", "utf8"));
console.log("built dist/code.js and dist/ui.html");
