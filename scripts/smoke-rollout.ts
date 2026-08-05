// Headless smoke rollout (playbook Phase 1 gate): random AIs play full games
// through the adapter. Asserts:
//  - every game reaches game over without throwing
//  - currentActor is never null mid-game (no stalls)
//  - card conservation: the multiset of card ids across all zones never changes
//  - ship conservation: shipsAvailable + on-map ships === 12 per player
//  - serialization round-trip: encode → decode → re-encode identical
//  - legalActions ⇄ applyAction agreement (every picked action applies cleanly)
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import type { ImpulseState } from '../src/engine/types';

const GAMES = 30;
const MAX_STEPS = 200_000;

function cardCensus(g: ImpulseState): Map<number, number> {
  const census = new Map<number, number>();
  const add = (id: number): void => {
    census.set(id, (census.get(id) ?? 0) + 1);
  };
  g.deck.forEach(add);
  g.discard.forEach(add);
  g.impulse.forEach(add);
  for (const nc of Object.values(g.nodeCards)) {
    if (nc.kind !== 'core') add(nc.cardId);
  }
  for (const p of g.players) {
    p.hand.forEach(add);
    p.plan.forEach(add);
    p.nextPlan?.forEach(add);
    p.minerals.forEach(add);
    for (const tech of [p.techLeft, p.techRight]) {
      if (tech.type === 'researched') add(tech.cardId);
    }
  }
  // Mid-effect limbo: cards held inside handler state until the effect
  // resolves — face-down battle reinforcements + cruiser draws, a research
  // deck-draw awaiting its slot pick, and an executing card awaiting its
  // sub-effect's completion. Scan recursively — these nest inside
  // activation/execute sub-contexts.
  const scanLimbo = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach(scanLimbo);
      return;
    }
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['attackerReinforcements']) && Array.isArray(o['defenderReinforcements'])) {
      for (const key of ['attackerReinforcements', 'defenderReinforcements',
        'attackerCruiserDraws', 'defenderCruiserDraws'] as const) {
        (o[key] as number[]).forEach(add);
      }
      return;
    }
    if (o['pickedFromDeck'] === true && typeof o['pickedCardId'] === 'number') {
      add(o['pickedCardId']);
    }
    if (typeof o['cardToDiscardOnComplete'] === 'number') {
      add(o['cardToDiscardOnComplete']);
    }
    Object.values(o).forEach(scanLimbo);
  };
  scanLimbo(g.effect?.handlerState);
  return census;
}

function censusEqual(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function assertShipConservation(g: ImpulseState, tag: string): void {
  for (const p of g.players) {
    const onMap = g.ships.filter((s) => s.owner === p.seat).length;
    if (p.shipsAvailable + onMap !== 12) {
      throw new Error(`${tag}: ${p.seat} ships ${p.shipsAvailable}+${onMap} != 12`);
    }
  }
}

let capOuts = 0;
let wins = 0;
let totalTurns = 0;

for (let game = 0; game < GAMES; game++) {
  const seed = 1000 + game;
  const playerCount = 2 + (game % 3); // 2, 3, 4 players
  const picker = new Rng(seed ^ 0x517cc1b7);
  let state = createGame({ playerCount, seed });
  const initialCensus = cardCensus(state);

  let steps = 0;
  while (!state.isGameOver) {
    if (++steps > MAX_STEPS) throw new Error(`game ${game}: exceeded ${MAX_STEPS} steps`);
    const actor = impulseAdapter.currentActor(state);
    if (actor === null) throw new Error(`game ${game} step ${steps}: currentActor null mid-game`);
    const legal = impulseAdapter.legalActions(state, actor);
    if (legal.length === 0) throw new Error(`game ${game} step ${steps}: no legal actions for ${actor}`);
    const action = picker.pick(legal);
    const verdict = impulseAdapter.tryApplyAction!(state, action, actor);
    if (!verdict.ok) {
      throw new Error(`game ${game} step ${steps}: legal action rejected: ${verdict.reason} ` +
        `action=${JSON.stringify(action)}`);
    }
    state = verdict.state;

    if (steps % 25 === 0) {
      if (!censusEqual(initialCensus, cardCensus(state))) {
        throw new Error(`game ${game} step ${steps}: card conservation violated`);
      }
      assertShipConservation(state, `game ${game} step ${steps}`);
      const encoded = JSON.stringify(state);
      const reencoded = JSON.stringify(JSON.parse(encoded));
      if (encoded !== reencoded) {
        throw new Error(`game ${game} step ${steps}: serialization round-trip mismatch`);
      }
      // Redaction must hold WHILE the game is live (it is deliberately lifted
      // at game over so both clients can render the same final position).
      // The move just applied may itself have ended the game — this periodic
      // block runs before the loop condition is re-tested — so skip then and
      // let the post-loop reveal assertion cover it.
      for (const viewer of state.isGameOver ? [] : [null, ...state.players.map((p) => p.seat)]) {
        const view = impulseAdapter.viewFor(state, viewer);
        if (view.deck.some((id) => id !== 0)) {
          throw new Error(`game ${game} step ${steps}: leak — deck ids visible to ${viewer ?? 'spectator'}`);
        }
        if (view.rngState !== 0) {
          throw new Error(`game ${game} step ${steps}: leak — rng state visible`);
        }
        for (const p of view.players) {
          if (p.seat !== viewer && p.hand.some((id) => id !== 0)) {
            throw new Error(`game ${game} step ${steps}: leak — ${p.seat} hand visible to ${viewer ?? 'spectator'}`);
          }
        }
      }
    }
  }

  if (!censusEqual(initialCensus, cardCensus(state))) {
    throw new Error(`game ${game}: final card conservation violated`);
  }
  assertShipConservation(state, `game ${game} final`);
  const result = impulseAdapter.result!(state);
  if (!result) throw new Error(`game ${game}: game over but no result`);

  totalTurns += state.turn;
  if (state.winner) {
    wins++;
    console.log(
      `game ${game}: ${playerCount}p seed ${seed} — ${state.winner} wins on turn ${state.turn} ` +
      `(${steps} steps, prestige ${state.players.map((p) => `${p.seat}=${p.prestige}`).join(' ')})`,
    );
  } else {
    capOuts++;
    console.log(`game ${game}: ${playerCount}p seed ${seed} — TURN CAP at ${state.turn} ` +
      `(prestige ${state.players.map((p) => `${p.seat}=${p.prestige}`).join(' ')})`);
  }

  // At game over every viewer sees the same, fully-revealed position — so the
  // two clients can't disagree about the final board, and players get a
  // post-mortem. (Redaction while live is asserted mid-game above.)
  for (const viewer of [null, ...state.players.map((p) => p.seat)]) {
    const view = impulseAdapter.viewFor(state, viewer);
    for (const p of view.players) {
      const real = state.players.find((q) => q.seat === p.seat)!;
      if (JSON.stringify(p.hand) !== JSON.stringify(real.hand)) {
        throw new Error(`game ${game}: ${p.seat} hand not revealed at game over to ${viewer ?? 'spectator'}`);
      }
    }
    if (JSON.stringify(view.deck) !== JSON.stringify(state.deck)) {
      throw new Error(`game ${game}: deck not revealed at game over`);
    }
  }
}

console.log(`\nsmoke: ${GAMES} games OK — ${wins} decided, ${capOuts} turn-capped, ` +
  `avg ${(totalTurns / GAMES).toFixed(1)} turns`);
if (wins === 0) {
  throw new Error('smoke: no game reached the win threshold — engine likely inert');
}
