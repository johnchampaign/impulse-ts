// Movement legality: transports walk node→adjacent node; cruisers walk
// gate→gate sharing a node. Ported from C# Movement (battle/exploration
// enforcement notes preserved for when those sub-machines land).
import { gate, gatesAt, locKey, otherEndpoint } from './map';
import type { ImpulseState, Seat, ShipLocation } from './types';

export function neighbors(g: ImpulseState, loc: ShipLocation): ShipLocation[] {
  if (loc.type === 'node') {
    return gatesAt(g.map, loc.id).map((gt) => ({
      type: 'node' as const,
      id: otherEndpoint(gt, loc.id),
    }));
  }
  const gt = gate(g.map, loc.id);
  const result = new Map<string, ShipLocation>();
  for (const nid of [gt.a, gt.b]) {
    for (const adj of gatesAt(g.map, nid)) {
      if (adj.id === loc.id) continue;
      const l: ShipLocation = { type: 'gate', id: adj.id };
      result.set(locKey(l), l);
    }
  }
  return [...result.values()];
}

// Enumerate paths of length 1..maxMoves. Transport: cannot move ONTO a card
// patrolled by an enemy. Cruiser: gate→gate through an enemy-patrolled card
// is only legal if the destination gate has an enemy cruiser to fight
// (rulebook p.29); a battle-resolving step terminates the path.
export function enumeratePaths(
  g: ImpulseState, mover: Seat, origin: ShipLocation, maxMoves: number,
): ShipLocation[][] {
  const results: ShipLocation[][] = [];
  walk(g, mover, origin, maxMoves, [], results);
  return results;
}

function walk(
  g: ImpulseState, mover: Seat, here: ShipLocation, remaining: number,
  current: ShipLocation[], results: ShipLocation[][],
): void {
  if (remaining === 0) return;
  for (const step of neighbors(g, here)) {
    if (isBlockedFor(g, mover, step)) continue;

    let battleEndsTheStep = false;
    if (here.type === 'gate' && step.type === 'gate') {
      const passage = sharedNode(g, here.id, step.id);
      if (
        passage !== null &&
        isPatrolledByEnemy(g, mover, passage) &&
        !hasEnemyCruiserOnGate(g, mover, step.id)
      ) {
        continue; // patrolled passage, no enemy at destination — illegal
      }
      if (hasEnemyCruiserOnGate(g, mover, step.id)) battleEndsTheStep = true;
    }

    current.push(step);
    results.push([...current]);
    if (!battleEndsTheStep) walk(g, mover, step, remaining - 1, current, results);
    current.pop();
  }
}

export function isBlockedFor(g: ImpulseState, mover: Seat, dest: ShipLocation): boolean {
  return dest.type === 'node' ? isPatrolledByEnemy(g, mover, dest.id) : false;
}

/** The node both gates share, or null if disjoint. */
export function sharedNode(g: ImpulseState, fromGate: number, toGate: number): number | null {
  if (fromGate === toGate) return null;
  const a = gate(g.map, fromGate);
  const b = gate(g.map, toGate);
  if (a.a === b.a || a.a === b.b) return a.a;
  if (a.b === b.a || a.b === b.b) return a.b;
  return null;
}

export function hasEnemyCruiserOnGate(g: ImpulseState, mover: Seat, gateId: number): boolean {
  return g.ships.some((sp) => sp.owner !== mover && sp.loc.type === 'gate' && sp.loc.id === gateId);
}

export function isPatrolledByEnemy(g: ImpulseState, mover: Seat, nodeId: number): boolean {
  const ids = new Set(gatesAt(g.map, nodeId).map((gt) => gt.id));
  return g.ships.some((sp) => sp.owner !== mover && sp.loc.type === 'gate' && ids.has(sp.loc.id));
}

export function playerOccupiesNode(g: ImpulseState, seat: Seat, nodeId: number): boolean {
  return g.ships.some((sp) => sp.owner === seat && sp.loc.type === 'node' && sp.loc.id === nodeId);
}

export function playerPatrolsNode(g: ImpulseState, seat: Seat, nodeId: number): boolean {
  const ids = new Set(gatesAt(g.map, nodeId).map((gt) => gt.id));
  return g.ships.some((sp) => sp.owner === seat && sp.loc.type === 'gate' && ids.has(sp.loc.id));
}

export function playerControlsNode(g: ImpulseState, seat: Seat, nodeId: number): boolean {
  return playerOccupiesNode(g, seat, nodeId) || playerPatrolsNode(g, seat, nodeId);
}
