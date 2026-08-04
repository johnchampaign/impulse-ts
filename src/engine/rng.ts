// The state carries only the serialized RNG; wrap every use so the advanced
// state is always written back. No Math.random anywhere in the engine.
import { Rng } from 'digital-boardgame-framework';
import type { ImpulseState } from './types';

export function withRng<T>(g: ImpulseState, fn: (rng: Rng) => T): T {
  const rng = Rng.fromState(g.rngState);
  const result = fn(rng);
  g.rngState = rng.serialize();
  return result;
}
