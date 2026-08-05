// Server-side AI opponents for online play. Each policy is exposed as a
// framework PlayerController so the GameServer drives AI seats itself — the
// human's client never picks the AI's moves (no rigging), and each policy earns
// its own leaderboard identity `ai:impulse:<policy>`.
//
// The keys are the difficulty/personality names passed as `ai: { P2: 'greedy' }`
// at createGame. Bump a key (e.g. 'greedy@2') if a policy's strength changes, so
// it earns a fresh rating instead of dragging the old one.
//
// Server-portable: this and its dependency chain (engine + ai/policy) are pure —
// no window/document/import.meta.env.
import type { PlayerController } from 'digital-boardgame-framework';
import type { ImpulseAction, ImpulseState, Seat } from '../engine/types';
import { AI_POLICIES, pickAction, type AiPolicy } from './policy';

function controllerFor(policy: AiPolicy): PlayerController<ImpulseState, ImpulseAction, Seat> {
  return {
    async selectAction(ctx) {
      const legal = ctx.adapter.legalActions(ctx.state, ctx.actor);
      if (legal.length === 0) throw new Error(`ai(${policy}): no legal actions for ${ctx.actor}`);
      try {
        return pickAction(ctx.state, ctx.actor, policy, ctx.rng, legal);
      } catch {
        // A scoring bug must never wedge a game: fall back to a legal move.
        return ctx.rng.pick(legal);
      }
    },
  };
}

export const impulseAiControllers: Record<string, PlayerController<ImpulseState, ImpulseAction, Seat>> =
  Object.fromEntries(AI_POLICIES.map((p) => [p, controllerFor(p)]));

/** Policy names offered in the lobby, with a one-line description each. */
export const AI_POLICY_LABELS: Record<AiPolicy, string> = {
  greedy: 'Greedy — chases the quickest prestige (trade + refine)',
  warrior: 'Warrior — builds cruisers and looks for fights',
  corerush: 'Core Rush — races for the Sector Core and holds it',
  munchkin: 'Munchkin — ganks whoever is in the lead',
  refine: 'Refiner — mines minerals and cashes them in',
};
