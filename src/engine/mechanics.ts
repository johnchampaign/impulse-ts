// Centralized mutators. Rules code goes through here, never touches the
// arrays directly. Ported from C# Mechanics.
import { card } from './catalog';
import { locsEqual, locStr } from './map';
import { log, logInfo } from './log';
import { withRng } from './rng';
import { addPrestige } from './scoring';
import {
  getPlayer,
  type ImpulseState, type Seat, type ShipLocation, type TechSlotName,
} from './types';

export const HAND_LIMIT = 10;

// Rulebook p.12: shuffle discard into deck when deck empty. Returns true if
// at least one card is available to draw after refilling.
export function ensureDeckCanDraw(g: ImpulseState): boolean {
  if (g.deck.length > 0) return true;
  if (g.discard.length === 0) return false;
  refillDeckFromDiscard(g);
  return g.deck.length > 0;
}

export function refillDeckFromDiscard(g: ImpulseState): void {
  if (g.discard.length === 0) return;
  log(g, {
    kind: 'deck.refill', payload: { count: g.discard.length },
    msg: `deck empty — shuffling ${g.discard.length} discard(s) into deck`,
  });
  const shuffled = withRng(g, (rng) => rng.shuffle(g.discard));
  g.discard.length = 0;
  g.deck.push(...shuffled);
}

export function drawFromDeck(g: ImpulseState, seat: Seat, n: number): number {
  const p = getPlayer(g, seat);
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    // Rulebook p.16: hand limit is 10 except during exploration.
    if (p.hand.length >= HAND_LIMIT) break;
    if (!ensureDeckCanDraw(g)) break;
    const id = g.deck.shift()!;
    p.hand.push(id);
    drawn++;
  }
  if (drawn > 0) {
    log(g, {
      side: seat, kind: 'draw', payload: { count: drawn, hand: p.hand.length, deck: g.deck.length },
      msg: `${seat} draws ${drawn} (hand=${p.hand.length}, deck=${g.deck.length})`,
    });
  }
  return drawn;
}

export function discardFromHand(g: ImpulseState, seat: Seat, cardId: number): void {
  const p = getPlayer(g, seat);
  const i = p.hand.indexOf(cardId);
  if (i < 0) throw new Error(`${seat} hand does not contain card #${cardId}`);
  p.hand.splice(i, 1);
  g.discard.push(cardId);
  log(g, { side: seat, kind: 'discard', payload: { cardId }, msg: `${seat} discards #${cardId}` });
}

export function placeOnImpulse(g: ImpulseState, seat: Seat, cardId: number): void {
  const p = getPlayer(g, seat);
  const i = p.hand.indexOf(cardId);
  if (i < 0) throw new Error(`${seat} hand does not contain card #${cardId}`);
  p.hand.splice(i, 1);
  g.impulse.push(cardId);
  const c = card(cardId);
  log(g, {
    side: seat, kind: 'impulse.place', payload: { cardId },
    msg: `${seat} places #${cardId} (${c.actionType}/${c.color}/${c.size}) at bottom of Impulse`,
  });
}

export function trimImpulseTopTo(g: ImpulseState, cap: number): void {
  while (g.impulse.length > cap) {
    const id = g.impulse.shift()!;
    g.discard.push(id);
    log(g, {
      kind: 'impulse.trim', payload: { cardId: id, length: g.impulse.length },
      msg: `impulse trim #${id} (length now ${g.impulse.length})`,
    });
  }
}

export function moveShip(g: ImpulseState, owner: Seat, from: ShipLocation, to: ShipLocation): void {
  const sp = g.ships.find((s) => s.owner === owner && locsEqual(s.loc, from));
  if (!sp) throw new Error(`no ship of ${owner} at ${locStr(from)}`);
  sp.loc = to;
  log(g, {
    side: owner, kind: 'ship.move', payload: { from, to },
    msg: `${owner} moves ship ${locStr(from)} → ${locStr(to)}`,
  });
}

export function countShipsAt(g: ImpulseState, owner: Seat, loc: ShipLocation): number {
  return g.ships.filter((s) => s.owner === owner && locsEqual(s.loc, loc)).length;
}

export function ownersAt(g: ImpulseState, loc: ShipLocation): Seat[] {
  return [...new Set(g.ships.filter((s) => locsEqual(s.loc, loc)).map((s) => s.owner))];
}

export function moveCardFromHandToMinerals(g: ImpulseState, seat: Seat, cardId: number): void {
  const p = getPlayer(g, seat);
  const i = p.hand.indexOf(cardId);
  if (i < 0) throw new Error(`${seat} hand does not contain #${cardId}`);
  p.hand.splice(i, 1);
  p.minerals.push(cardId);
  const c = card(cardId);
  log(g, {
    side: seat, kind: 'mine', payload: { cardId, from: 'hand' },
    msg: `${seat} mines #${cardId} (${c.color}/${c.size}) hand → minerals`,
  });
}

export function refineMineral(g: ImpulseState, seat: Seat, cardId: number, prestige: number): void {
  const p = getPlayer(g, seat);
  const i = p.minerals.indexOf(cardId);
  if (i < 0) throw new Error(`${seat} minerals does not contain #${cardId}`);
  p.minerals.splice(i, 1);
  g.discard.push(cardId);
  const c = card(cardId);
  log(g, {
    side: seat, kind: 'refine', payload: { cardId, prestige },
    msg: `${seat} refines #${cardId} (${c.color}/${c.size}) minerals → discard`,
  });
  addPrestige(g, seat, prestige, 'refining');
}

// Destroy a single ship at the given location; returns it to the owner's
// pool. If attackerForPrestige is set, awards +1 prestige (shipsDestroyed).
export function destroyShipAt(
  g: ImpulseState, owner: Seat, loc: ShipLocation, attackerForPrestige: Seat | null,
): boolean {
  const i = g.ships.findIndex((s) => s.owner === owner && locsEqual(s.loc, loc));
  if (i < 0) return false;
  g.ships.splice(i, 1);
  getPlayer(g, owner).shipsAvailable++;
  log(g, {
    side: owner, kind: 'ship.destroyed', payload: { loc },
    msg: `${owner}'s ship at ${locStr(loc)} destroyed (returned to pool)`,
  });
  if (attackerForPrestige !== null) {
    addPrestige(g, attackerForPrestige, 1, 'shipsDestroyed');
  }
  return true;
}

export function researchInto(g: ImpulseState, seat: Seat, slot: TechSlotName, cardId: number): void {
  const p = getPlayer(g, seat);
  const oldTech = slot === 'left' ? p.techLeft : p.techRight;
  if (slot === 'left') p.techLeft = { type: 'researched', cardId };
  else p.techRight = { type: 'researched', cardId };
  log(g, {
    side: seat, kind: 'research', payload: { cardId, slot, replaced: oldTech },
    msg: `${seat} researches #${cardId} into slot ${slot}`,
  });
  // Basic techs are removed permanently — never deck cards (p.35: "Once
  // covered up, Basic Techs are gone!"). A researched card goes to discard.
  if (oldTech.type === 'researched') g.discard.push(oldTech.cardId);
}

export function addCardToPlan(g: ImpulseState, seat: Seat, cardId: number): void {
  const p = getPlayer(g, seat);
  if (g.isResolvingPlan) {
    // Rulebook p.37: cards added while the Plan resolves go to a NEW Plan.
    (p.nextPlan ??= []).push(cardId);
    log(g, {
      side: seat, kind: 'plan.add', payload: { cardId, to: 'nextPlan' },
      msg: `${seat} plans #${cardId} → NextPlan (mid-resolution)`,
    });
  } else {
    p.plan.push(cardId);
    log(g, {
      side: seat, kind: 'plan.add', payload: { cardId, to: 'plan' },
      msg: `${seat} plans #${cardId} → Plan (size now ${p.plan.length})`,
    });
  }
}

export function buildShip(g: ImpulseState, owner: Seat, loc: ShipLocation): number {
  const p = getPlayer(g, owner);
  if (p.shipsAvailable <= 0) return 0;
  p.shipsAvailable--;
  g.ships.push({ owner, loc });
  log(g, {
    side: owner, kind: 'ship.build', payload: { loc, available: p.shipsAvailable },
    msg: `${owner} builds at ${locStr(loc)} (available=${p.shipsAvailable})`,
  });
  return 1;
}

export { logInfo };
