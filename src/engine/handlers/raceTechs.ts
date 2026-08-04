// Basic Unique tech handlers — the four that don't need the Command movement
// machinery. Ariek and Herculese (fleet movement) land with the Command port;
// the Basic Common tech (Command-or-Build) lands then too. Ported from C#
// BasicUniqueTechHandlers.
import type { EffectHandler, EffectRegistry } from '../effects';
import { card } from '../catalog';
import { log, logInfo } from '../log';
import { gatesAt, otherEndpoint } from '../map';
import {
  buildShip, ensureDeckCanDraw, HAND_LIMIT, moveCardFromHandToMinerals, researchInto,
} from '../mechanics';
import { hasEnemyCruiserOnGate } from '../movement';
import {
  getPlayer,
  type SelectHandCardRequest, type SelectShipPlacementRequest,
  type SelectTechSlotRequest, type ShipLocation,
} from '../types';

// Piscesish: "Draw one size one card from the deck." (non-matching → discard)
const piscesishHandler: EffectHandler = {
  execute(g, ctx) {
    if (!ensureDeckCanDraw(g)) { ctx.isComplete = true; return; }
    const drawn = g.deck.shift()!;
    const c = card(drawn);
    const p = getPlayer(g, ctx.seat);
    if (c.size === 1) {
      if (p.hand.length >= HAND_LIMIT) {
        g.discard.push(drawn);
        logInfo(g, `Piscesish: drew #${drawn} → discard (hand limit ${HAND_LIMIT})`);
      } else {
        p.hand.push(drawn);
        log(g, {
          side: ctx.seat, kind: 'tech.piscesish', payload: { cardId: drawn, outcome: 'kept' },
          msg: `Piscesish: drew #${drawn} (${c.color}/${c.size}) → hand`,
          secret: true,
        });
      }
    } else {
      g.discard.push(drawn);
      logInfo(g, `Piscesish: drew #${drawn} (${c.color}/${c.size}) → discard (need size 1)`);
    }
    ctx.isComplete = true;
  },
};

// Caelumnites: "Mine one card from your hand. It must match color and size
// with the last card on the Impulse." (last = bottom-most, FAQ p.42)
const caelumnitesHandler: EffectHandler = {
  execute(g, ctx) {
    const p = getPlayer(g, ctx.seat);

    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId !== null) moveCardFromHandToMinerals(g, ctx.seat, cardId);
      ctx.isComplete = true;
      return;
    }

    if (g.impulse.length === 0) {
      logInfo(g, 'Caelumnites: Impulse is empty, no anchor card');
      ctx.isComplete = true;
      return;
    }
    const anchor = card(g.impulse[g.impulse.length - 1]!);
    const legal = p.hand.filter((id) => card(id).color === anchor.color && card(id).size === anchor.size);
    if (legal.length === 0) {
      logInfo(g, `Caelumnites: no hand card matches Impulse anchor (${anchor.color}/${anchor.size})`);
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'selectHandCard',
      seat: ctx.seat,
      legalCardIds: legal,
      allowNone: true,
      noneLabel: 'DONE',
      prompt: `Mine a hand card matching ${anchor.color}/${anchor.size}, or DONE.`,
    };
  },
};

// Draconians: "Research one card from your hand. It must match color and size
// with the last card on the Impulse." handlerState = picked card id.
const draconiansHandler: EffectHandler = {
  execute(g, ctx) {
    const p = getPlayer(g, ctx.seat);

    if (ctx.pendingChoice?.type === 'selectHandCard') {
      const req = ctx.pendingChoice;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId === null) { ctx.isComplete = true; return; }
      ctx.handlerState = cardId;
      ctx.pendingChoice = {
        type: 'selectTechSlot',
        seat: ctx.seat,
        incomingCardId: cardId,
        allowSkip: true,
        prompt: `Choose a tech slot to overwrite with #${cardId}, or SKIP to keep it in hand.`,
      };
      return;
    }

    if (ctx.pendingChoice?.type === 'selectTechSlot') {
      const req = ctx.pendingChoice as SelectTechSlotRequest;
      ctx.pendingChoice = null;
      const cardId = ctx.handlerState as number;
      const slot = req.answer?.slot ?? null;
      if (slot === null) {
        // Skip: card stays in hand (it was never removed).
        logInfo(g, `Draconians: research skipped — #${cardId} stays in hand`);
        ctx.isComplete = true;
        return;
      }
      p.hand.splice(p.hand.indexOf(cardId), 1);
      researchInto(g, ctx.seat, slot, cardId);
      ctx.isComplete = true;
      return;
    }

    if (g.impulse.length === 0) {
      logInfo(g, 'Draconians: Impulse is empty, no anchor card');
      ctx.isComplete = true;
      return;
    }
    const anchor = card(g.impulse[g.impulse.length - 1]!);
    const legal = p.hand.filter((id) => card(id).color === anchor.color && card(id).size === anchor.size);
    if (legal.length === 0) {
      logInfo(g, `Draconians: no hand card matches Impulse anchor (${anchor.color}/${anchor.size})`);
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'selectHandCard',
      seat: ctx.seat,
      legalCardIds: legal,
      allowNone: true,
      noneLabel: 'DONE',
      prompt: `Research a hand card matching ${anchor.color}/${anchor.size}, or DONE.`,
    };
  },
};

// Triangulumnists: "Build a Cruiser at home on an edge that touches an
// unexplored card." (p.36: not on a gate with an enemy Cruiser)
const triangulumnistsHandler: EffectHandler = {
  execute(g, ctx) {
    const p = getPlayer(g, ctx.seat);

    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectShipPlacementRequest;
      ctx.pendingChoice = null;
      buildShip(g, ctx.seat, req.answer!.loc);
      ctx.isComplete = true;
      return;
    }

    if (p.shipsAvailable <= 0) {
      logInfo(g, 'Triangulumnists: no ships available');
      ctx.isComplete = true;
      return;
    }
    const home = g.map.homeNodeIds[ctx.seat]!;
    const legal: ShipLocation[] = gatesAt(g.map, home)
      .filter((gt) => {
        const other = otherEndpoint(gt, home);
        const nc = g.nodeCards[other];
        if (nc?.kind !== 'faceDown') return false;
        return !hasEnemyCruiserOnGate(g, ctx.seat, gt.id);
      })
      .map((gt) => ({ type: 'gate', id: gt.id }));
    if (legal.length === 0) {
      logInfo(g, 'Triangulumnists: no home edge touches an unexplored card');
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'selectShipPlacement',
      seat: ctx.seat,
      legalLocations: legal,
      prompt: 'Build a Cruiser on a home edge that touches an unexplored card.',
    };
  },
};

export function registerRaceTechs(r: EffectRegistry): void {
  r.register('tech_basic_unique_piscesish', piscesishHandler);
  r.register('tech_basic_unique_caelumnites', caelumnitesHandler);
  r.register('tech_basic_unique_draconians', draconiansHandler);
  r.register('tech_basic_unique_triangulumnists', triangulumnistsHandler);
  // tech_basic_unique_ariek, tech_basic_unique_herculese and
  // _tech_basic_common land with the Command/movement port.
}
