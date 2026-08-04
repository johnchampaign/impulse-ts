// 3-4-5-4-3 hex (19 nodes), center = Sector Core, gates between every pair of
// axial-adjacent nodes. Per-player-count home assignments match rulebook p.5
// (corner placement adapted to seat count). Ported from C# MapFactory.
import type { MapGate, MapNode, SectorMapData, Seat, ShipLocation } from './types';

const HEX_AXIAL: ReadonlyArray<readonly [number, number]> = [
  // Row 1 (3 hexes)
  [0, -2], [1, -2], [2, -2],
  // Row 2 (4 hexes)
  [-1, -1], [0, -1], [1, -1], [2, -1],
  // Row 3 (5 hexes) — center row, middle is Sector Core
  [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0],
  // Row 4 (4 hexes)
  [-2, 1], [-1, 1], [0, 1], [1, 1],
  // Row 5 (3 hexes)
  [-2, 2], [-1, 2], [0, 2],
];

const HEX_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1],
];

// Outer-ring corner positions of the 3-4-5-4-3 hex.
const TL = [0, -2] as const;
const TR = [2, -2] as const;
const ML = [-2, 0] as const;
const MR = [2, 0] as const;
const BL = [-2, 2] as const;
const BR = [0, 2] as const;

// Per-player-count home assignments per rulebook p.5 setup map.
const HOMES_BY_COUNT: Record<number, ReadonlyArray<readonly [number, number]>> = {
  2: [ML, MR],
  3: [ML, TR, BR],
  4: [TL, TR, BL, BR],
  5: [TL, TR, ML, BL, BR],
  6: [TL, TR, ML, MR, BL, BR],
};

export function buildMap(seats: Seat[]): SectorMapData {
  const corners = HOMES_BY_COUNT[seats.length] ?? [TL, TR, ML, MR, BL, BR];
  const nodes: MapNode[] = [];
  const homeNodeIds: Record<Seat, number> = {};
  let sectorCoreNodeId = 0;

  HEX_AXIAL.forEach(([q, r], i) => {
    const id = i + 1;
    const isCore = q === 0 && r === 0;
    if (isCore) sectorCoreNodeId = id;
    const cornerIdx = corners.findIndex(([cq, cr]) => cq === q && cr === r);
    let owner: Seat | null = null;
    let isHome = false;
    if (cornerIdx >= 0 && cornerIdx < seats.length) {
      owner = seats[cornerIdx]!;
      isHome = true;
      homeNodeIds[owner] = id;
    }
    nodes.push({ id, q, r, isHome, owner, isSectorCore: isCore });
  });

  const gates: MapGate[] = [];
  const seen = new Set<string>();
  let gateId = 1;
  for (const n of nodes) {
    for (const [dq, dr] of HEX_NEIGHBORS) {
      const neighbor = nodes.find((x) => x.q === n.q + dq && x.r === n.r + dr);
      if (!neighbor) continue;
      const key = n.id < neighbor.id ? `${n.id}-${neighbor.id}` : `${neighbor.id}-${n.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = n.id < neighbor.id ? [n.id, neighbor.id] : [neighbor.id, n.id];
      gates.push({ id: gateId++, a, b });
    }
  }

  return { nodes, gates, sectorCoreNodeId, homeNodeIds };
}

export function node(map: SectorMapData, id: number): MapNode {
  const n = map.nodes.find((n) => n.id === id);
  if (!n) throw new Error(`unknown node N${id}`);
  return n;
}

export function gate(map: SectorMapData, id: number): MapGate {
  const g = map.gates.find((g) => g.id === id);
  if (!g) throw new Error(`unknown gate G${id}`);
  return g;
}

/** Gates touching a node. */
export function gatesAt(map: SectorMapData, nodeId: number): MapGate[] {
  return map.gates.filter((g) => g.a === nodeId || g.b === nodeId);
}

export function otherEndpoint(g: MapGate, nodeId: number): number {
  return g.a === nodeId ? g.b : g.a;
}

export function locKey(loc: ShipLocation): string {
  return `${loc.type}:${loc.id}`;
}

export function locsEqual(a: ShipLocation, b: ShipLocation): boolean {
  return a.type === b.type && a.id === b.id;
}

export function locStr(loc: ShipLocation): string {
  return loc.type === 'node' ? `N${loc.id}` : `G${loc.id}`;
}
