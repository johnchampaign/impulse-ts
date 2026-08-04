// Draw families. Per rulebook (R/G/B/Y filter tooltip): "if a non-matching
// card is drawn, it would be discarded." Draw N from top, keep matching to
// hand, discard non-matching. Ported from C# DrawHandler + DrawRegistrations.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { ensureDeckCanDraw, HAND_LIMIT } from '../mechanics';
import { getPlayer, type CardColor } from '../types';

interface DrawOp {
  count: number;
  sizeFilter: number | null;
  colorFilter: CardColor[] | null;
}

interface DrawParams {
  ops: DrawOp[];
  boostOpIndex: number; // which op's count gets the mineral boost; -1 = none
}

const op = (count: number, sizeFilter: number | null, colorFilter: CardColor[] | null): DrawOp =>
  ({ count, sizeFilter, colorFilter });

// c1/etc: "Draw one [literal]; then draw [1] of color X/Y." Boost the second op.
const PARAMS_BY_CARD_ID: Record<number, DrawParams> = {
  1: { ops: [op(1, null, null), op(1, null, ['Red', 'Yellow'])], boostOpIndex: 1 },
  3: { ops: [op(1, null, null), op(1, null, ['Red', 'Green'])], boostOpIndex: 1 },
  80: { ops: [op(1, null, null), op(1, null, ['Blue', 'Red'])], boostOpIndex: 1 },
  87: { ops: [op(1, null, null), op(1, null, ['Green', 'Yellow'])], boostOpIndex: 1 },
  103: { ops: [op(1, null, null), op(1, null, ['Blue', 'Yellow'])], boostOpIndex: 1 },
  108: { ops: [op(1, null, null), op(1, null, ['Blue', 'Green'])], boostOpIndex: 1 },
  // Single-op cards: boost the only op.
  5: { ops: [op(2, null, null)], boostOpIndex: 0 },
  66: { ops: [op(3, 1, null)], boostOpIndex: 0 },
  90: { ops: [op(3, 1, null)], boostOpIndex: 0 },
};

function describeOp(o: DrawOp): string {
  const parts: string[] = [];
  if (o.sizeFilter !== null) parts.push(`size ${o.sizeFilter}`);
  if (o.colorFilter !== null) parts.push(`color ${o.colorFilter.join('/')}`);
  return parts.length === 0 ? 'no filter' : parts.join(', ');
}

const drawHandler: EffectHandler = {
  execute(g, ctx) {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `draw: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const boost = boostFromSource(g, ctx);
    for (let opIdx = 0; opIdx < prms.ops.length; opIdx++) {
      const o = prms.ops[opIdx]!;
      const effectiveCount = o.count + (opIdx === prms.boostOpIndex ? boost : 0);
      for (let i = 0; i < effectiveCount; i++) {
        if (!ensureDeckCanDraw(g)) {
          logInfo(g, 'deck empty; draw aborts');
          ctx.isComplete = true;
          return;
        }
        const cardId = g.deck.shift()!;
        const c = card(cardId);
        // Size filter is "up to N" per rulebook p.21.
        const sizeOk = o.sizeFilter === null || c.size <= o.sizeFilter;
        const colorOk = o.colorFilter === null || o.colorFilter.includes(c.color);
        if (sizeOk && colorOk) {
          if (p.hand.length >= HAND_LIMIT) {
            g.discard.push(cardId);
            log(g, {
              side: ctx.seat, kind: 'draw.reveal', payload: { cardId, outcome: 'discarded', reason: 'hand full' },
              msg: `${ctx.seat} drew #${cardId} (${c.color}/${c.size}) → discard (hand limit ${HAND_LIMIT})`,
            });
          } else {
            p.hand.push(cardId);
            log(g, {
              side: ctx.seat, kind: 'draw.reveal', payload: { cardId, outcome: 'kept' },
              msg: `${ctx.seat} drew #${cardId} (${c.color}/${c.size}) → hand`,
              secret: true,
            });
          }
        } else {
          g.discard.push(cardId);
          log(g, {
            side: ctx.seat, kind: 'draw.reveal', payload: { cardId, outcome: 'discarded', reason: describeOp(o) },
            msg: `${ctx.seat} drew #${cardId} (${c.color}/${c.size}) → discard (${describeOp(o)})`,
          });
        }
      }
    }
    ctx.isComplete = true;
  },
};

const FAMILIES = [
  'draw_one_then_one_of_two_colors',
  'draw_n_from_deck',
  'draw_n_size_from_deck',
];

export function registerDraw(r: EffectRegistry): void {
  for (const f of FAMILIES) r.register(f, drawHandler);
}
