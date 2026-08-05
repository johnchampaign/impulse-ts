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

## Done — card art (optional VASSAL images) ✅

- Players choose between the built-in text UI and real card art loaded from
  their own copy of the Impulse VASSAL module; a persisted preference, not a
  fallback. Framework drop-in (`useVmodAssets` + `VmodSetupDialog`), cached
  in IndexedDB, `?art=0/1` override. `src/ui/assets.tsx` + `CardView.tsx`.
- This repo and the deployed build ship no art, and no public/ art path
  exists, so no build configuration can bake it in (`*.vmod` gitignored too).
- The same option exists in the C# desktop app (`../Impulse`, branch
  `card-art`) so both versions can use module art.

## Done — AI opponent ✅

- `src/ai/policy.ts` ports the C# `PolicyController` (five telemetry-tuned
  personalities: greedy / warrior / corerush / munchkin / refine), including
  its state-aware card scoring, core-gate stickiness, activation-combo
  lookahead, battle-safety scoring, exploration place-best/place-worst, and
  sabotage target choice. Weight-justifying comments carried over verbatim.
- `src/ai/controllers.ts` exposes each policy as a framework
  `PlayerController`, wired as `aiControllers` so the **server** drives AI
  seats (the human's client never picks the AI's moves) and each earns its own
  leaderboard identity `ai:impulse:<policy>`.
- Lobby: per-seat Human/AI dropdown; the API validates policy names and
  refuses an all-AI game. Invite list marks AI seats instead of offering a
  useless link.
- Three deliberate improvements over the C# original, each labelled in the
  source: commit a *matching* battle reinforcement rather than a random bluff;
  choose the Sector Core mineral colour by gems held rather than at random;
  place the best card on the home sector (the C# answered both at random).
- Tests (`tests/ai.test.ts`, 14): legality for every policy at every player
  count, determinism, prompt-marker coupling, the three value decisions, and a
  strength floor vs random play. `npm run tournament` / `npm run ai-vs-random`
  are the self-play harnesses (C# HeadlessTournament equivalents).
- Measured: every policy beats uniform random ~100% of 50 games. Verified
  live against production — the server played a full AI turn between each of
  the human's moves.
- Prompt text the AI keys off now lives in `src/engine/prompts.ts` so
  rewording a prompt is a compile-time concern, not a silent AI regression.

## Done — leaderboard + identity ✅

- Hub identity wired client-side (`useIdentity` + `<SignInBar>`): every visitor
  gets an anon guest identity automatically, can rename it, and can upgrade to
  a registered account for a rating that survives devices.
- On opening a game the client claims its seat with the identity token
  (`POST /api/games/:id/claim`, best-effort — an unattributed seat still plays,
  it just isn't rated).
- `<Leaderboard game="impulse">` in the lobby, `<RankedStatus>` + a leaderboard
  link on the game-over panel.
- Verified end to end against production: anon identity → claim → full game vs
  the AI → server reported `{recorded: true}` → the hub leaderboard shows both
  players with Glicko-2 ratings (AI 1662, human 1338, both provisional).
- The hub's `/ratings/leaderboard` is slug-based, so no hub-side registry entry
  is needed for the in-game board. Listing Impulse on the hub index
  (`games-hub/games.json`) is a separate, optional one-line change.

## Known gaps

- **Cancel is not supported** (rejected by the driver): the C#
  restart-on-cancel wipes handler state, which here can own cards
  (committed battle reinforcements) — a leak. Needs per-request cancel
  semantics that restore owned cards before the UI adds a cancel button.
- No initiative marker (deferred in C# too), no team mode.
- Elimination (player at 0 on-map ships) is not enforced as a game-state
  rule — matches current C# behavior; verify against rulebook later.

## Next phases

1. **Fidelity pass**: port more C# tests (CommandHandlerTests,
   BattleTriggerTests, ExplorationTests cases) to vitest.
2. **UI polish + rest of the standard kit**: map-click affordances (click a
   gate/card instead of a button), update banner + version stamp endpoint,
   realtime signal (Supabase broadcast), in-game chat panel, hub identity
   sign-in (anon-first), reveal-at-game-over check.
3. **List Impulse on the hub index** (`games-hub/games.json`) when you want it
   publicly discoverable — one entry, mirrors the other games.

## Guardrails

- `data/cards.tsv` + the C# handlers are the source of truth — never author
  rule behaviour from memory.
- Every ported family gets its C# tests ported alongside it.
- `npm run smoke` + `npm run typecheck` gate every change.
- Rule interpretations documented in `../Impulse/docs/engine.md`
  ("Documented rule interpretations") carry over verbatim — sequential
  multi-fleet declaration, attacker-chooses-defender, patrol-through
  destination rule, third-party transport destruction.
