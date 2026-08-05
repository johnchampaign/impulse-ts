// AI opponent tests. The bar an AI has to clear is not "it runs": it must only
// ever return legal moves, be reproducible, actually beat random play, and not
// throw away the value its heuristics exist to capture.
import { describe, expect, it } from 'vitest';
import { Rng } from 'digital-boardgame-framework';
import { createGame, impulseAdapter } from '../src/adapter/impulseAdapter';
import { AI_POLICIES, pickAction, type AiPolicy } from '../src/ai/policy';
import { impulseAiControllers } from '../src/ai/controllers';
import { isValidReinforcement } from '../src/engine/battle';
import { CARDS, card } from '../src/engine/catalog';
import { advance, applyAction, legalActions } from '../src/engine/driver';
import { buildRegistry } from '../src/engine/handlers';
import { CORE_COLOR_DISPLAY_ORDER } from '../src/engine/handlers/movementExec';
import { gatesAt } from '../src/engine/map';
import { PROMPT, PROMPT_PREFIX, BATTLE_MARK } from '../src/engine/prompts';
import { newGame } from '../src/engine/setup';
import { getPlayer, type ImpulseState, type Seat } from '../src/engine/types';

const registry = buildRegistry();

/** Play a whole game with every seat on `policies`, asserting legality at each
 *  step. Returns the finished state. Mirrors how the server drives AI seats:
 *  each decision sees only that seat's redacted view. */
function playOut(playerCount: number, seed: number, policies: AiPolicy[]): ImpulseState {
  let state = createGame({ playerCount, seed });
  for (let step = 1; !state.isGameOver; step++) {
    if (step > 20_000) throw new Error('game did not finish');
    const actor = impulseAdapter.currentActor(state);
    expect(actor, 'currentActor must not be null mid-game').not.toBeNull();
    const policy = policies[Number(actor!.slice(1) as unknown as string) - 1] ?? policies[0]!;
    const view = impulseAdapter.viewFor(state, actor!);
    const legal = impulseAdapter.legalActions(view, actor!);
    expect(legal.length, `no legal actions for ${actor}`).toBeGreaterThan(0);
    const action = pickAction(view, actor!, policy, new Rng((seed * 31 + step) >>> 0), legal);
    const verdict = impulseAdapter.tryApplyAction!(state, action, actor!);
    expect(verdict.ok, `${policy} chose an illegal action: ${verdict.reason}`).toBe(true);
    state = verdict.state;
  }
  return state;
}

describe('AI legality and liveness', () => {
  it.each(AI_POLICIES)('%s plays a full 2p game legally against itself', (policy) => {
    const final = playOut(2, 4100 + AI_POLICIES.indexOf(policy), [policy, policy]);
    expect(final.isGameOver).toBe(true);
    expect(final.winner).not.toBeNull();
  });

  it('mixed policies finish at every supported player count', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const seats = Array.from({ length: n }, (_, i) => AI_POLICIES[i % AI_POLICIES.length]!);
      const final = playOut(n, 4200 + n, seats);
      expect(final.isGameOver).toBe(true);
      // Ship conservation still holds after an AI-driven game.
      for (const p of final.players) {
        const onMap = final.ships.filter((s) => s.owner === p.seat).length;
        expect(p.shipsAvailable + onMap).toBe(12);
      }
    }
  });
});

describe('AI determinism', () => {
  it('the same view + seed always yields the same move', () => {
    const state = createGame({ playerCount: 2, seed: 777 });
    const actor = impulseAdapter.currentActor(state)!;
    const view = impulseAdapter.viewFor(state, actor);
    const legal = impulseAdapter.legalActions(view, actor);
    const a = pickAction(view, actor, 'greedy', new Rng(5), legal);
    const b = pickAction(view, actor, 'greedy', new Rng(5), legal);
    expect(a).toEqual(b);
  });
});

describe('AI strength', () => {
  it('beats uniform random play by a wide margin', () => {
    // P1 = greedy policy, P2 = uniform random over the same legal actions.
    let aiWins = 0;
    const games = 24;
    for (let i = 0; i < games; i++) {
      const seed = 5200 + i;
      let state = createGame({ playerCount: 2, seed });
      for (let step = 1; !state.isGameOver; step++) {
        if (step > 20_000) break;
        const actor = impulseAdapter.currentActor(state)!;
        const view = impulseAdapter.viewFor(state, actor);
        const legal = impulseAdapter.legalActions(view, actor);
        const rng = new Rng((seed * 31 + step) >>> 0);
        const action = actor === 'P1'
          ? pickAction(view, actor, 'greedy', rng, legal)
          : rng.pick(legal);
        state = impulseAdapter.tryApplyAction!(state, action, actor).state;
      }
      if (state.winner === 'P1') aiWins++;
    }
    // Random play does occasionally stumble into a win; the AI should still
    // dominate. (Measured ~90%+ when written.)
    expect(aiWins / games).toBeGreaterThan(0.7);
  });
});

describe('prompt coupling', () => {
  // The AI distinguishes same-shaped prompts by text. These assertions fail if
  // the engine stops emitting the markers src/ai/policy.ts matches on.
  it('the engine emits the prefixes the AI keys off', () => {
    expect(PROMPT.homePick(8, 6, 41).startsWith(PROMPT_PREFIX.homePick)).toBe(true);
    expect(PROMPT.exploring(5).startsWith(PROMPT_PREFIX.exploring)).toBe(true);
    expect(PROMPT.sectorCoreColor(2).startsWith(PROMPT_PREFIX.sectorCoreColor)).toBe(true);
    expect(PROMPT.battleReinforce('P2', true).includes(BATTLE_MARK)).toBe(true);
  });

  it('the real home-pick prompt reaches the AI and it plays its best card', () => {
    const g = newGame({ playerCount: 2, seed: 91 }, registry);
    advance(g, registry);
    const req = g.effect!.pendingChoice!;
    expect(req.type).toBe('selectHandCard');
    expect(req.prompt.startsWith(PROMPT_PREFIX.homePick)).toBe(true);

    const seat = g.pending!.seat;
    const legal = legalActions(g, registry, seat);
    const chosen = pickAction(g, seat, 'greedy', new Rng(1), legal);
    // Home is the sector this seat activates most, so it should place a card
    // it actually wants there — not the weakest thing in hand.
    expect(chosen.kind).toBe('answer');
    const hand = getPlayer(g, seat).hand;
    const pickedId = chosen.kind === 'answer' && chosen.answer.type === 'handCard'
      ? chosen.answer.cardId : null;
    expect(pickedId).not.toBeNull();
    // A Draw card (the weakest type in the greedy table) shouldn't be the pick
    // when something better is available.
    const pickedType = card(pickedId!).actionType;
    const betterAvailable = hand.some((id) => card(id).actionType !== 'Draw');
    if (betterAvailable) expect(pickedType).not.toBe('Draw');
  });
});

describe('AI value decisions', () => {
  it('commits a matching battle reinforcement instead of a bluff, and passes with none', () => {
    const g = newGame({ playerCount: 2, seed: 92 }, registry);
    advance(g, registry);
    const seat: Seat = 'P1';
    const anchor = card(38); // Yellow/1
    g.impulse = [38];
    const match = CARDS.find((c) => c.color === anchor.color && c.size === anchor.size && c.id !== 38)!;
    const bluff = CARDS.find((c) => c.color !== anchor.color && c.size === 3)!;
    const p = getPlayer(g, seat);
    p.hand = [bluff.id, match.id];
    expect(isValidReinforcement(g, seat, match.id)).toBe(true);
    expect(isValidReinforcement(g, seat, bluff.id)).toBe(false);

    // Synthesise the battle reinforcement prompt the resolver would post.
    g.effect = {
      seat, source: { type: 'impulseCard', cardId: 38 },
      pendingChoice: {
        type: 'selectHandCard', seat,
        legalCardIds: [...p.hand], allowNone: true, noneLabel: 'PASS — no reinforcement',
        prompt: PROMPT.battleReinforce(seat, true),
      },
      handlerState: null, isComplete: false,
      transportBonusGems: 0, activationDepth: 0, pendingDefenderCandidates: null,
    };
    g.pending = { type: 'choice', seat };

    const legal = legalActions(g, registry, seat);
    const chosen = pickAction(g, seat, 'greedy', new Rng(2), legal);
    expect(chosen).toEqual({ kind: 'answer', answer: { type: 'handCard', cardId: match.id } });

    // With only a bluff in hand, PASS beats burning the card for nothing.
    p.hand = [bluff.id];
    g.effect.pendingChoice = {
      type: 'selectHandCard', seat,
      legalCardIds: [bluff.id], allowNone: true, noneLabel: 'PASS — no reinforcement',
      prompt: PROMPT.battleReinforce(seat, true),
    };
    const legal2 = legalActions(g, registry, seat);
    const chosen2 = pickAction(g, seat, 'greedy', new Rng(2), legal2);
    expect(chosen2).toEqual({ kind: 'answer', answer: { type: 'handCard', cardId: null } });
  });

  it('picks the Sector Core colour it actually holds gems in', () => {
    const g = newGame({ playerCount: 2, seed: 93 }, registry);
    advance(g, registry);
    const seat: Seat = 'P1';
    // Stock minerals in exactly one colour, then offer the colour choice.
    const green = CARDS.filter((c) => c.color === 'Green' && c.size === 3).slice(0, 2);
    getPlayer(g, seat).minerals = green.map((c) => c.id);
    g.effect = {
      seat, source: { type: 'impulseCard', cardId: 4 },
      pendingChoice: {
        type: 'selectFromOptions', seat,
        options: CORE_COLOR_DISPLAY_ORDER.map((c) => `${c}: …`),
        prompt: PROMPT.sectorCoreColor(1),
      },
      handlerState: null, isComplete: false,
      transportBonusGems: 0, activationDepth: 0, pendingDefenderCandidates: null,
    };
    g.pending = { type: 'choice', seat };

    const legal = legalActions(g, registry, seat);
    const chosen = pickAction(g, seat, 'greedy', new Rng(3), legal);
    const greenIndex = CORE_COLOR_DISPLAY_ORDER.indexOf('Green');
    expect(chosen).toEqual({ kind: 'answer', answer: { type: 'options', index: greenIndex } });
  });

  it('refuses to move a cruiser off a Sector Core gate when another fleet can move', () => {
    // Core-gate cruisers earn +1/turn from patrol scoring, so the AI should
    // prefer any other origin (the C# "stickiness" heuristic).
    const g = newGame({ playerCount: 2, seed: 94 }, registry);
    advance(g, registry);
    const seat: Seat = 'P1';
    const coreGate = gatesAt(g.map, g.map.sectorCoreNodeId)[0]!.id;
    const home = g.map.homeNodeIds[seat]!;
    g.ships = [
      { owner: seat, loc: { type: 'gate', id: coreGate } },
      { owner: seat, loc: { type: 'node', id: home } },
    ];
    g.effect = {
      seat, source: { type: 'impulseCard', cardId: 4 },
      pendingChoice: {
        type: 'selectFleet', seat, allowSkip: false,
        legalLocations: [{ type: 'gate', id: coreGate }, { type: 'node', id: home }],
        prompt: 'Select a ship fleet to Command.',
      },
      handlerState: null, isComplete: false,
      transportBonusGems: 0, activationDepth: 0, pendingDefenderCandidates: null,
    };
    g.pending = { type: 'choice', seat };
    const legal = legalActions(g, registry, seat);
    const chosen = pickAction(g, seat, 'greedy', new Rng(4), legal);
    expect(chosen).toEqual({
      kind: 'answer', answer: { type: 'fleet', loc: { type: 'node', id: home } },
    });
  });
});

describe('AI controllers (server wiring)', () => {
  it('exposes one controller per policy and each returns a legal action', async () => {
    expect(Object.keys(impulseAiControllers).sort()).toEqual([...AI_POLICIES].sort());
    const state = createGame({ playerCount: 2, seed: 95 });
    const actor = impulseAdapter.currentActor(state)!;
    for (const [key, ctrl] of Object.entries(impulseAiControllers)) {
      const view = impulseAdapter.viewFor(state, actor);
      const action = await ctrl.selectAction({
        state: view, actor, adapter: impulseAdapter, rng: new Rng(9),
      });
      const verdict = impulseAdapter.tryApplyAction!(state, action, actor);
      expect(verdict.ok, `${key} produced an illegal action`).toBe(true);
    }
  });
});
