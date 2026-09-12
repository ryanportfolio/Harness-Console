# UsageTracker

One local page showing rate-limit usage, reset times, and warnings for several Claude Code and Codex accounts at once. Read-only. Runs on `127.0.0.1`; tokens never leave the machine.

Node 20 or newer, no dependencies.

## Run

```bash
node server.mjs
```

Open http://127.0.0.1:4545. The page refreshes itself every 30 seconds; "Refresh now" polls every account immediately.

## Accounts

`accounts.json` lists one entry per account:

```json
{ "name": "Claude 2", "kind": "claude", "dir": "~/.claude-2" }
```

- `kind: "claude"` reads `<dir>/.credentials.json`, the file Claude Code writes on login.
- `kind: "codex"` reads `<dir>/auth.json`, the file Codex writes on login.

Each account needs its own directory. `~` expands to the current user's home directory. The first account of each kind uses the default directory (`~/.claude`, `~/.codex`). Log the second account into a separate directory once:

```bash
$env:CLAUDE_CONFIG_DIR = "C:\Users\Home\.claude-2"; claude login
```

```bash
$env:CODEX_HOME = "C:\Users\Home\.codex-2"; codex login
```

To use that account in a terminal later, set the same variable before running the CLI. The tracker never switches accounts; it only reads.

## What it shows

| Provider | Windows | Extras |
|---|---|---|
| Claude Code | Session (5h), Weekly, Weekly Opus and Sonnet when the plan reports them | Plan and rate-limit tier, extra-usage credits |
| Codex | Session and Weekly (whichever the API reports as active) | Plan, email, credit balance, banked rate-limit resets and their expiry |

Bars turn amber at 70% and red at 90% used. A card with a red border shows the last error; if an earlier fetch succeeded, the old numbers stay visible with their age.

## Token totals

Neither provider reports token counts over an API, so the tracker reads the transcripts the CLIs write on this machine: `<dir>/projects/**/*.jsonl` for Claude Code, `<dir>/sessions/**/*.jsonl` for Codex. Transcripts carry no account identifier, and logging out and back in with another email puts both accounts' sessions in the same directory, so totals are shown per provider (one panel for Claude Code, one for Codex), combined across accounts. Each panel shows, for the last 7, 30, or 90 days (header buttons): total tokens, the split into uncached input, cache reads, cache writes, and output, the top three models, a bar per day, and an API-equivalent dollar figure. Sessions run on other machines are not counted.

The dollar figure prices the same traffic at public API rates from [LiteLLM's table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json), fetched once a day and cached in `.state/pricing.json`. It is not a subscription bill. Models missing from the table show as unpriced unless `priceAliases` in `accounts.json` maps them to a priced model, e.g. `"codex-auto-review": "gpt-5.6-sol"` for Codex's internal reviewer model.

Parsing follows [T3 Code](https://github.com/pingdotgg/t3code) (MIT) and ccusage: Claude lines are deduplicated by message id and request id (one message spans several transcript lines), Codex totals sum `last_token_usage` deltas with re-emitted duplicates dropped, and the parent history copied into a forked Codex rollout is skipped.

Parsed records are cached per file in `.state/tokens/` keyed by size and mtime, so a rescan (every 300 seconds, `tokenScanSeconds` in `accounts.json`, or "Refresh now") only reads files that changed, and a grown file only from where the last read stopped. Cached records are kept for 400 days even after the CLI deletes the transcript, so history outlives Claude Code's `cleanupPeriodDays` (default 30; set it higher in `settings.json` so the first scan can backfill further).

## Tokens

- Claude access tokens expire after a few hours. When one is expired, the tracker refreshes it with the stored refresh token (same endpoint and client id the CLI uses) and writes the new token back to that account's `.credentials.json`, atomically. This is the only write the tracker performs. If the refresh token itself is rejected, the card says to run `claude` in that directory.
- Codex access tokens last about ten days and the CLI refreshes them on use. The tracker never refreshes Codex tokens; it warns 24 hours before expiry.

## Polling

Claude every 180 seconds per account (the usage endpoint rate-limits faster polling), Codex every 60 seconds. Both intervals are configurable in `accounts.json` via `claudePollSeconds` and `codexPollSeconds`. The last good snapshot per account is cached in `.state/` so the page shows data immediately after a restart.

## Endpoints used

| Call | Purpose |
|---|---|
| `GET api.anthropic.com/api/oauth/usage` | Claude windows |
| `POST platform.claude.com/v1/oauth/token` | Claude token refresh |
| `GET chatgpt.com/backend-api/wham/usage` | Codex windows, plan, credits |
| `GET chatgpt.com/backend-api/wham/rate-limit-reset-credits` | Codex banked resets |

None of these are documented public APIs. They are the same calls the CLIs and [CodexBar](https://github.com/steipete/CodexBar) make; request shapes were taken from [Win-CodexBar](https://github.com/nesszer/Win-CodexBar) (MIT). Expect breakage when either vendor changes them.
