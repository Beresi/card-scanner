---
name: documentation
description: How to write docs in this project — structure, formatting, and when to create vs update. Load before authoring any doc under docs/.
---

# Documentation

## Purpose
Defines how every document in this repo is written so docs stay consistent, scannable, and
trustworthy. Applies to everything under `docs/` (standards, system docs, architecture) and
to long-form comments in `.claude/` skills and agents.

## Document types
- **System doc** (`docs/documentation/<system>.md`) — one major system/module. Answers:
  what is it, what files, what's its public interface, what does it depend on, what bites
  you. Focused and concise — NOT an exhaustive API dump.
- **Architecture doc** (`docs/documentation/architecture.md`) — cross-system: components,
  data flow, boundaries, key decisions + rationale. The "how it fits together" view.
- **Standard** (`docs/standards/*.md`) — rules and conventions to follow. Prescriptive.
- **Summary** (`docs/project-summary.md`) — the elevator view; feeds CLAUDE.md.

## Structure conventions
Every doc starts with an H1 title, then a 1–3 sentence **overview/purpose** before any
detail. Then details, then examples, then a **Gotchas** section where relevant. Order:

```
# Title
> optional one-line status/scope callout
## Overview / Purpose      (what & why, 1–3 sentences)
## <body sections>         (the substance)
## Examples                (concrete, copy-pasteable where possible)
## Gotchas                 (sharp edges; grows over time)
```

## Markdown standards
- One H1 per file. Don't skip heading levels.
- Prefer **tables** for enumerable facts (tokens, routes, fields, options) — they scan
  faster than prose. The PRD and README model this well; match that density.
- Fenced code blocks always carry a language tag (` ```ts `, ` ```sql `, ` ```toml `).
- Use relative markdown links between docs: `[architecture](architecture.md)`,
  `[PRD §7](../../cardtrader-deal-scanner-PRD.md)`. Cite PRD sections by number (e.g. "§9a").
- Keep lines readable (~100 cols); wrap prose.
- Money: always say **integer cents**; never show floats in examples.

## What makes a good system doc
- Names the **planned file paths** (this is greenfield — most code doesn't exist yet, so
  docs describe intent; mark speculative paths as planned).
- States the **public interface** (exported functions / API routes / props) and the
  **invariants** callers must respect.
- Lists **dependencies** (other systems, external APIs, env/secrets).
- Ends with **Gotchas** — the non-obvious failures (rate limits, the `min-height:0` grid
  trap, the once-per-second re-render bug, the `expansion_id`+`language` caveat).

## When to update vs create
- **Update** an existing doc when the change fits its scope. Default to updating.
- **Create** a new system doc only when a genuinely new system appears (a new `src/`
  subtree or a new view family). One doc per system, not per file.
- When a system is renamed/removed, update or delete its doc in the same change — never
  leave a doc describing something that no longer exists.
- This repo is pre-implementation: when code lands that contradicts a doc, fix the doc.

## Examples

### Good (system doc opening)
```markdown
# Deal Engine
> Pure functions; no I/O. Spec: PRD §7.
## Purpose
Given one blueprint's marketplace listings, decide whether the cheapest copy is an
underpriced deal and by how much. Filters, price-sorts, takes a median baseline of the
cohort, and compares against a threshold. All money in integer cents.
## Public interface
| Function | Signature | Notes |
...
```

### Bad
```markdown
# deal engine stuff
here is all the code and every parameter explained in 4000 words with no structure...
```
The bad version has a lowercase non-descriptive title, no overview, no interface table,
and reads like a transcript instead of a reference.

## Gotchas
<!-- Populated over time as documentation mistakes recur. -->
- Don't restate the PRD verbatim — link to it (`§N`) and document the *implementation's*
  shape and decisions instead.
- Greenfield: don't describe code as if it exists. Mark planned paths as planned.
