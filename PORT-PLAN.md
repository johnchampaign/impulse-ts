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

## Done — Phase 1c: Research, Execute, Sabotage — FULL DECK ✅

- Research (5 families): hand/deck/Plan sources, slot overwrite with skip
  semantics per source, c18 ThenExecute sub-effect, c101 plan-order
  preservation. Deck draws awaiting a slot are census-visible limbo
  (`pickedFromDeck` flag).
- Execute (3 families): the meta-action — card-from-hand / random deck top /
  own tech, via a nested sub-context; the executed card is discarded only
  when its sub-effect completes (`cardToDiscardOnComplete` limbo).
- Sabotage (3 families): patrol/occupy target legality, per-bomb deck
  reveals, size-2+ hits, no-overkill destruction with per-ship prestige.
- **All 47 effect families registered — the setup allowlist now admits the
  full 108-card deck.** Smoke: 30/30 games decided, avg ~22 turns.

## Known gaps

- **Cancel is not supported** (rejected by the driver): the C#
  restart-on-cancel wipes handler state, which here can own cards
  (committed battle reinforcements) — a leak. Needs per-request cancel
  semantics that restore owned cards before the UI adds a cancel button.
- No initiative marker (deferred in C# too), no team mode.
- Elimination (player at 0 on-map ships) is not enforced as a game-state
  rule — matches current C# behavior; verify against rulebook later.

## Done — Phase 2: server + online play ✅

- `npm run soak`: 300 games, 2–6 players, all decided, zero stalls, with
  periodic mid-game JSON round-trip resumes.
- Pages Functions router (`functions/api/[[path]].ts`, mirrors
  innovation-ts): create/fetch/legal/submit/claim/report/chat +
  `/api/upload-log` GitHub relay. Shared Supabase project (same secret
  convention as the other games), ranked-play identity + ratings ingest
  wired.
- **Deployed: https://impulse-ts.pages.dev** — live API smoke passed:
  2p game created, home picks + impulse + multi-stage tech effects played
  through both seat tokens, out-of-turn submit rejected, redaction held
  mid-game. See DEPLOY.md.

## Done — Phase 3 (first cut): React play UI ✅

- Lobby (create 2-6p game → per-seat invite links) + play page on the
  framework `useGame` hook (`src/ui/`): SVG hex map (nodes, gates, ships,
  face-up/face-down cards, homes, core), player panels (race, prestige,
  minerals, techs, plan), readable hand with rules text, prompt panel
  rendering every legal action as a labeled button (hand cards double as
  click shortcuts), log pane, never-silent report dialog (thank-you only on
  a server-issued reportId). Verified in a real browser against the
  production API: both home picks → addImpulse.
- Local UI dev: `npm run dev` proxies `/api` to production (no Node-local
  GameServer; games created in dev are real rows).

## Next phases

1. **Fidelity pass**: port more C# tests (CommandHandlerTests,
   BattleTriggerTests, ExplorationTests cases) to vitest.
2. **UI polish + rest of the standard kit**: map-click affordances (click a
   gate/card instead of a button), update banner + version stamp endpoint,
   realtime signal (Supabase broadcast), in-game chat panel, hub identity
   sign-in (anon-first), `.vmod` bring-your-own-art drop-in
   (framework `vassal-assets.md`), reveal-at-game-over check.
3. **Leaderboard**: hub identity → seat→playerId in `GameMeta` → report
   results (`ranking` already populated by the adapter) → hub Glicko-2
   ratings (framework `ratings-design.md`).
4. **(Optional) AI seats** — port `PolicyController` for solo play /
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
