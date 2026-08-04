// Plan families: move cards from hand/deck into the player's Plan (resolved
// in their Phase 4). Mid-resolution additions divert to NextPlan via
// Mechanics.addCardToPlan (rulebook p.37). Ported from C# PlanHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { addCardToPlan, ensureDeckCanDraw } from '../mechanics';
import {
  getPlayer,
  type CardColor, type EffectCtx, type ImpulseState, type SelectHandCardRequest,
} from '../types';
import { describeFilter, matches } from './common';

type PlanParams =
  // Up to maxCount hand cards matching the filter, player may stop early.
  | { type: 'fromHand'; maxCount: number; sizeFilter: number | null; colorFilter: CardColor | null }
  // Up to maxCount hand cards, each a different color from prior picks.
  | { type: 'differentColorsFromHand'; maxCount: number }
  // Draw count from deck; matching → Plan, non-matching → discard.
  | { type: 'fromDeck'; count: number; sizeFilter: number | null; colorFilter: CardColor | null; boostTarget: 'count' | 'size' }
  // Draw 1 unconditionally to Plan, then thenCount more filtered to its color.
  | { type: 'cardThenSameColorFromDeck'; thenCount: number };

const PARAMS_BY_CARD_ID: Record<number, PlanParams> = {
  8: { type: 'fromHand', maxCount: 2, sizeFilter: null, colorFilter: 'Blue' },
  14: { type: 'fromHand', maxCount: 2, sizeFilter: null, colorFilter: 'Yellow' },
  25: { type: 'fromHand', maxCount: 2, sizeFilter: null, colorFilter: 'Red' },
  34: { type: 'differentColorsFromHand', maxCount: 2 },
  // c49 "Plan two size [1] cards from the deck." → boost the size filter.
  49: { type: 'fromDeck', count: 2, sizeFilter: 1, colorFilter: null, boostTarget: 'size' },
  50: { type: 'fromHand', maxCount: 2, sizeFilter: 1, colorFilter: null },
  51: { type: 'cardThenSameColorFromDeck', thenCount: 2 },
  59: { type: 'fromHand', maxCount: 2, sizeFilter: null, colorFilter: 'Green' },
};

interface HandlerState { remaining: number; pickedSoFar: number[] }

function initState(ctx: EffectCtx, remaining: number): HandlerState {
  const st = (ctx.handlerState as HandlerState | null) ?? { remaining, pickedSoFar: [] };
  ctx.handlerState = st;
  return st;
}

function planFromHand(
  g: ImpulseState, ctx: EffectCtx,
  prms: Extract<PlanParams, { type: 'fromHand' }>,
): void {
  const p = getPlayer(g, ctx.seat);
  const boost = boostFromSource(g, ctx);
  const st = initState(ctx, prms.maxCount + boost);

  if (ctx.pendingChoice) {
    const req = ctx.pendingChoice as SelectHandCardRequest;
    ctx.pendingChoice = null;
    const picked = req.answer?.cardId ?? null;
    if (picked === null) { ctx.isComplete = true; return; }
    p.hand.splice(p.hand.indexOf(picked), 1);
    addCardToPlan(g, ctx.seat, picked);
    st.remaining--;
  }

  if (st.remaining <= 0) { ctx.isComplete = true; return; }

  const legal = p.hand.filter((id) => matches(card(id), prms.sizeFilter, prms.colorFilter));
  if (legal.length === 0) { ctx.isComplete = true; return; }

  ctx.pendingChoice = {
    type: 'selectHandCard',
    seat: ctx.seat,
    legalCardIds: legal,
    allowNone: true,
    noneLabel: 'DONE',
    prompt: `Plan a card matching ${describeFilter(prms.sizeFilter, prms.colorFilter)} ` +
      `(${st.remaining} remaining)${boost > 0 ? ` [+${boost} boost]` : ''}, or DONE.`,
  };
}

function planDifferentColors(
  g: ImpulseState, ctx: EffectCtx,
  prms: Extract<PlanParams, { type: 'differentColorsFromHand' }>,
): void {
  const p = getPlayer(g, ctx.seat);
  const st = initState(ctx, prms.maxCount + boostFromSource(g, ctx));

  if (ctx.pendingChoice) {
    const req = ctx.pendingChoice as SelectHandCardRequest;
    ctx.pendingChoice = null;
    const picked = req.answer?.cardId ?? null;
    if (picked === null) { ctx.isComplete = true; return; }
    p.hand.splice(p.hand.indexOf(picked), 1);
    st.pickedSoFar.push(picked);
    addCardToPlan(g, ctx.seat, picked);
    st.remaining--;
  }

  if (st.remaining <= 0) { ctx.isComplete = true; return; }

  const usedColors = new Set(st.pickedSoFar.map((id) => card(id).color));
  const legal = p.hand.filter((id) => !usedColors.has(card(id).color));
  if (legal.length === 0) { ctx.isComplete = true; return; }

  ctx.pendingChoice = {
    type: 'selectHandCard',
    seat: ctx.seat,
    legalCardIds: legal,
    allowNone: true,
    noneLabel: 'DONE',
    prompt: `Plan a card of a NEW color (${st.remaining} remaining), or DONE.`,
  };
}

function planFromDeck(
  g: ImpulseState, ctx: EffectCtx,
  prms: Extract<PlanParams, { type: 'fromDeck' }>,
): void {
  const boost = boostFromSource(g, ctx);
  const effectiveCount = prms.boostTarget === 'count' ? prms.count + boost : prms.count;
  const effectiveSize = prms.boostTarget === 'size' && prms.sizeFilter !== null
    ? prms.sizeFilter + boost : prms.sizeFilter;
  for (let i = 0; i < effectiveCount && ensureDeckCanDraw(g); i++) {
    const cardId = g.deck.shift()!;
    const c = card(cardId);
    if (matches(c, effectiveSize, prms.colorFilter)) {
      addCardToPlan(g, ctx.seat, cardId);
    } else {
      g.discard.push(cardId);
      log(g, {
        side: ctx.seat, kind: 'plan.reveal', payload: { cardId, outcome: 'discarded' },
        msg: `drew #${cardId} (${c.color}/${c.size}) — discard (${describeFilter(effectiveSize, prms.colorFilter)})`,
      });
    }
  }
  ctx.isComplete = true;
}

function planCardThenSameColor(
  g: ImpulseState, ctx: EffectCtx,
  prms: Extract<PlanParams, { type: 'cardThenSameColorFromDeck' }>,
): void {
  if (!ensureDeckCanDraw(g)) { ctx.isComplete = true; return; }
  const effectiveThen = prms.thenCount + boostFromSource(g, ctx);

  const firstId = g.deck.shift()!;
  const anchorColor = card(firstId).color;
  addCardToPlan(g, ctx.seat, firstId);

  for (let i = 0; i < effectiveThen && ensureDeckCanDraw(g); i++) {
    const cardId = g.deck.shift()!;
    const c = card(cardId);
    if (c.color === anchorColor) {
      addCardToPlan(g, ctx.seat, cardId);
    } else {
      g.discard.push(cardId);
      log(g, {
        side: ctx.seat, kind: 'plan.reveal', payload: { cardId, outcome: 'discarded' },
        msg: `drew #${cardId} (${c.color}/${c.size}) — discard (need ${anchorColor})`,
      });
    }
  }
  ctx.isComplete = true;
}

const planHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `plan: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    switch (prms.type) {
      case 'fromHand': return planFromHand(g, ctx, prms);
      case 'differentColorsFromHand': return planDifferentColors(g, ctx, prms);
      case 'fromDeck': return planFromDeck(g, ctx, prms);
      case 'cardThenSameColorFromDeck': return planCardThenSameColor(g, ctx, prms);
    }
  },
};

const FAMILIES = [
  'plan_n_color_from_hand',
  'plan_n_different_colors',
  'plan_n_size_from_deck',
  'plan_n_size_from_hand',
  'plan_card_then_n_same_color_from_deck',
];

export function registerPlan(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, planHandler);
}
