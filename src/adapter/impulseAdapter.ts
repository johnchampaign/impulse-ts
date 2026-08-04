// Framework GameAdapter over the engine. The engine is the legality
// authority (tryApplyAction), per the framework's adapter-spec.
import { redactGameLog, type GameAdapter, type GameResult } from 'digital-boardgame-framework';
import {
  advance, applyAction as engineApply, IllegalActionError, legalActions as engineLegal,
} from '../engine/driver';
import { buildRegistry } from '../engine/handlers';
import { newGame, SCHEMA_VERSION, type SetupOptions } from '../engine/setup';
import type { ChoiceRequest, ImpulseAction, ImpulseState, Seat } from '../engine/types';

// Module-scoped registry cache (per-request GameServer factories share it).
const registry = buildRegistry();

export function createGame(opts: SetupOptions): ImpulseState {
  const g = newGame(opts, registry);
  advance(g, registry);
  return g;
}

const HIDDEN_CARD = 0; // masked card id in redacted views

function redactChoice(req: ChoiceRequest, viewer: Seat | null): ChoiceRequest {
  if (viewer === req.seat) return req;
  // Other seats see that a prompt exists (and its prompt text) but not
  // option lists that could leak hidden information (hand contents).
  switch (req.type) {
    case 'selectHandCard':
      return { ...req, legalCardIds: [] };
    default:
      return req;
  }
}

export const impulseAdapter: GameAdapter<ImpulseState, ImpulseAction, Seat> = {
  schemaVersion: SCHEMA_VERSION,

  migrate(_rawState: unknown, fromVersion: number): ImpulseState {
    throw new Error(`no migration path from schema v${fromVersion}`);
  },

  applyAction(state, action, actor) {
    const g = structuredClone(state);
    engineApply(g, registry, action, actor);
    return g;
  },

  tryApplyAction(state, action, actor) {
    try {
      const g = structuredClone(state);
      engineApply(g, registry, action, actor);
      return { state: g, ok: true };
    } catch (e) {
      if (e instanceof IllegalActionError) return { state, ok: false, reason: e.message };
      throw e;
    }
  },

  legalActions(state, actor) {
    return engineLegal(state, registry, actor);
  },

  currentActor(state) {
    if (state.isGameOver) return null;
    return state.pending?.seat ?? null;
  },

  viewFor(state, viewer) {
    const v = structuredClone(state);
    // RNG state would let a client predict shuffles and draws.
    v.rngState = 0;
    // Deck order and contents are hidden from everyone.
    v.deck = v.deck.map(() => HIDDEN_CARD);
    // Hands are hidden from everyone but their owner.
    for (const p of v.players) {
      if (p.seat !== viewer) p.hand = p.hand.map(() => HIDDEN_CARD);
    }
    // Face-down exploration cards are hidden from everyone (including owner).
    for (const [nid, nc] of Object.entries(v.nodeCards)) {
      if (nc.kind === 'faceDown') v.nodeCards[Number(nid)] = { kind: 'faceDown', cardId: HIDDEN_CARD };
    }
    if (v.effect) {
      if (v.effect.seat !== viewer) v.effect.handlerState = null;
      if (v.effect.pendingChoice) {
        v.effect.pendingChoice = redactChoice(v.effect.pendingChoice, viewer);
      }
    }
    v.log = redactGameLog(v.log, viewer);
    return v;
  },

  result(state): GameResult<Seat> | null {
    if (!state.isGameOver) return null;
    const ranking = [...state.players]
      .sort((a, b) => b.prestige - a.prestige)
      .map((p) => p.seat);
    return {
      winners: state.winner ? [state.winner] : [],
      ranking,
    };
  },
};
