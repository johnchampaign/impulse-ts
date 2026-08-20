// Battle resolution (rulebook p.34, race-card "BATTLE RULES" panel), shared
// between every handler that triggers battle. State machine driven through
// ctx.pendingChoice; handlers own a BattleState (plain JSON, inside their
// handlerState) and call battleStep each execute until it returns true.
// Ported from C# BattleResolver + DefenderChoice.
import { PROMPT } from './prompts';
import { card } from './catalog';
import { log, logInfo } from './log';
import { destroyShipAt, ensureDeckCanDraw, moveShip } from './mechanics';
import { addPrestige } from './scoring';
import {
  getPlayer,
  type EffectCtx, type ImpulseState, type Seat, type ShipLocation,
} from './types';

export type BattleStage =
  | 'start'
  | 'awaitingDefenderReinforce'
  | 'awaitingAttackerReinforce'
  | 'resolving'
  | 'done';

export interface BattleState {
  stage: BattleStage;
  attacker: Seat;
  defender: Seat;
  battleGate: number;
  attackerOrigin: ShipLocation;
  attackerCruiserCount: number;
  passageNode: number | null;
  attackerReinforcements: number[];
  defenderReinforcements: number[];
  attackerCruiserDraws: number[];
  defenderCruiserDraws: number[];
}

export function newBattle(init: {
  attacker: Seat; defender: Seat; battleGate: number;
  attackerOrigin: ShipLocation; attackerCruiserCount: number;
  passageNode?: number | null;
}): BattleState {
  return {
    stage: 'start',
    attacker: init.attacker,
    defender: init.defender,
    battleGate: init.battleGate,
    attackerOrigin: init.attackerOrigin,
    attackerCruiserCount: init.attackerCruiserCount,
    passageNode: init.passageNode ?? null,
    attackerReinforcements: [],
    defenderReinforcements: [],
    attackerCruiserDraws: [],
    defenderCruiserDraws: [],
  };
}

export function cruiserCountAt(g: ImpulseState, owner: Seat, gateId: number): number {
  return g.ships.filter((sp) =>
    sp.owner === owner && sp.loc.type === 'gate' && sp.loc.id === gateId).length;
}

// Reinforcement legality: card must match (size + color) of any card in the
// owner's Impulse, Plan, or Researched techs — NOT Minerals (p.34).
export function isValidReinforcement(g: ImpulseState, owner: Seat, handCardId: number): boolean {
  const c = card(handCardId);
  const p = getPlayer(g, owner);
  const matchesAny = (ids: number[]): boolean =>
    ids.some((id) => {
      const x = card(id);
      return x.size === c.size && x.color === c.color;
    });
  if (matchesAny(g.impulse)) return true;
  if (matchesAny(p.plan)) return true;
  if (p.techLeft.type === 'researched' && matchesAny([p.techLeft.cardId])) return true;
  if (p.techRight.type === 'researched' && matchesAny([p.techRight.cardId])) return true;
  // Basic techs have no card identity → cannot serve as a match anchor.
  return false;
}

/** Drives one step. Returns true when the battle is fully resolved. */
export function battleStep(g: ImpulseState, ctx: EffectCtx, bs: BattleState): boolean {
  if (bs.stage === 'start') {
    log(g, {
      kind: 'battle.start',
      payload: {
        gateId: bs.battleGate, attacker: bs.attacker, defender: bs.defender,
        attackerCruisers: bs.attackerCruiserCount, passageNode: bs.passageNode,
      },
      msg: `⚔ Battle at G${bs.battleGate}: ${bs.attacker} (${bs.attackerCruiserCount} cruisers) attacks ${bs.defender}`,
    });
    bs.stage = 'awaitingDefenderReinforce';
    return promptReinforce(g, ctx, bs, true);
  }

  if (bs.stage === 'awaitingDefenderReinforce') {
    if (ctx.pendingChoice?.type === 'selectHandCard') {
      const req = ctx.pendingChoice;
      ctx.pendingChoice = null;
      const picked = req.answer?.cardId ?? null;
      if (picked !== null) {
        const hand = getPlayer(g, bs.defender).hand;
        hand.splice(hand.indexOf(picked), 1);
        bs.defenderReinforcements.push(picked);
        log(g, {
          side: bs.defender, kind: 'battle.reinforce', payload: { cardId: picked },
          msg: `⚔ ${bs.defender} reinforces with #${picked}`,
          secret: true, // face-down until reveal
        });
        return promptReinforce(g, ctx, bs, true);
      }
      return closeCommitting(g, ctx, bs, true);
    }
    return promptReinforce(g, ctx, bs, true);
  }

  if (bs.stage === 'awaitingAttackerReinforce') {
    if (ctx.pendingChoice?.type === 'selectHandCard') {
      const req = ctx.pendingChoice;
      ctx.pendingChoice = null;
      const picked = req.answer?.cardId ?? null;
      if (picked !== null) {
        const hand = getPlayer(g, bs.attacker).hand;
        hand.splice(hand.indexOf(picked), 1);
        bs.attackerReinforcements.push(picked);
        log(g, {
          side: bs.attacker, kind: 'battle.reinforce', payload: { cardId: picked },
          msg: `⚔ ${bs.attacker} reinforces with #${picked}`,
          secret: true,
        });
        return promptReinforce(g, ctx, bs, false);
      }
      return closeCommitting(g, ctx, bs, false);
    }
    return promptReinforce(g, ctx, bs, false);
  }

  if (bs.stage === 'resolving') return resolve(g, ctx, bs);
  return true;
}

/** One side is done committing: publish HOW MANY cards it laid face-down, then
 *  hand off. The count is public at the table (rulebook p.34 — the cards are
 *  placed "face-down in front of them"), so unlike the per-card
 *  `battle.reinforce` entries this one is NOT secret; only the faces stay
 *  hidden until reveal. */
function closeCommitting(
  g: ImpulseState, ctx: EffectCtx, bs: BattleState, defender: boolean,
): boolean {
  const who = defender ? bs.defender : bs.attacker;
  const count = defender ? bs.defenderReinforcements.length : bs.attackerReinforcements.length;
  log(g, {
    side: who,
    kind: 'battle.commit',
    payload: { side: who, role: defender ? 'defender' : 'attacker', count },
    msg: count === 0
      ? `⚔ ${who} commits no cards face-down`
      : `⚔ ${who} commits ${count} card${count === 1 ? '' : 's'} face-down`,
  });
  if (defender) {
    bs.stage = 'awaitingAttackerReinforce';
    return promptReinforce(g, ctx, bs, false);
  }
  bs.stage = 'resolving';
  return resolve(g, ctx, bs);
}

function promptReinforce(g: ImpulseState, ctx: EffectCtx, bs: BattleState, defender: boolean): boolean {
  const who = defender ? bs.defender : bs.attacker;
  const hand = [...getPlayer(g, who).hand];
  if (hand.length === 0) {
    // No cards to reinforce/bluff with → auto-skip.
    return closeCommitting(g, ctx, bs, defender);
  }
  // Rulebook p.30: any face-down card may be committed, including bluffs that
  // don't match. Bluffs reveal and return to hand; only matches add icons.
  ctx.pendingChoice = {
    type: 'selectHandCard',
    seat: who,
    legalCardIds: hand,
    allowNone: true,
    noneLabel: 'PASS — no reinforcement',
    prompt: PROMPT.battleReinforce(
      who,
      defender,
      defender ? bs.defenderReinforcements.length : bs.attackerReinforcements.length,
      // The defender chooses blind; the attacker sees the defender's count.
      defender ? null : bs.defenderReinforcements.length,
    ),
  };
  return false;
}

function resolve(g: ImpulseState, ctx: EffectCtx, bs: BattleState): boolean {
  // Reveal: split reinforcements into matched (icons count) and bluffs
  // (return to hand), validity checked at reveal time.
  const split = (owner: Seat, ids: number[]): { matched: number[]; bluffs: number[] } => {
    const matched: number[] = [];
    const bluffs: number[] = [];
    for (const id of ids) (isValidReinforcement(g, owner, id) ? matched : bluffs).push(id);
    return { matched, bluffs };
  };
  const def = split(bs.defender, bs.defenderReinforcements);
  const att = split(bs.attacker, bs.attackerReinforcements);
  for (const [owner, bluffs] of [[bs.defender, def.bluffs], [bs.attacker, att.bluffs]] as const) {
    for (const id of bluffs) {
      getPlayer(g, owner).hand.push(id);
      const c = card(id);
      log(g, {
        side: owner, kind: 'battle.bluff', payload: { cardId: id },
        msg: `⚔ ${owner} BLUFF revealed #${id} (${c.color}/${c.size}) — returned to hand`,
      });
    }
  }

  // Per-cruiser draws (no filter): each side draws 1 card per cruiser.
  const defenderCruisers = cruiserCountAt(g, bs.defender, bs.battleGate);
  for (let i = 0; i < defenderCruisers && ensureDeckCanDraw(g); i++) {
    const id = g.deck.shift()!;
    bs.defenderCruiserDraws.push(id);
    const c = card(id);
    logInfo(g, `⚔ ${bs.defender} draws cruiser-card #${id} (${c.color}/${c.size})`);
  }
  for (let i = 0; i < bs.attackerCruiserCount && ensureDeckCanDraw(g); i++) {
    const id = g.deck.shift()!;
    bs.attackerCruiserDraws.push(id);
    const c = card(id);
    logInfo(g, `⚔ ${bs.attacker} draws cruiser-card #${id} (${c.color}/${c.size})`);
  }

  const sum = (ids: number[]): number => ids.reduce((s, id) => s + card(id).size, 0);
  const defenderTotal = sum(def.matched) + sum(bs.defenderCruiserDraws);
  const attackerTotal = sum(att.matched) + sum(bs.attackerCruiserDraws);

  // Defender wins ties (rulebook p.34).
  const attackerWon = attackerTotal > defenderTotal;
  const winner = attackerWon ? bs.attacker : bs.defender;

  // Destroy losing fleet.
  let destroyedCount = 0;
  if (attackerWon) {
    // Defender's cruisers at the battle gate destroyed.
    const victims = g.ships.filter((sp) =>
      sp.owner === bs.defender && sp.loc.type === 'gate' && sp.loc.id === bs.battleGate);
    for (const v of victims) {
      destroyShipAt(g, v.owner, v.loc, null);
      destroyedCount++;
    }
    // Patrol-through: ALL non-attacker transports on the passage node are
    // destroyed, not just the defender's (rulebook p.28 + BGG ruling
    // 2017-06-23, thread 1801001).
    if (bs.passageNode !== null) {
      const transports = g.ships.filter((sp) =>
        sp.owner !== bs.attacker && sp.loc.type === 'node' && sp.loc.id === bs.passageNode);
      for (const v of transports) {
        destroyShipAt(g, v.owner, v.loc, null); // prestige awarded once below
        destroyedCount++;
      }
    }
    // Move attacker's cruisers from origin to the battle gate.
    for (let i = 0; i < bs.attackerCruiserCount; i++) {
      moveShip(g, bs.attacker, bs.attackerOrigin, { type: 'gate', id: bs.battleGate });
    }
  } else {
    // Attacker's moving cruisers (still at origin) destroyed.
    for (let i = 0; i < bs.attackerCruiserCount; i++) {
      destroyShipAt(g, bs.attacker, bs.attackerOrigin, null);
      destroyedCount++;
    }
  }

  // Score winner: +1 for the win, +1 per ship destroyed.
  addPrestige(g, winner, 1, 'battleWon');
  if (destroyedCount > 0) addPrestige(g, winner, destroyedCount, 'shipsDestroyed');

  // Discard all cards used in battle (bluffs already went back to hand).
  g.discard.push(...att.matched, ...def.matched, ...bs.attackerCruiserDraws, ...bs.defenderCruiserDraws);

  const cards = (ids: number[]): string => ids.length === 0
    ? '(none)'
    : ids.map((id) => {
        const c = card(id);
        return `#${id} (${c.color}/${c.size})`;
      }).join(', ');
  log(g, {
    kind: 'battle.result',
    payload: {
      gateId: bs.battleGate,
      attacker: bs.attacker, defender: bs.defender, winner,
      attackerTotal, defenderTotal, destroyedCount,
      attackerMatched: att.matched, defenderMatched: def.matched,
      attackerBluffs: att.bluffs, defenderBluffs: def.bluffs,
      attackerCruiserDraws: bs.attackerCruiserDraws, defenderCruiserDraws: bs.defenderCruiserDraws,
    },
    msg: `⚔ BATTLE RESULT @ G${bs.battleGate}\n` +
      `Attacker ${bs.attacker}: reinforcements ${cards(att.matched)}; cruiser draws ${cards(bs.attackerCruiserDraws)}; total ${attackerTotal}\n` +
      `Defender ${bs.defender}: reinforcements ${cards(def.matched)}; cruiser draws ${cards(bs.defenderCruiserDraws)}; total ${defenderTotal}\n` +
      (attackerTotal === defenderTotal ? 'TIE — defender wins.\n' : '') +
      `Winner: ${winner} (+1 prestige, +${destroyedCount} for ships destroyed). ` +
      `${winner} prestige now ${getPlayer(g, winner).prestige}.`,
  });

  bs.stage = 'done';
  return true;
}

// Rulebook p.29: "If multiple players patrol the same card, the player moving
// ships can choose who to fight." Returns the chosen defender, or null when
// paused for the choice. Candidates persist on ctx.pendingDefenderCandidates.
export function resolveDefender(
  g: ImpulseState, ctx: EffectCtx, candidates: Seat[], promptText: string,
): Seat | null {
  if (candidates.length === 0) throw new Error('resolveDefender: no candidates');
  if (candidates.length === 1) return candidates[0]!;

  if (
    ctx.pendingDefenderCandidates &&
    ctx.pendingChoice?.type === 'selectFromOptions' &&
    ctx.pendingChoice.answer !== undefined
  ) {
    const idx = ctx.pendingChoice.answer.index;
    const chosen = ctx.pendingDefenderCandidates[idx];
    ctx.pendingChoice = null;
    ctx.pendingDefenderCandidates = null;
    if (chosen === undefined) throw new Error('resolveDefender: index out of range');
    return chosen;
  }

  ctx.pendingDefenderCandidates = candidates;
  ctx.pendingChoice = {
    type: 'selectFromOptions',
    seat: ctx.seat,
    options: candidates.map((p) => `Fight ${p}`),
    prompt: promptText,
  };
  return null;
}
