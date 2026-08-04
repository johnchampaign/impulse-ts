# Game log kinds

Registry of `GameLogEntry.kind` values and payload shapes (log-format v2).
Grow this alongside `src/engine/`; `msg` is only the UI rendering.

| kind | payload | notes |
| --- | --- | --- |
| `info` | — | neutral prose fallback (`logInfo`) |
| `game.start` | `{ playerCount, seed, deck }` | |
| `game.over` | `{ winner, prestige }` | |
| `turn.phase` | `{ turn, phase, skipped }` | turn banner at addImpulse |
| `setup.homePick` | `{ nodeId, cardId }` | |
| `prestige.gain` | `{ amount, source, total }` | source: PrestigeSource |
| `deck.refill` | `{ count }` | discard shuffled into deck |
| `draw` | `{ count, hand, deck }` | bulk draw (cleanup) |
| `draw.reveal` | `{ cardId, outcome, reason? }` | kept entries are `secret` |
| `discard` | `{ cardId }` | |
| `impulse.place` | `{ cardId }` | |
| `impulse.trim` | `{ cardId, length }` | |
| `impulse.use` / `impulse.skip` / `impulse.autoskip` | `{ cursor, cardId, family? }` | |
| `plan.add` | `{ cardId, to: 'plan'\|'nextPlan' }` | |
| `plan.use` / `plan.skip` / `plan.autoskip` | `{ cardId, family? }` | |
| `plan.forced` / `plan.delay` | `{ size }` | |
| `plan.promote` | `{ count }` | NextPlan → Plan |
| `plan.reveal` | `{ cardId, outcome }` | from-deck plan draws |
| `mine` | `{ cardId, from }` | hand → minerals |
| `mine.reveal` | `{ cardId, outcome }` | deck-source mining |
| `refine` | `{ cardId, prestige }` | |
| `trade.reveal` | `{ cardId, outcome, prestige? }` | deck-source trading |
| `tech.use` | `{ slot, tech }` | |
| `tech.piscesish` | `{ cardId, outcome }` | kept entries are `secret` |
| `research` | `{ cardId, slot, replaced }` | |
| `ship.build` / `ship.move` / `ship.destroyed` | `{ loc / from,to }` | |
| `explore.take` | `{ nodeId, cardId }` | `secret` (goes to mover's hand) |
| `explore.place` | `{ nodeId, cardId }` | |
| `battle.start` | `{ gateId, attacker, defender, attackerCruisers, passageNode }` | |
| `battle.reinforce` | `{ cardId }` | `secret` until reveal |
| `battle.bluff` | `{ cardId }` | revealed, returned to hand |
| `battle.result` | `{ winner, totals, destroyedCount, … }` | full summary in `msg` |
| `card.activate` | `{ nodeId, cardId }` | transports activating a card |
| `core.activate` | `{ color, gems, bonusTransports, points }` | |
| `alert` | `{ reason, … }` | player-facing explanations (e.g. convergence) |
