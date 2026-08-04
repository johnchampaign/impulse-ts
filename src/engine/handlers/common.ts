// Shared helpers for card-filter matching. Size filter is "up to N" per
// rulebook p.21; color matching is equality (locked).
import type { Card, CardColor } from '../types';

export function matches(c: Card, size: number | null, color: CardColor | null): boolean {
  return (size === null || c.size <= size) && (color === null || c.color === color);
}

export function describeFilter(size: number | null, color: CardColor | null): string {
  const parts: string[] = [];
  if (size !== null) parts.push(`size up to ${size}`);
  if (color !== null) parts.push(`color ${color}`);
  return parts.length === 0 ? 'any' : parts.join(', ');
}
