import { build } from "esbuild";

await build({
  entryPoints: ["src/host/runtime-browser.ts"],
  outfile: "dist/host/runtime-browser.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["@angular/core", "@angular/platform-browser"],
});
