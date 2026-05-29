# Claude Code Maintenance
> How to keep this project's agents, skills, and docs sharp as the codebase grows from
> greenfield into a real app.

## The iteration loop
1. **Claude gets something wrong** → add a one-line entry to the relevant skill's **Gotchas**
   section (e.g. a missed throttle, a float-money slip, a Tailwind class that shouldn't exist).
2. **The same mistake spans multiple skills** → promote it to the relevant reference doc
   (`docs/standards/*` or a `docs/documentation/*` system doc).
3. **It's a universal rule** → add it to `CLAUDE.md` — sparingly (keep it under ~120 lines).

The Gotchas sections start near-empty by design; they're where hard-won lessons accumulate.

## Periodic reviews
- **Weekly:** skim each skill's Gotchas for patterns worth promoting.
- **Monthly:** audit `CLAUDE.md` length (prune stale instructions); confirm the agent
  delegation map still matches reality.
- **Per build phase (PRD §15):** update the affected system docs in `docs/documentation/`
  after the phase lands real code — replace "planned" paths with actual ones.
- **On tooling changes:** update `/test` `/lint` `/validate` `/deploy`, the hook config, and
  permissions when package manager / scripts / runtimes change.

## Greenfield → real-code transitions
- The docs currently describe **intent** (paths marked "planned"). When code lands that
  contradicts a doc, fix the doc in the same change.
- After Phase 0, **enable the deferred format hook**: add a `PostToolUse` hook in
  `.claude/settings.json` that runs `npx prettier --write` on edited `*.{ts,tsx,css}` and
  `cargo fmt` on edited `*.rs`. Don't enable it before the tools exist (it errors on a bare repo).
- After a Wrangler D1 dev DB exists, wire the **SQLite MCP** at its local file path; after a
  git remote exists, wire the **GitHub MCP**.

## Warning signs → fixes
| Symptom | Likely cause → fix |
|---|---|
| Same mistake repeats | Missing Gotcha → add it to the skill |
| Instructions ignored | `CLAUDE.md` too long → prune |
| An agent never triggers | Its `description` isn't written as a trigger → rewrite it |
| Quality drops late in a session | Context full → `/compact` or fork; wrong model → `/model` |
| Tailwind/Next/Firebase residue reappears | A skill still carries ecosystem-source assumptions → scrub it |

## Debugging reference
- `claude --debug` — inspect the full assembled context.
- `/permissions` — review allow/deny rules and current mode.
- `/hooks` — verify hook configuration.
- `/cost` — monitor token usage.
- `/compact` — reclaim context in long sessions.
- `/model` — check or switch the model.

## Project-specific watch list
- **Money:** any non-cents money type or float arithmetic is a bug — flag immediately.
- **No-purchase:** any code path resembling cart/checkout/buy is forbidden (PRD §2/§12).
- **Inheritance:** `||` where `??` is needed, or copying defaults into new tickets, silently
  breaks the moving baseline (§9a).
- **Secrets:** a token in source/logs/bundle/D1 is a security incident — rotate + scrub.
- **Animations:** an always-on render loop or a root-level per-second tick will resurface the
  stuck-`opacity:0` bug — keep timers in leaf components.
