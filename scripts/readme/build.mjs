// Builds README.md and its panels, then verifies them. Fails loudly.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
for (const [file, what] of [["panels.mjs", "SVG panels from source facts"], ["readme.mjs", "README.md"], ["verify.mjs", "invariants"]]) {
  process.stderr.write(`-> ${file}  (${what})\n`);
  execFileSync(process.execPath, [path.join(here, file)], { stdio: "inherit" });
}
