// Rulebook p.22: boosting. Mineral cards matching the action card's color
// boost the boxed number by 1 per 2 gems (gems = card sizes; minerals are
// not spent). FAQ p.45: boost level is calculated before the action begins.
import { card } from './catalog';
import { getPlayer, type CardColor, type EffectCtx, type EffectSource, type ImpulseState, type Seat } from './types';

export function sourceCardId(source: EffectSource): number | null {
  switch (source.type) {
    case 'impulseCard': return source.cardId;
    case 'planCard': return source.cardId;
    case 'tech': return source.cardId; // null for Basic techs
    case 'mapActivation': return source.cardId;
    case 'setup': return null;
  }
}

export function gemsOfColor(g: ImpulseState, seat: Seat, color: CardColor): number {
  return getPlayer(g, seat).minerals
    .filter((id) => card(id).color === color)
    .reduce((sum, id) => sum + card(id).size, 0);
}

/** Boost for the in-flight effect, including map-activation transport bonus. */
export function boostFromSource(g: ImpulseState, ctx: EffectCtx): number {
  const cardId = sourceCardId(ctx.source);
  if (cardId === null) return 0;
  const c = card(cardId);
  const matchingGems = gemsOfColor(g, ctx.seat, c.color);
  return Math.floor((matchingGems + ctx.transportBonusGems) / 2);
}
