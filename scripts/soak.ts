// Soak: hundreds of random games across all player counts, full invariants.
// Heavier sibling of smoke-rollout.ts (playbook: "a tournament/soak script
// that plays hundreds of games and asserts no crashes, no stalls, and
// serialization round-trips").
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import type { ImpulseState } from '../src/engine/types';

const GAMES = 300;
const MAX_STEPS = 500_000;

let wins = 0;
let capOuts = 0;
let totalTurns = 0;
let battles = 0;

for (let game = 0; game < GAMES; game++) {
  const seed = 50_000 + game;
  const playerCount = 2 + (game % 5); // 2..6
  const picker = new Rng(seed ^ 0x9e3779b9);
  let state = createGame({ playerCount, seed });

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

    // Periodic serialization round-trip; resume from the parsed copy.
    if (steps % 200 === 0) {
      state = JSON.parse(JSON.stringify(state)) as ImpulseState;
    }
  }

  for (const p of state.players) {
    const onMap = state.ships.filter((s) => s.owner === p.seat).length;
    if (p.shipsAvailable + onMap !== 12) {
      throw new Error(`game ${game}: ${p.seat} ships ${p.shipsAvailable}+${onMap} != 12`);
    }
  }
  battles += state.log.filter((e) => e.kind === 'battle.result').length;
  totalTurns += state.turn;
  if (state.winner) wins++;
  else capOuts++;
  if ((game + 1) % 25 === 0) {
    console.log(`  … ${game + 1}/${GAMES} games (${wins} decided, ${capOuts} capped)`);
  }
}

console.log(`soak: ${GAMES} games OK — ${wins} decided, ${capOuts} turn-capped, ` +
  `avg ${(totalTurns / GAMES).toFixed(1)} turns, ${battles} battles observed (log tail only)`);
if (capOuts > GAMES * 0.05) {
  throw new Error(`soak: ${capOuts} turn-capped games (>5%) — investigate stalls`);
}
