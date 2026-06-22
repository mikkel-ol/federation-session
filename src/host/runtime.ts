import { readFileSync } from "node:fs";
import path from "node:path";

let source: string | undefined;

export function runtimeSource(): string {
  source ??= readFileSync(path.join(__dirname, "runtime-browser.js"), "utf8");
  return source;
}
