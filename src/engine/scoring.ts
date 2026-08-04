// Prestige. All mutations flow through addPrestige; win check is continuous
// (Impulserules: prestige >= 20 ends the game immediately, mid-effect too).
import { gatesAt } from './map';
import { log } from './log';
import { getPlayer, type ImpulseState, type Seat } from './types';

export const WIN_THRESHOLD = 20;

export type PrestigeSource =
  | 'sectorCoreGatesPatrolled'
  | 'sectorCoreActivatedByTransports'
  | 'tradedCardIcons'
  | 'refining'
  | 'battleWon'
  | 'shipsDestroyed';

export function addPrestige(
  g: ImpulseState, seat: Seat, amount: number, source: PrestigeSource,
): void {
  if (amount <= 0) return;
  const p = getPlayer(g, seat);
  p.prestige += amount;
  log(g, {
    side: seat, kind: 'prestige.gain',
    payload: { amount, source, total: p.prestige },
    msg: `+${amount} prestige (${source}) → ${seat} total ${p.prestige}`,
  });
  if (!g.isGameOver && p.prestige >= WIN_THRESHOLD) {
    g.isGameOver = true;
    g.phase = 'gameOver';
    g.winner = seat;
    g.pending = null;
    log(g, {
      side: seat, kind: 'game.over',
      payload: { winner: seat, prestige: p.prestige },
      msg: `=== ${seat} wins (prestige ${p.prestige}) ===`,
    });
  }
}

// Phase 5 (rulebook p.12): "Score 1 point for each of your fleets that
// patrols the Sector Core." A fleet = same-owner ships at one location;
// multiple cruisers on the same gate count as one fleet.
export function runPhase5(g: ImpulseState, seat: Seat): void {
  const coreGateIds = new Set(gatesAt(g.map, g.map.sectorCoreNodeId).map((gt) => gt.id));
  const patrolledFleets = new Set(
    g.ships
      .filter((sp) => sp.owner === seat && sp.loc.type === 'gate' && coreGateIds.has(sp.loc.id))
      .map((sp) => sp.loc.id),
  ).size;
  if (patrolledFleets > 0) {
    addPrestige(g, seat, patrolledFleets, 'sectorCoreGatesPatrolled');
  }
}
