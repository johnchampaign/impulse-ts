// Sabotage (rulebook p.36): destroy enemy ships without fighting head-on.
// Targets must be on cards you patrol (cruisers) or occupy (transports).
// Per bomb, reveal 1 deck card; each size 2+ reveal destroys 1 ship in the
// target fleet and scores a point. No points for overkill. Ported from C#
// SabotageHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { destroyShipAt, ensureDeckCanDraw } from '../mechanics';
import { locsEqual } from '../map';
import { playerControlsNode } from '../movement';
import {
  type EffectCtx, type ImpulseState, type SabotageTarget, type Seat,
  type SelectSabotageTargetRequest,
} from '../types';

type SabotageTargetFilter = 'transport' | 'cruiser' | 'either';

interface SabotageParams {
  bombs: number;
  target: SabotageTargetFilter;
}

const PARAMS_BY_CARD_ID: Record<number, SabotageParams> = {
  9: { bombs: 3, target: 'cruiser' },
  15: { bombs: 1, target: 'either' },
  24: { bombs: 3, target: 'transport' },
  45: { bombs: 2, target: 'either' },
  79: { bombs: 2, target: 'cruiser' },
  104: { bombs: 2, target: 'transport' },
};

interface State { stage: 'awaitingTarget' }

const sabotageHandler: EffectHandler = {
  execute(g: ImpulseState, ctx: EffectCtx): void {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `sabotage: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const boost = boostFromSource(g, ctx);
    const effectiveBombs = prms.bombs + boost;
    const st = ctx.handlerState as State | null;

    if (st === null) {
      const legal = legalTargets(g, ctx.seat, prms.target);
      if (legal.length === 0) {
        logInfo(g, `sabotage: no legal target for ${ctx.seat}`);
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectSabotageTarget',
        seat: ctx.seat,
        legalTargets: legal,
        prompt: `Choose enemy fleet to sabotage with ${effectiveBombs} bomb(s)` +
          (boost > 0 ? ` (+${boost} boost)` : '') + '.',
      };
      ctx.handlerState = { stage: 'awaitingTarget' } satisfies State;
      return;
    }

    const req = ctx.pendingChoice as SelectSabotageTargetRequest;
    ctx.pendingChoice = null;
    const target = req.legalTargets[req.answer!.index]!;
    if (target.owner === ctx.seat) {
      throw new Error(`sabotage cannot target own fleet (${ctx.seat})`);
    }

    let hits = 0;
    for (let i = 0; i < effectiveBombs; i++) {
      if (!ensureDeckCanDraw(g)) {
        logInfo(g, `bomb ${i + 1}: deck empty, abort`);
        break;
      }
      const drawn = g.deck.shift()!;
      const c = card(drawn);
      g.discard.push(drawn);
      if (c.size >= 2) {
        hits++;
        log(g, {
          side: ctx.seat, kind: 'sabotage.bomb', payload: { cardId: drawn, hit: true },
          msg: `bomb ${i + 1}: drew #${drawn} (${c.color}/${c.size}) — HIT`,
        });
      } else {
        log(g, {
          side: ctx.seat, kind: 'sabotage.bomb', payload: { cardId: drawn, hit: false },
          msg: `bomb ${i + 1}: drew #${drawn} (${c.color}/${c.size}) — miss`,
        });
      }
    }

    // Destroy up to `hits` ships of the target fleet. No overkill — prestige
    // is only awarded per actual destruction (destroyShipAt awards +1 each).
    const fleetSize = g.ships.filter((sp) =>
      sp.owner === target.owner && locsEqual(sp.loc, target.loc)).length;
    const toDestroy = Math.min(hits, fleetSize);
    log(g, {
      side: ctx.seat, kind: 'sabotage.result',
      payload: { target, hits, destroyed: toDestroy, fleetSize },
      msg: `Sabotage: ${hits} hit(s), destroying ${toDestroy}/${fleetSize} ship(s) of ${target.owner}`,
    });
    for (let i = 0; i < toDestroy; i++) {
      destroyShipAt(g, target.owner, target.loc, ctx.seat);
      if (g.isGameOver) break;
    }
    ctx.isComplete = true;
  },
};

function legalTargets(g: ImpulseState, mover: Seat, filter: SabotageTargetFilter): SabotageTarget[] {
  const result: SabotageTarget[] = [];

  if (filter !== 'cruiser') {
    // Transport-fleet targets: nodes the player controls (patrol or occupy)
    // where some enemy has transports.
    for (const node of g.map.nodes) {
      if (!playerControlsNode(g, mover, node.id)) continue;
      const enemyOwners = [...new Set(
        g.ships
          .filter((sp) => sp.owner !== mover && sp.loc.type === 'node' && sp.loc.id === node.id)
          .map((sp) => sp.owner),
      )];
      for (const owner of enemyOwners) {
        result.push({ owner, loc: { type: 'node', id: node.id } });
      }
    }
  }

  if (filter !== 'transport') {
    // Cruiser-fleet targets: gates with enemy cruisers where the player
    // controls at least one adjacent card.
    for (const gt of g.map.gates) {
      if (!playerControlsNode(g, mover, gt.a) && !playerControlsNode(g, mover, gt.b)) continue;
      const enemyOwners = [...new Set(
        g.ships
          .filter((sp) => sp.owner !== mover && sp.loc.type === 'gate' && sp.loc.id === gt.id)
          .map((sp) => sp.owner),
      )];
      for (const owner of enemyOwners) {
        result.push({ owner, loc: { type: 'gate', id: gt.id } });
      }
    }
  }

  return result;
}

const FAMILIES = [
  'sabotage_cruiser_fleet_n_bombs',
  'sabotage_fleet_n_bombs',
  'sabotage_transport_fleet_n_bombs',
];

export function registerSabotage(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, sabotageHandler);
}
