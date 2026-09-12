import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./facts.mjs";

// Monad style reference: parchment canvas, serif display at weight 400, mono
// for every functional string, ash hairlines, pill containers. The light
// theme is the reference; the dark variant keeps the same roles on off-black
// so the panel still reads as one card on GitHub's dark page.
// The status trio is the dashboard's own bar palette and means utilization
// only (see the contract in panels.mjs). Provider hues match the dashboard.
export const THEMES = Object.freeze({
  light: {
    canvas: "#f6f3f1", ink: "#242424", body: "#4e4d4d", mute: "#797776", rule: "#cecac8", track: "#e6e1dd", face: "#cfdaf5",
    ok: "#2f9e5f", warn: "#d9932c", bad: "#d64545", claude: "#c96a3a", codex: "#2b59d1",
    wash1: "#ff9473", wash2: "#a0b5eb",
  },
  dark: {
    canvas: "#242424", ink: "#f6f3f1", body: "#d9d4d0", mute: "#a29e9b", rule: "#4e4d4d", track: "#3a3938", face: "#3b4a6b",
    ok: "#3fb950", warn: "#d29922", bad: "#f85149", claude: "#e0824f", codex: "#7d9df0",
    wash1: "#ff9473", wash2: "#a0b5eb",
  },
});
export const MONO = "'ABC Diatype Mono','JetBrains Mono','IBM Plex Mono',ui-monospace,'Cascadia Mono',Menlo,Consolas,monospace";
export const SERIF = "'Untitled Serif',ui-serif,Georgia,Cambria,'Times New Roman',Times,serif";

// No font engine at build time; these ratios carry every measurement.
export const monoWidth = (text, size) => text.length * size * 0.6;
export const serifWidth = (text, size) => text.length * size * 0.48;

export const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function svg(W, H, label, body, css) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">
<style>${css}</style>
${body}
</svg>
`;
}

export function writeAsset(name, text) {
  const target = path.join(ROOT, "assets", "readme", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
}

export function picture(base, alt) {
  return `<picture>
<source media="(max-width: 500px) and (prefers-color-scheme: dark)" srcset="assets/readme/${base}-narrow-dark.svg">
<source media="(max-width: 500px)" srcset="assets/readme/${base}-narrow-light.svg">
<source media="(prefers-color-scheme: dark)" srcset="assets/readme/${base}-dark.svg">
<img alt="${esc(alt)}" src="assets/readme/${base}-light.svg" width="100%">
</picture>`;
}

// Every link target in a markdown file: `](url)` and `src="url"`, deduplicated.
export const readmeLinks = (text) => [...new Set([...text.matchAll(/\]\(([^)\s]+)\)|src="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
