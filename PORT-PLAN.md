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

## Known slice gaps (the game is smaller, not broken)

- **Command families are NOT ported** — the single biggest piece
  (C# `CommandHandler.cs`, 873 lines): fleet selection, path declaration,
  movement execution, map activation (transports landing on a card fire its
  effect), battle + exploration sub-machines, multi-fleet convergence.
  Without it there is no ship movement, so Phase-5 core-patrol prestige is
  inert and games are won via trade/refine only.
- Sabotage, Research, Execute families; Basic Common tech and
  Ariek/Herculese techs (all need Command/movement or the research seam).
- No initiative marker (deferred in C# too), no team mode.
- Turn-capped random games (~13% of smoke runs) are random-AI artifacts —
  revisit once smarter AI seats land.

## Next phases

1. **Command + movement execution** — port `CommandHandler`, `BattleResolver`,
   `DefenderChoice`, exploration; then Basic Common tech, Ariek, Herculese.
   Port the C# tests (`CommandHandlerTests`, `BattleTriggerTests`,
   `ExplorationTests`) to vitest alongside.
2. **Research / Execute / Sabotage** — completes all 47 families; deck
   allowlist becomes the full 108.
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
