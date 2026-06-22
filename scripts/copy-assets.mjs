import { cp, mkdir } from "node:fs/promises";

for (const directory of ["host", "remote", "setup"]) {
  await mkdir(`dist/${directory}`, { recursive: true });
  await cp(`src/${directory}/schema.json`, `dist/${directory}/schema.json`);
}
