// The repo's About panel (description, website, topics) is part of the README
// surface: it is the first line a visitor reads on GitHub and in search.
// scripts/readme/repo.json is the source; this script applies it or checks
// the live values against it. Needs `gh` logged in (or GH_TOKEN in CI).
//
//   node scripts/readme/meta.mjs --check   exit 1 on drift (CI)
//   node scripts/readme/meta.mjs --apply   push repo.json to GitHub

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./facts.mjs";

const want = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/readme/repo.json"), "utf8"));
const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
const repo = process.env.GITHUB_REPOSITORY ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();

if (want.description.length > 350) throw new Error(`meta: description is ${want.description.length} chars, GitHub caps it at 350`);
for (const t of want.topics) if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(t)) throw new Error(`meta: topic "${t}" is not lowercase letters, digits and hyphens`);
if (want.topics.length > 20) throw new Error(`meta: ${want.topics.length} topics, GitHub caps it at 20`);

const mode = process.argv[2];
if (mode === "--apply") {
  gh(["api", "-X", "PATCH", `repos/${repo}`, "--input", "-"], JSON.stringify({ description: want.description, homepage: want.homepage }));
  gh(["api", "-X", "PUT", `repos/${repo}/topics`, "--input", "-"], JSON.stringify({ names: want.topics }));
} else if (mode !== "--check") {
  console.error("usage: node scripts/readme/meta.mjs --check | --apply");
  process.exit(2);
}

const live = JSON.parse(gh(["api", `repos/${repo}`, "--jq", "{description,homepage,topics}"]));
const drift = [];
if ((live.description ?? "") !== want.description) drift.push(`description: live "${live.description ?? ""}"`);
if ((live.homepage ?? "") !== want.homepage) drift.push(`homepage: live "${live.homepage ?? ""}"`);
const a = [...(live.topics ?? [])].sort().join(","), b = [...want.topics].sort().join(",");
if (a !== b) drift.push(`topics: live [${a}]`);
if (drift.length) {
  console.error(`meta: ${repo} About panel differs from scripts/readme/repo.json\n  ${drift.join("\n  ")}\n  run: node scripts/readme/meta.mjs --apply`);
  process.exit(1);
}
console.log(`meta: ${repo} About panel matches repo.json (${want.topics.length} topics)`);
