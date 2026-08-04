// Engine tests for the movement/battle/exploration port. These are targeted
// re-derivations of the C# BattleTriggerTests / ExplorationTests /
// CommandHandlerTests cases against the TS engine's own fixtures.
import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import { battleStep, isValidReinforcement, newBattle } from '../src/engine/battle';
import { card } from '../src/engine/catalog';
import { advance, legalActions, applyAction } from '../src/engine/driver';
import { buildRegistry } from '../src/engine/handlers';
import { newMovementState, resumeInterrupts, walkPath } from '../src/engine/handlers/movementExec';
import { gatesAt } from '../src/engine/map';
import { enumeratePaths } from '../src/engine/movement';
import { newGame } from '../src/engine/setup';
import { getPlayer, type EffectCtx, type ImpulseState, type Seat } from '../src/engine/types';

const registry = buildRegistry();

// A 2p game driven past the home picks, with a deterministic first-option
// picker, so tests start from phase addImpulse.
function freshGame(seed = 42): ImpulseState {
  const g = newGame({ playerCount: 2, seed }, registry);
  advance(g, registry);
  while (!g.isGameOver && g.phase === 'homePick') {
    const actor = g.pending!.seat;
    const acts = legalActions(g, registry, actor);
    applyAction(g, registry, acts[0]!, actor);
  }
  expect(g.phase).toBe('addImpulse');
  return g;
}

function ctxFor(seat: Seat): EffectCtx {
  return {
    seat,
    source: { type: 'impulseCard', cardId: 4 }, // any command card id
    pendingChoice: null,
    handlerState: null,
    isComplete: false,
    transportBonusGems: 0,
    activationDepth: 0,
    pendingDefenderCandidates: null,
  };
}

describe('battle resolution', () => {
  it('attacker wins on higher icons: defender fleet destroyed, attacker advances, prestige awarded', () => {
    const g = freshGame();
    const core = g.map.sectorCoreNodeId;
    const [gate1, gate2] = gatesAt(g.map, core).slice(0, 2).map((gt) => gt.id);
    // Board: P1 two cruisers on gate1, P2 one cruiser on gate2 (both touch core).
    g.ships = [
      { owner: 'P1', loc: { type: 'gate', id: gate1! } },
      { owner: 'P1', loc: { type: 'gate', id: gate1! } },
      { owner: 'P2', loc: { type: 'gate', id: gate2! } },
    ];
    getPlayer(g, 'P1').shipsAvailable = 10;
    getPlayer(g, 'P2').shipsAvailable = 11;
    // Empty hands → reinforcement prompts auto-skip; only cruiser draws count.
    getPlayer(g, 'P1').hand = [];
    getPlayer(g, 'P2').hand = [];
    // Stack the deck: defender (1 cruiser) draws first, then attacker (2).
    const bySize = (n: number): number[] => g.deck.filter((id) => card(id).size === n);
    const small = bySize(1)[0]!;
    const bigs = bySize(3).slice(0, 2);
    g.deck = [small, ...bigs, ...g.deck.filter((id) => id !== small && !bigs.includes(id))];

    const p2Before = getPlayer(g, 'P2').prestige;
    const p1Before = getPlayer(g, 'P1').prestige;
    const ctx = ctxFor('P1');
    const bs = newBattle({
      attacker: 'P1', defender: 'P2', battleGate: gate2!,
      attackerOrigin: { type: 'gate', id: gate1! }, attackerCruiserCount: 2,
    });
    const done = battleStep(g, ctx, bs);
    expect(done).toBe(true);

    // Defender's cruiser destroyed and returned to pool; attacker moved in.
    expect(g.ships.filter((s) => s.owner === 'P2').length).toBe(0);
    expect(getPlayer(g, 'P2').shipsAvailable).toBe(12);
    expect(g.ships.filter((s) =>
      s.owner === 'P1' && s.loc.type === 'gate' && s.loc.id === gate2).length).toBe(2);
    // +1 for the win, +1 for the destroyed ship.
    expect(getPlayer(g, 'P1').prestige).toBe(p1Before + 2);
    expect(getPlayer(g, 'P2').prestige).toBe(p2Before);
  });

  it('defender wins ties: attacker fleet destroyed at origin', () => {
    const g = freshGame(7);
    const core = g.map.sectorCoreNodeId;
    const [gate1, gate2] = gatesAt(g.map, core).slice(0, 2).map((gt) => gt.id);
    g.ships = [
      { owner: 'P1', loc: { type: 'gate', id: gate1! } },
      { owner: 'P2', loc: { type: 'gate', id: gate2! } },
    ];
    getPlayer(g, 'P1').shipsAvailable = 11;
    getPlayer(g, 'P2').shipsAvailable = 11;
    getPlayer(g, 'P1').hand = [];
    getPlayer(g, 'P2').hand = [];
    // One draw each, same size → tie → defender wins.
    const sizes1 = g.deck.filter((id) => card(id).size === 1).slice(0, 2);
    g.deck = [...sizes1, ...g.deck.filter((id) => !sizes1.includes(id))];

    const ctx = ctxFor('P1');
    const bs = newBattle({
      attacker: 'P1', defender: 'P2', battleGate: gate2!,
      attackerOrigin: { type: 'gate', id: gate1! }, attackerCruiserCount: 1,
    });
    expect(battleStep(g, ctx, bs)).toBe(true);
    expect(g.ships.filter((s) => s.owner === 'P1').length).toBe(0);
    expect(getPlayer(g, 'P1').shipsAvailable).toBe(12);
    // Defender: +1 win, +1 destroyed attacker ship.
    expect(getPlayer(g, 'P2').prestige).toBe(2);
  });
});

describe('reinforcement legality (p.34)', () => {
  it('matches against Impulse/Plan/Researched techs but never Minerals', () => {
    const g = freshGame(11);
    const p1 = getPlayer(g, 'P1');
    // Give P1 a known hand card and craft anchors.
    const handCard = g.deck[0]!;
    p1.hand = [handCard];
    const twin = g.deck.find((id) =>
      id !== handCard &&
      card(id).size === card(handCard).size &&
      card(id).color === card(handCard).color)!;

    g.impulse = [];
    p1.plan = [];
    p1.minerals = [];
    expect(isValidReinforcement(g, 'P1', handCard)).toBe(false);

    p1.minerals = [twin]; // minerals do NOT anchor
    expect(isValidReinforcement(g, 'P1', handCard)).toBe(false);

    p1.minerals = [];
    g.impulse = [twin];
    expect(isValidReinforcement(g, 'P1', handCard)).toBe(true);

    g.impulse = [];
    p1.plan = [twin];
    expect(isValidReinforcement(g, 'P1', handCard)).toBe(true);

    p1.plan = [];
    p1.techLeft = { type: 'researched', cardId: twin };
    expect(isValidReinforcement(g, 'P1', handCard)).toBe(true);
  });
});

describe('cruiser patrol-through pathing (p.29)', () => {
  it('offers a patrolled passage only when the destination gate holds an enemy, and battle ends the path', () => {
    const g = freshGame(13);
    const core = g.map.sectorCoreNodeId;
    const coreGates = gatesAt(g.map, core).map((gt) => gt.id);
    const [g0, g1, g2] = coreGates;
    // P1 cruiser on g0; P2 cruiser on g1 — P2 patrols the core card.
    g.ships = [
      { owner: 'P1', loc: { type: 'gate', id: g0! } },
      { owner: 'P2', loc: { type: 'gate', id: g1! } },
    ];
    // Make sure the core is explored-looking (it's the core — no card flip).
    const paths = enumeratePaths(g, 'P1', { type: 'gate', id: g0! }, 2);
    const endsAt = (gateId: number) => paths.filter((p) =>
      p[p.length - 1]!.type === 'gate' && p[p.length - 1]!.id === gateId);
    // Through-core to the EMPTY gate g2 must not be offered...
    expect(endsAt(g2!).filter((p) => p.length === 1)).toHaveLength(0);
    // ...but attacking g1 (the patroller's own gate) is offered,
    const battleSteps = endsAt(g1!).filter((p) => p.length === 1);
    expect(battleSteps.length).toBeGreaterThan(0);
    // and nothing continues past the battle gate.
    expect(paths.filter((p) =>
      p.length >= 2 && p[0]!.type === 'gate' && p[0]!.id === g1).length).toBe(0);
  });
});

describe('exploration', () => {
  it('transport onto a face-down card takes it to hand and pauses for the face-up placement', () => {
    const g = freshGame(17);
    const home = g.map.homeNodeIds['P1']!;
    const neighborGate = gatesAt(g.map, home)[0]!;
    const target = neighborGate.a === home ? neighborGate.b : neighborGate.a;
    const nc = g.nodeCards[target];
    expect(nc?.kind).toBe('faceDown');
    const hiddenCard = nc!.kind === 'faceDown' ? nc!.cardId : 0;

    g.ships = [{ owner: 'P1', loc: { type: 'node', id: home } }];
    const ctx = ctxFor('P1');
    const ms = newMovementState();
    ms.origin = { type: 'node', id: home };
    ms.chosenCount = 1;
    ms.path = [{ type: 'node', id: target }];

    const result = walkPath(g, ctx, ms);
    expect(result.status).toBe('paused');
    expect(ms.explorationNode).toBe(target);
    expect(getPlayer(g, 'P1').hand).toContain(hiddenCard);
    expect(ctx.pendingChoice?.type).toBe('selectHandCard');

    // Answer: place the taken card back face-up; movement then completes.
    ctx.pendingChoice!.answer = { cardId: hiddenCard } as never;
    expect(resumeInterrupts(g, ctx, ms)).toBe('none');
    const resumed = walkPath(g, ctx, ms);
    expect(resumed.status).toBe('arrived');
    expect(g.nodeCards[target]).toEqual({ kind: 'faceUp', cardId: hiddenCard });
    expect(g.ships[0]!.loc).toEqual({ type: 'node', id: target });
  });
});

describe('mid-effect serialization', () => {
  it('a game resumes identically from a JSON round-trip taken at a mid-effect prompt', () => {
    const picker = new Rng(0xbeef);
    let state = createGame({ playerCount: 2, seed: 2024 });
    let roundTripped = false;
    let steps = 0;
    while (!state.isGameOver && steps++ < 50_000) {
      if (!roundTripped && state.effect?.pendingChoice) {
        state = JSON.parse(JSON.stringify(state)) as ImpulseState;
        roundTripped = true;
      }
      const actor = impulseAdapter.currentActor(state)!;
      const legal = impulseAdapter.legalActions(state, actor);
      expect(legal.length).toBeGreaterThan(0);
      state = impulseAdapter.applyAction(state, picker.pick(legal), actor);
    }
    expect(roundTripped).toBe(true);
    expect(state.isGameOver).toBe(true);
  });
});

