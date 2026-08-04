// Card catalog access. CARDS comes from the generated module (data/cards.tsv
// is the source of truth — run `npm run gen-cards`).
import { CARDS } from '../gen/cards-data';
import type { Card } from './types';

export { CARDS };

const byId = new Map<number, Card>(CARDS.map((c) => [c.id, c]));

export function card(id: number): Card {
  const c = byId.get(id);
  if (!c) throw new Error(`unknown card #${id}`);
  return c;
}
