// AI self-play tournament — the TS counterpart of the C# HeadlessTournament.
// Plays every policy against the others and reports win rates, so a heuristic
// change can be evaluated without playing games by hand.
//
//   npm run tournament        (edit GAMES / PLAYERS below to change the run)
//
// Runs the AI through the same adapter the server uses, and (like the server)
// hands each seat only its own redacted view, so measured strength reflects
// what the AI can actually see.
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import { AI_POLICIES, pickAction, type AiPolicy } from '../src/ai/policy';
import { seatOf, type ImpulseState } from '../src/engine/types';

const GAMES = 40;
const PLAYERS = 2;
const MAX_STEPS = 20_000;

interface Row { games: number; wins: number; prestige: number }
const table = new Map<AiPolicy, Row>(AI_POLICIES.map((p) => [p, { games: 0, wins: 0, prestige: 0 }]));

let capped = 0;
let totalTurns = 0;
const t0 = Date.now();

for (let game = 0; game < GAMES; game++) {
  const seed = 90_000 + game;
  const sampler = new Rng(seed ^ 0x5a5a5a5a);
  // Rotate the policy line-up so no policy is stuck in seat order bias.
  const seats = new Map<string, AiPolicy>();
  for (let i = 0; i < PLAYERS; i++) {
    seats.set(seatOf(i + 1), AI_POLICIES[(game + i) % AI_POLICIES.length]!);
  }

  let state: ImpulseState = createGame({ playerCount: PLAYERS, seed });
  let steps = 0;
  while (!state.isGameOver) {
    if (++steps > MAX_STEPS) throw new Error(`game ${game}: exceeded ${MAX_STEPS} steps`);
    const actor = impulseAdapter.currentActor(state);
    if (actor === null) throw new Error(`game ${game}: currentActor null mid-game`);
    const policy = seats.get(actor)!;
    // Same information the server gives an AI seat: its own redacted view.
    const view = impulseAdapter.viewFor(state, actor);
    const legal = impulseAdapter.legalActions(view, actor);
    if (legal.length === 0) throw new Error(`game ${game}: no legal actions for ${actor}`);
    const rng = new Rng((seed * 31 + steps) >>> 0);
    const action = pickAction(view, actor, policy, rng, legal);
    const verdict = impulseAdapter.tryApplyAction!(state, action, actor);
    if (!verdict.ok) {
      throw new Error(`game ${game} step ${steps}: ${policy} chose an illegal action ` +
        `(${verdict.reason}): ${JSON.stringify(action)}`);
    }
    state = verdict.state;
  }

  totalTurns += state.turn;
  if (!state.winner) capped++;
  for (const p of state.players) {
    const row = table.get(seats.get(p.seat)!)!;
    row.games++;
    row.prestige += p.prestige;
    if (state.winner === p.seat) row.wins++;
  }
  if ((game + 1) % 10 === 0) console.log(`  … ${game + 1}/${GAMES} games`);
}

console.log(`\n${PLAYERS}-player tournament, ${GAMES} games, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log('policy      games  wins  winrate  avg prestige');
for (const [policy, r] of [...table].sort((a, b) => b[1].wins / (b[1].games || 1) - a[1].wins / (a[1].games || 1))) {
  if (r.games === 0) continue;
  console.log(
    `${policy.padEnd(11)} ${String(r.games).padStart(5)} ${String(r.wins).padStart(5)}  ` +
    `${((r.wins / r.games) * 100).toFixed(1).padStart(6)}%  ${(r.prestige / r.games).toFixed(1).padStart(12)}`,
  );
}
console.log(`\navg ${(totalTurns / GAMES).toFixed(1)} turns/game, ${capped} undecided`);
