// Build families: pick one location, place `count` ships there. Ship type is
// derived from the location (node→transport, gate→cruiser); the filter
// constrains which location kinds are legal. Ported from C# BuildHandler +
// BuildHomeAndEachOccupiedHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { logInfo } from '../log';
import { gatesAt } from '../map';
import { buildShip } from '../mechanics';
import { hasEnemyCruiserOnGate } from '../movement';
import {
  getPlayer,
  type CardColor, type EffectCtx, type ImpulseState, type Seat,
  type SelectShipPlacementRequest, type ShipLocation,
} from '../types';

type BuildShipFilter = 'transportOnly' | 'cruiserOnly' | 'either';
type BuildLocationKind = 'home' | 'occupied';

function legalPlacements(
  g: ImpulseState, seat: Seat, filter: BuildShipFilter, locKind: BuildLocationKind,
): ShipLocation[] {
  // Rulebook p.36: "you cannot build a Cruiser on a gate containing another
  // player's Cruisers."
  const gateBlocked = (gid: number): boolean => hasEnemyCruiserOnGate(g, seat, gid);
  const result: ShipLocation[] = [];

  if (locKind === 'home') {
    const home = g.map.homeNodeIds[seat]!;
    if (filter !== 'cruiserOnly') result.push({ type: 'node', id: home });
    if (filter !== 'transportOnly') {
      for (const gt of gatesAt(g.map, home)) {
        if (!gateBlocked(gt.id)) result.push({ type: 'gate', id: gt.id });
      }
    }
    return result;
  }

  // "Occupied" = a node where the player has a transport (patrolling is not
  // occupying). Transports build there directly; cruisers on its gates.
  const transportNodes = [...new Set(
    g.ships
      .filter((sp) => sp.owner === seat && sp.loc.type === 'node')
      .map((sp) => sp.loc.id),
  )];
  if (filter !== 'cruiserOnly') {
    for (const nid of transportNodes) result.push({ type: 'node', id: nid });
  }
  if (filter !== 'transportOnly') {
    const seenGates = new Set<number>();
    for (const nid of transportNodes) {
      for (const gt of gatesAt(g.map, nid)) {
        if (!seenGates.has(gt.id) && !gateBlocked(gt.id)) {
          seenGates.add(gt.id);
          result.push({ type: 'gate', id: gt.id });
        }
      }
    }
  }
  return result;
}

function describeBuild(filter: BuildShipFilter, count: number): string {
  switch (filter) {
    case 'transportOnly': return `${count} transport(s)`;
    case 'cruiserOnly': return `${count} cruiser(s)`;
    case 'either': return `${count} ship(s)`;
  }
}

class BuildHandler implements EffectHandler {
  constructor(
    private count: number,
    private filter: BuildShipFilter,
    private locKind: BuildLocationKind,
  ) {}

  execute(g: ImpulseState, ctx: EffectCtx): void {
    const p = getPlayer(g, ctx.seat);
    if (p.shipsAvailable <= 0) {
      logInfo(g, `${ctx.seat} ship pool empty; build noop`);
      ctx.isComplete = true;
      return;
    }
    // Boost the count by mineral gems matching the card's color.
    const effectiveCount = this.count + boostFromSource(g, ctx);

    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectShipPlacementRequest;
      ctx.pendingChoice = null;
      const loc = req.answer!.loc;
      let built = 0;
      for (let i = 0; i < effectiveCount && p.shipsAvailable > 0; i++) {
        built += buildShip(g, ctx.seat, loc);
      }
      if (built < effectiveCount) {
        logInfo(g, `${ctx.seat} pool exhausted (${built}/${effectiveCount} built)`);
      }
      ctx.isComplete = true;
      return;
    }

    const legal = legalPlacements(g, ctx.seat, this.filter, this.locKind);
    if (legal.length === 0) {
      logInfo(g, `${ctx.seat} no legal Build location; noop`);
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'selectShipPlacement',
      seat: ctx.seat,
      legalLocations: legal,
      prompt: `Pick a location to Build ${describeBuild(this.filter, effectiveCount)}.`,
    };
  }
}

// "Build [1] ship at home and at each other [color] you occupy."
// handlerState: { stage, count, pendingNodes }.
interface HomeAndEachState {
  stage: 'awaitingHome' | 'awaitingMatch';
  count: number;
  pendingNodes: number[];
}

const HOME_AND_EACH_COLOR_BY_CARD_ID: Record<number, CardColor> = {
  32: 'Yellow',
  52: 'Green',
  57: 'Blue',
  62: 'Red',
};

const buildHomeAndEachOccupiedHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const colorFilter = HOME_AND_EACH_COLOR_BY_CARD_ID[srcId];
    if (!colorFilter) {
      logInfo(g, `build-home-and-each: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const st = ctx.handlerState as HomeAndEachState | null;

    const promptNextMatch = (state: HomeAndEachState): void => {
      if (state.pendingNodes.length === 0 || p.shipsAvailable <= 0) {
        ctx.isComplete = true;
        return;
      }
      const nid = state.pendingNodes.shift()!;
      const legal: ShipLocation[] = [{ type: 'node', id: nid }];
      for (const gt of gatesAt(g.map, nid)) {
        if (!hasEnemyCruiserOnGate(g, ctx.seat, gt.id)) legal.push({ type: 'gate', id: gt.id });
      }
      ctx.pendingChoice = {
        type: 'selectShipPlacement',
        seat: ctx.seat,
        legalLocations: legal,
        prompt: `Build ${state.count} ship(s) at the ${colorFilter} sector N${nid} you occupy ` +
          `(transport on the node, or cruiser on an adjacent gate). ` +
          `${state.pendingNodes.length} more sector(s) after this.`,
      };
      state.stage = 'awaitingMatch';
    };

    if (st === null) {
      const count = 1 + boostFromSource(g, ctx);
      if (p.shipsAvailable <= 0) {
        logInfo(g, `${ctx.seat} ship pool empty; build noop`);
        ctx.isComplete = true;
        return;
      }
      const home = g.map.homeNodeIds[ctx.seat]!;
      const legal: ShipLocation[] = [{ type: 'node', id: home }];
      for (const gt of gatesAt(g.map, home)) {
        if (!hasEnemyCruiserOnGate(g, ctx.seat, gt.id)) legal.push({ type: 'gate', id: gt.id });
      }
      ctx.handlerState = { stage: 'awaitingHome', count, pendingNodes: [] } satisfies HomeAndEachState;
      ctx.pendingChoice = {
        type: 'selectShipPlacement',
        seat: ctx.seat,
        legalLocations: legal,
        prompt: `Build ${count} ship(s) at home (transport on node, or cruiser on a home gate). ` +
          `You'll then be prompted again for each non-home ${colorFilter} sector you occupy.`,
      };
      return;
    }

    if (st.stage === 'awaitingHome') {
      const req = ctx.pendingChoice as SelectShipPlacementRequest;
      ctx.pendingChoice = null;
      const loc = req.answer!.loc;
      for (let i = 0; i < st.count && p.shipsAvailable > 0; i++) buildShip(g, ctx.seat, loc);

      // Each occupied non-home node whose face-up card matches the color.
      const home = g.map.homeNodeIds[ctx.seat]!;
      const matchNodes = [...new Set(
        g.ships
          .filter((sp) => sp.owner === ctx.seat && sp.loc.type === 'node' && sp.loc.id !== home)
          .map((sp) => sp.loc.id),
      )].filter((nid) => {
        const nc = g.nodeCards[nid];
        return nc?.kind === 'faceUp' && card(nc.cardId).color === colorFilter;
      });
      if (matchNodes.length === 0) {
        logInfo(g, `no other ${colorFilter} sector with your transport — only home gets ships`);
        ctx.isComplete = true;
        return;
      }
      st.pendingNodes = matchNodes;
      promptNextMatch(st);
      return;
    }

    // awaitingMatch
    const req = ctx.pendingChoice as SelectShipPlacementRequest;
    ctx.pendingChoice = null;
    const loc = req.answer!.loc;
    for (let i = 0; i < st.count && p.shipsAvailable > 0; i++) buildShip(g, ctx.seat, loc);
    promptNextMatch(st);
  },
};

const TABLE: Array<[string, number, BuildShipFilter, BuildLocationKind]> = [
  ['build_n_transport_at_home', 1, 'transportOnly', 'home'],
  ['build_n_cruiser_at_home', 1, 'cruiserOnly', 'home'],
  ['build_n_transport_at_occupied', 1, 'transportOnly', 'occupied'],
  ['build_n_cruiser_at_occupied', 1, 'cruiserOnly', 'occupied'],
  ['build_n_ships_at_occupied', 2, 'either', 'occupied'],
];

export function registerBuild(r: EffectRegistry): void {
  for (const [family, count, filter, locKind] of TABLE) {
    r.register(family, new BuildHandler(count, filter, locKind));
  }
  r.register('build_n_ship_home_and_each_occupied', buildHomeAndEachOccupiedHandler);
}
