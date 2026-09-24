# Tech stack

> Non-default library choices and WHY they were made, so future sessions don't "fix" deliberate picks.

- Node.js 24 built-ins only, no `package.json`. `scripts/readme/facts.mjs` fails the README build if any app or tracker source imports a non-`node:` package.
- GitHub access goes through the `gh` CLI (auth, API, `gh auth git-credential`), so the app stores no credentials.
- Plain HTML, CSS and JS in `public/`, no framework or build step.
- DSH validation loads DSH's own `@deepseek-ai/dsh-skill-filesystem` from the DSH install at runtime rather than reimplementing its parser.
