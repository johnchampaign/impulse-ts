// Trade: "discard cards from your hand or the deck to score points. A traded
// card is worth points equal to its size." Ported from C# TradeHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { discardFromHand, ensureDeckCanDraw } from '../mechanics';
import { addPrestige } from '../scoring';
import { getPlayer, type CardColor, type SelectHandCardRequest } from '../types';
import { describeFilter, matches } from './common';

type TradeSource = 'hand' | 'deck';
type TradeBoostTarget = 'count' | 'size';

interface TradeParams {
  maxCount: number;
  sizeFilter: number | null;
  colorFilter: CardColor | null;
  source: TradeSource;
  boostTarget: TradeBoostTarget;
}

const t = (
  maxCount: number, sizeFilter: number | null, colorFilter: CardColor | null,
  source: TradeSource, boostTarget: TradeBoostTarget,
): TradeParams => ({ maxCount, sizeFilter, colorFilter, source, boostTarget });

const PARAMS_BY_CARD_ID: Record<number, TradeParams> = {
  // [N][color] cards: boost the count.
  11: t(1, null, 'Red', 'hand', 'count'),
  16: t(1, null, 'Blue', 'hand', 'count'),
  17: t(1, null, 'Green', 'hand', 'count'),
  28: t(1, null, 'Yellow', 'hand', 'count'),
  36: t(1, null, 'Yellow', 'hand', 'count'),
  53: t(1, null, 'Blue', 'hand', 'count'),
  // c68 "Trade two size [1]" → boost size.
  68: t(2, 1, null, 'hand', 'size'),
  // c83 "Trade [1] size three" → boost count.
  83: t(1, 3, null, 'hand', 'count'),
  84: t(1, null, 'Red', 'hand', 'count'),
  // c95 "Trade [1] size one card from the deck" → boost count.
  95: t(1, 1, null, 'deck', 'count'),
  99: t(1, null, 'Green', 'hand', 'count'),
};

interface HandlerState { remaining: number }

const tradeHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `trade: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const boost = boostFromSource(g, ctx);
    const effectiveMax = prms.boostTarget === 'count' ? prms.maxCount + boost : prms.maxCount;
    const effectiveSize = prms.boostTarget === 'size' && prms.sizeFilter !== null
      ? prms.sizeFilter + boost : prms.sizeFilter;
    const st = (ctx.handlerState as HandlerState | null) ?? { remaining: effectiveMax };
    ctx.handlerState = st;

    // Resume after a hand pick (or decline).
    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId === null) {
        logInfo(g, `${ctx.seat} stops trading`);
        ctx.isComplete = true;
        return;
      }
      const traded = card(cardId);
      discardFromHand(g, ctx.seat, cardId);
      addPrestige(g, ctx.seat, traded.size, 'tradedCardIcons');
      st.remaining--;
      if (g.isGameOver) { ctx.isComplete = true; return; }
    }

    if (st.remaining <= 0) { ctx.isComplete = true; return; }

    if (prms.source === 'hand') {
      const legal = p.hand.filter((id) => matches(card(id), effectiveSize, prms.colorFilter));
      if (legal.length === 0) {
        logInfo(g, `${ctx.seat} no eligible card to trade`);
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectHandCard',
        seat: ctx.seat,
        legalCardIds: legal,
        allowNone: true,
        noneLabel: 'DONE',
        prompt: `Trade a card matching ${describeFilter(effectiveSize, prms.colorFilter)}, ` +
          `or DONE to stop (${st.remaining} remaining).`,
      };
      return;
    }

    // Deck source: automatic draw-and-evaluate, no prompts.
    for (let i = 0; i < effectiveMax && ensureDeckCanDraw(g); i++) {
      const cardId = g.deck.shift()!;
      const c = card(cardId);
      g.discard.push(cardId);
      if (matches(c, effectiveSize, prms.colorFilter)) {
        log(g, {
          side: ctx.seat, kind: 'trade.reveal', payload: { cardId, outcome: 'scored', prestige: c.size },
          msg: `${ctx.seat} draws #${cardId} (${c.color}/${c.size}) → traded (${c.size} pts)`,
        });
        addPrestige(g, ctx.seat, c.size, 'tradedCardIcons');
        if (g.isGameOver) { ctx.isComplete = true; return; }
      } else {
        log(g, {
          side: ctx.seat, kind: 'trade.reveal', payload: { cardId, outcome: 'discarded' },
          msg: `${ctx.seat} draws #${cardId} (${c.color}/${c.size}) → discard (filter mismatch)`,
        });
      }
    }
    ctx.isComplete = true;
  },
};

const FAMILIES = [
  'trade_n_color_from_hand',
  'trade_n_size_from_hand',
  'trade_n_size_from_deck',
];

export function registerTrade(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, tradeHandler);
}
