# Impulse TS port — plan & status

Porting the C# `Impulse.Core` engine to TypeScript on the
digital-boardgame-framework (framework-direct, like Rebellion). Web-first
with async human multiplayer and a hub leaderboard, one shared stack with
Tyrants / Innovation / Rebellion.

## Done — Phase 0/1: engine core + vertical slice ✅

- Repo scaffold; framework `^0.42.0` as the only runtime engine dep.
- `data/cards.tsv` copied verbatim from C# (UTF-8; content is ASCII);
  generated catalog module.
- Engine core ported 1:1: map factory (3-4-5-4-3 hex, per-count homes),
  mechanics, movement legality (incl. cruiser patrol-through filter),
  scoring (continuous win check, Phase-5 core patrol), boost, setup
  (races, home ships, face-down deal, home-pick prompt).
- **The driver re-architecture**: C# `GameRunner`'s blocking loop became a
  resumable state machine (`advance`/`applyAction`/`legalActions` in
  `src/engine/driver.ts`). Every prompt — top-level action or mid-effect
  choice — is serializable state, so async multiplayer comes for free.
- Handler families ported (with per-card param tables from C#):
  draw (3 families), trade (3), mine (5), refine (3), build (6), plan (5),
  plus 4 of 6 race techs (Piscesish, Caelumnites, Draconians,
  Triangulumnists) and the home-pick pseudo-effect.
- Framework `GameAdapter` with full redaction (hands, deck, face-down
  nodes, rng state, other-seat choice options, secret log entries) and
  `result()` with prestige ranking.
- `npm run smoke`: 30 random games (2p/3p/4p) to completion through the
  adapter — card + ship conservation, no stalls, no redaction leaks,
  legalActions⇄tryApplyAction agreement. ✅

## Done — Phase 1b: Command, battle, exploration ✅

- All 11 command families ported from `CommandHandler.cs` with per-card
  params: fleet selection, fleet size, path declaration (incl. STAY),
  movement execution, sector-core + face-up card activation with transport
  bonus gems, activation chain-depth cap, multi-fleet sequential resolution
  with "same card" convergence narrowing + deferred single activation
  (designer ruling 2016-12-26) and the no-convergent-fleet player alert.
- Battle sub-machine (`src/engine/battle.ts`): defender-then-attacker
  face-down reinforcements (bluffs legal, revealed and returned), per-cruiser
  draws, defender-wins-ties, patrol-through third-party transport
  destruction, prestige awards, structured `battle.result` log entry.
  Reinforcement commits are `secret` log entries; battle arrays live in
  handler state and handler state is stripped from every redacted view.
- Exploration (declared-path flips): take face-down card to hand, place a
  card face-up, movement resumes. Shared per-step walker in
  `src/engine/handlers/movementExec.ts` (C# duplicated it per handler).
- Basic Common tech (discard → Command-or-Build), Ariek, Herculese.
- vitest suite (`tests/engine.test.ts`): battle win/tie resolution,
  reinforcement anchors (not minerals), patrol-through path filter,
  exploration pause/resume, mid-effect JSON round-trip resumability.
- Smoke: 30/30 games decided by prestige (avg ~19 turns, no turn caps).

## Known gaps

- Sabotage, Research, Execute families (research seam = tech overwrite +
  nested execute; sabotage needs the battle ship-destruction path — now
  available).
- **Cancel is not supported** (rejected by the driver): the C#
  restart-on-cancel wipes handler state, which here can own cards
  (committed battle reinforcements) — a leak. Needs per-request cancel
  semantics that restore owned cards before the UI adds a cancel button.
- No initiative marker (deferred in C# too), no team mode.

## Next phases

1. **Research / Execute / Sabotage** — completes all 47 families; deck
   allowlist becomes the full 108. Port their C# tests alongside.
3. **Server + online play** (playbook Phase 2): Cloudflare Pages Functions +
   Supabase via the framework `GameServer`; curl smoke before any UI.
4. **UI** (playbook Phase 3): React + `useGame`; hex map, hand, Impulse
   track, plan/tech/prestige panels; bug reports + update banner + realtime
   + chat + identity kit the same week. Bring-your-own-art `.vmod` drop-in
   for card art (framework `vassal-assets.md`).
5. **Leaderboard**: hub identity → seat→playerId in `GameMeta` → report
   results (`ranking` already populated by the adapter) → hub Glicko-2
   ratings (framework `ratings-design.md`).
6. **(Optional) AI seats** — port `PolicyController` for solo play /
   filling empty seats (framework `ai-seats-design.md`).

## Guardrails

- `data/cards.tsv` + the C# handlers are the source of truth — never author
  rule behaviour from memory.
- Every ported family gets its C# tests ported alongside it.
- `npm run smoke` + `npm run typecheck` gate every change.
- Rule interpretations documented in `../Impulse/docs/engine.md`
  ("Documented rule interpretations") carry over verbatim — sequential
  multi-fleet declaration, attacker-chooses-defender, patrol-through
  destination rule, third-party transport destruction.
