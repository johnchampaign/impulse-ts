// Mine: card from hand or deck → minerals (tucked under the Command Center).
// Deck source: non-matching draws are discarded. Ported from C# MineHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { ensureDeckCanDraw, moveCardFromHandToMinerals } from '../mechanics';
import { getPlayer, type CardColor, type SelectHandCardRequest } from '../types';
import { describeFilter, matches } from './common';

type MineSource = 'hand' | 'deck';
type MineBoostTarget = 'count' | 'size';

interface MineParams {
  count: number;
  size: number | null;
  color: CardColor | null;
  source: MineSource;
  boostTarget: MineBoostTarget;
}

const m = (
  count: number, size: number | null, color: CardColor | null,
  source: MineSource, boostTarget: MineBoostTarget,
): MineParams => ({ count, size, color, source, boostTarget });

// boostTarget identifies which [N] in the card text gets boosted:
//  - "Mine [N] cards / size X" → count
//  - "Mine X cards size [N]"  → size
//  - "Mine [N][color] card"   → count
const PARAMS_BY_CARD_ID: Record<number, MineParams> = {
  7: m(1, 1, null, 'hand', 'size'),
  19: m(1, 2, null, 'deck', 'count'),
  23: m(1, null, 'Red', 'hand', 'count'),
  29: m(1, null, 'Blue', 'hand', 'count'),
  58: m(1, 1, null, 'hand', 'size'),
  61: m(2, 1, null, 'deck', 'size'),
  72: m(1, null, 'Yellow', 'hand', 'count'),
  73: m(1, 1, null, 'deck', 'size'),
  85: m(1, null, 'Green', 'hand', 'count'),
  92: m(1, 2, null, 'hand', 'count'),
  93: m(2, 1, null, 'hand', 'size'),
  102: m(1, 1, null, 'deck', 'size'),
};

interface HandlerState { remaining: number }

const mineHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `mine: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const boost = boostFromSource(g, ctx);
    const effectiveCount = prms.boostTarget === 'count' ? prms.count + boost : prms.count;
    const effectiveSize = prms.boostTarget === 'size' && prms.size !== null
      ? prms.size + boost : prms.size;
    const st = (ctx.handlerState as HandlerState | null) ?? { remaining: effectiveCount };
    ctx.handlerState = st;

    // Resume after a hand pick.
    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId !== null) {
        moveCardFromHandToMinerals(g, ctx.seat, cardId);
        st.remaining--;
      }
    }

    if (st.remaining <= 0) { ctx.isComplete = true; return; }

    if (prms.source === 'hand') {
      const legal = p.hand.filter((id) => matches(card(id), effectiveSize, prms.color));
      if (legal.length === 0) {
        logInfo(g, `${ctx.seat} no eligible card in hand to mine`);
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectHandCard',
        seat: ctx.seat,
        legalCardIds: legal,
        allowNone: false,
        noneLabel: 'DONE',
        prompt: `Mine a card matching ${describeFilter(effectiveSize, prms.color)}.`,
      };
      return;
    }

    // Deck source: draw from top; matching → minerals, non-matching → discard.
    for (let i = 0; i < effectiveCount && ensureDeckCanDraw(g); i++) {
      const cardId = g.deck.shift()!;
      const c = card(cardId);
      if (matches(c, effectiveSize, prms.color)) {
        p.minerals.push(cardId);
        log(g, {
          side: ctx.seat, kind: 'mine.reveal', payload: { cardId, outcome: 'mined' },
          msg: `${ctx.seat} draws #${cardId} (${c.color}/${c.size}) → minerals`,
        });
      } else {
        g.discard.push(cardId);
        log(g, {
          side: ctx.seat, kind: 'mine.reveal', payload: { cardId, outcome: 'discarded' },
          msg: `${ctx.seat} draws #${cardId} (${c.color}/${c.size}) → discard (filter mismatch)`,
        });
      }
    }
    ctx.isComplete = true;
  },
};

const FAMILIES = [
  'mine_size_n_from_hand',
  'mine_n_color_from_hand',
  'mine_size_n_from_deck',
  'mine_n_size_from_deck',
  'mine_n_size_from_hand',
];

export function registerMine(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, mineHandler);
}
