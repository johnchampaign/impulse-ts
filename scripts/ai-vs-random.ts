// Measures each AI policy against uniform-random play (the honest baseline).
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import { AI_POLICIES, pickAction } from '../src/ai/policy';

const GAMES = 50;
for (const policy of AI_POLICIES) {
  let wins = 0, turns = 0;
  for (let i = 0; i < GAMES; i++) {
    const seed = 7000 + i;
    let state = createGame({ playerCount: 2, seed });
    for (let step = 1; !state.isGameOver && step < 20_000; step++) {
      const actor = impulseAdapter.currentActor(state)!;
      const view = impulseAdapter.viewFor(state, actor);
      const legal = impulseAdapter.legalActions(view, actor);
      const rng = new Rng((seed * 31 + step) >>> 0);
      const action = actor === 'P1' ? pickAction(view, actor, policy, rng, legal) : rng.pick(legal);
      state = impulseAdapter.tryApplyAction!(state, action, actor).state;
    }
    if (state.winner === 'P1') wins++;
    turns += state.turn;
  }
  console.log(`${policy.padEnd(9)} vs random: ${String(wins).padStart(2)}/${GAMES} = ` +
    `${((wins / GAMES) * 100).toFixed(0).padStart(3)}%   avg ${(turns / GAMES).toFixed(1)} turns`);
}
