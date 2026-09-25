# Architecture

> System flow, auth strategy, state management, cross-cutting structure. Keep it terse: pointers into code, not essays.

Two local servers, both bound to 127.0.0.1, plain Node with no npm dependencies.

- `launcher.mjs`: entry point (`Launch Harness Console.vbs` runs it). Serves the app on 43127, starts `usage/server.mjs` on 4545 (`USAGE_PORT` overrides), replaces a running instance unless it is mid-operation. Before loading the app it stops an idle running instance (a busy one is kept and the folder left alone), then fast-forwards the folder to `origin/main` (`selfUpdate`; only on a clean main) and, when main moved, relaunches itself (child shares the terminal and exit code) so the new code loads. The footer shows the build and any skip reason via `/api/status` `build`.
- `server.mjs`: HTTP API and static `public/`. Checks exact loopback host and origin; mutations need the `X-CoreWise-Token` session token. `/api/health` answers app id `corewise-cloner` (kept from the old name so the launcher recognizes older builds).
- `core.mjs`: GitHub adapter over `gh`, clone and update of `main`, `run()` (spawn, no shell).
- `harness.mjs`: New project tab (`gh repo create --template ryanportfolio/Harness-Firmware`), skill catalog.
- `sync.mjs`: Skill sync tab. Template cache `~/.corewise-cloner/harness-firmware.git`; applies in a temp worktree on `origin/main` and pushes to `main`.
- `dsh.mjs`: DSH skills tab. Reads `~/CoreWise/Harness-Firmware` at `origin/main`, installs into `~/.dsh/skills` via staging, rename swap and rollback; validates with DSH's own skill parser.
- `usage/`: the usage tracker (formerly the whole repo). Own server, `usage/accounts.json`, cache in `usage/.state/`. The app's Usage tab embeds it in an iframe.

State: clones in `~/CoreWise`, app state in `~/.corewise-cloner/`. Both names predate the rename and stay for compatibility.
