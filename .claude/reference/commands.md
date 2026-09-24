# Commands

> Build / dev / test / deploy commands for this project.

| Command | What it does |
|---|---|
| `node launcher.mjs` | Start the app on 127.0.0.1:43127 plus the usage tracker, open the browser. Same as double-clicking `Launch Harness Console.vbs`. |
| `node server.mjs --port <n> --root <dir> --preferences <file> [--open]` | App server alone with isolated folders; does not start the tracker. |
| `node usage/server.mjs` | Usage tracker alone on 4545 (`USAGE_PORT` overrides). |
| `node --test test/*.test.mjs` | App tests (temp local Git repos, injected GitHub adapter). |
| `node scripts/readme/build.mjs` | Regenerate README.md and `assets/readme/*.svg`, then verify. CI fails if the output differs. |
| `node scripts/readme/meta.mjs --lint` | Check `scripts/readme/repo.json` (About panel) offline. `--apply` pushes it to GitHub. |
