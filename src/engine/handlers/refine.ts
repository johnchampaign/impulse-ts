// Refine: spend a mineral card for prestige (per-gem or flat). Ported from
// C# RefineHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { logInfo } from '../log';
import { refineMineral } from '../mechanics';
import { getPlayer, type CardColor, type SelectMineralCardRequest } from '../types';

type RefineMode = 'perGem' | 'flat';
type RefineBoostTarget = 'count' | 'perGemRate' | 'flatPoints';

interface RefineParams {
  count: number;
  color: CardColor | null;
  mode: RefineMode;
  flatPoints: number;
  perGemRate: number;
  boostTarget: RefineBoostTarget;
}

const PARAMS_BY_CARD_ID: Record<number, RefineParams> = {
  // c43 "Refine [1] mineral card for one point per gem." → boost the count.
  43: { count: 1, color: null, mode: 'perGem', flatPoints: 0, perGemRate: 1, boostTarget: 'count' },
  // c46/47/67/107 "Refine one [color] mineral card for [1] point per gem." → boost the rate.
  46: { count: 1, color: 'Yellow', mode: 'perGem', flatPoints: 0, perGemRate: 1, boostTarget: 'perGemRate' },
  47: { count: 1, color: 'Green', mode: 'perGem', flatPoints: 0, perGemRate: 1, boostTarget: 'perGemRate' },
  67: { count: 1, color: 'Blue', mode: 'perGem', flatPoints: 0, perGemRate: 1, boostTarget: 'perGemRate' },
  107: { count: 1, color: 'Red', mode: 'perGem', flatPoints: 0, perGemRate: 1, boostTarget: 'perGemRate' },
  // c106 "Refine one mineral card for [2] points." → boost the flat points.
  106: { count: 1, color: null, mode: 'flat', flatPoints: 2, perGemRate: 1, boostTarget: 'flatPoints' },
};

interface HandlerState { remaining: number }

const refineHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `refine: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const boost = boostFromSource(g, ctx);
    const effectiveCount = prms.boostTarget === 'count' ? prms.count + boost : prms.count;
    const effectivePerGemRate = prms.boostTarget === 'perGemRate' ? prms.perGemRate + boost : prms.perGemRate;
    const effectiveFlatPoints = prms.boostTarget === 'flatPoints' ? prms.flatPoints + boost : prms.flatPoints;
    const st = (ctx.handlerState as HandlerState | null) ?? { remaining: effectiveCount };
    ctx.handlerState = st;

    // Resume after a mineral pick.
    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectMineralCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId;
      if (cardId !== undefined) {
        const prestige = prms.mode === 'perGem'
          ? card(cardId).size * effectivePerGemRate
          : effectiveFlatPoints;
        refineMineral(g, ctx.seat, cardId, prestige);
        st.remaining--;
        if (g.isGameOver) { ctx.isComplete = true; return; }
      }
    }

    if (st.remaining <= 0) { ctx.isComplete = true; return; }

    const legal = p.minerals.filter((id) => prms.color === null || card(id).color === prms.color);
    if (legal.length === 0) {
      logInfo(g, `${ctx.seat} no matching mineral to refine`);
      ctx.isComplete = true;
      return;
    }

    ctx.pendingChoice = {
      type: 'selectMineralCard',
      seat: ctx.seat,
      legalCardIds: legal,
      prompt: prms.color !== null ? `Refine a ${prms.color} mineral card.` : 'Refine a mineral card.',
    };
  },
};

const FAMILIES = [
  'refine_n_mineral_card_per_gem',
  'refine_n_color_mineral_per_gem',
  'refine_n_mineral_card_flat_points',
];

export function registerRefine(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, refineHandler);
}
