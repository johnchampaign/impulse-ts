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

  // Leak check: no non-viewer view may contain another player's hand ids or
  // real deck ids.
  for (const viewer of [null, ...state.players.map((p) => p.seat)]) {
    const view = impulseAdapter.viewFor(state, viewer);
    if (view.deck.some((id) => id !== 0)) throw new Error('leak: deck ids visible');
    for (const p of view.players) {
      if (p.seat !== viewer && p.hand.some((id) => id !== 0)) {
        throw new Error(`leak: ${p.seat} hand visible to ${viewer ?? 'spectator'}`);
      }
    }
    if (view.rngState !== 0) throw new Error('leak: rng state visible');
  }
}

console.log(`\nsmoke: ${GAMES} games OK — ${wins} decided, ${capOuts} turn-capped, ` +
  `avg ${(totalTurns / GAMES).toFixed(1)} turns`);
if (wins === 0) {
  throw new Error('smoke: no game reached the win threshold — engine likely inert');
}
