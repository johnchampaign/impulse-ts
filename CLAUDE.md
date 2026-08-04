# Impulse (TS port) — Claude notes

## Backup discipline (load-bearing)

Never leave a session with local-only state. Commit and push to the private
remote (`origin` = `github.com/johnchampaign/impulse-ts`) before doing new
work. If `git status -sb` doesn't show `## main...origin/main` with no
`ahead`, push before continuing. (Same rule as the framework, Innovation,
and Tyrants repos.)

## What this is

A from-scratch **TypeScript port of Impulse**, replacing the C# desktop app
(`../Impulse`, left untouched as the reference). Goal: web + async
multiplayer + hub leaderboard from one codebase, on the same stack as
Tyrants, Innovation, and Rebellion.

Architecture (framework-direct, like Rebellion — no boardgame.io):
- The **digital-boardgame-framework** (npm) provides Rng, the structured
  game log, the `GameAdapter` seam (async multiplayer, per-player redaction,
  snapshots, bug triage), and later `useGame` for the UI.
- The Impulse **rules** live in `src/engine/` — a resumable state machine.
  The C# `GameRunner` was a blocking loop over synchronous controllers; here
  the engine *pauses into serializable state* (`state.pending`) whenever it
  needs input, and `applyAction` resumes it. Same six phases, same
  pause/resume `EffectCtx` idiom, but every prompt is an async round-trip.
- `data/cards.tsv` is copied verbatim from the C# repo (converted to UTF-8;
  content is pure ASCII). **Never author card behaviour from memory** — open
  the TSV and the C# handler first.

## Porting discipline

- The C# engine (`../Impulse/src/Impulse.Core`) is the authority. Port
  handlers 1:1 including their per-card parameter tables and rulebook
  comments (`// Impulserules p.<n>` citations carry over).
- The **allowlist pattern** keeps the game playable while incomplete: only
  card families with a registered handler enter the deck (setup filter);
  unregistered families auto-skip on the Impulse track and in Plans.
- Handler state (`ctx.handlerState`) must be plain JSON — it serializes with
  the game state. No class instances, no functions.
- Never consume `ctx.pendingChoice` without nulling it (inherited gotcha).
- All randomness through `withRng` (framework Rng in `state.rngState`); no
  `Math.random`, no `Date.now()` anywhere in `src/engine/`.
- All prestige through `addPrestige` (continuous win check); all zone moves
  through `src/engine/mechanics.ts`.
- `npm run smoke` gates every change (and `npm run typecheck`). Port C#
  tests alongside each new handler family as vitest tests.

## Project shape

- `data/cards.tsv` — authoritative card catalog (108 cards, 47 families).
- `scripts/build-card-data.mjs` → `src/gen/cards-data.ts` (generated).
- `src/engine/types.ts` — domain types + `ImpulseState` + action/choice DTOs.
- `src/engine/driver.ts` — the six-phase turn machine (`advance` /
  `applyAction` / `legalActions`).
- `src/engine/handlers/` — effect handlers by family + registry bootstrap.
- `src/adapter/impulseAdapter.ts` — framework `GameAdapter` (redaction lives
  here: hands, deck, face-down node cards, rng state, choice option lists).
- `scripts/smoke-rollout.ts` — `npm run smoke`: 30 random games through the
  adapter; conservation + no-stall + leak-check asserts.
- `PORT-PLAN.md` — status and what's next. Read it first each session.

## Don't

- Don't edit the C# repo (`../Impulse`) — reference only.
- Don't hand-roll turn advance outside `driver.ts` or bypass `mechanics.ts`.
- Don't put the card catalog inside `ImpulseState` (static data, generated
  module).
- Don't implement online undo (framework decision — excluded from the
  action vocabulary).
- Don't ship publisher card art; the bring-your-own-art `.vmod` drop-in is
  the plan (framework `vassal-assets.md`).
