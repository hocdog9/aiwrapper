import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, copyFile, cp } from "node:fs/promises";
const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
const { version } = require("pdfjs-dist/package.json");
const target = join(process.cwd(), "public", "pdfjs", version);
await mkdir(target, { recursive: true });
await copyFile(join(root, "build/pdf.worker.min.mjs"), join(target, "pdf.worker.min.mjs"));
for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(join(root, directory), join(target, directory), { recursive: true });
}
