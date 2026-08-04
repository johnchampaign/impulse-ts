// Effect handler dispatch. Handlers are stateless; per-invocation state lives
// in EffectCtx.handlerState (plain JSON). Pause/resume idiom (from C#):
//
//   if (!ctx.pendingChoice) { ctx.pendingChoice = {...}; return; }   // pause
//   const req = ctx.pendingChoice; ctx.pendingChoice = null; ...     // resume
//
// A handler signals completion with ctx.isComplete = true. Never consume
// ctx.pendingChoice without nulling it (locked gotcha from the C# port).
import type { EffectCtx, ImpulseState } from './types';

export interface EffectHandler {
  execute(g: ImpulseState, ctx: EffectCtx): void;
}

export class EffectRegistry {
  private byFamily = new Map<string, EffectHandler>();

  register(family: string, handler: EffectHandler): void {
    this.byFamily.set(family, handler);
  }

  resolve(family: string): EffectHandler | null {
    return this.byFamily.get(family) ?? null;
  }

  isRegistered(family: string): boolean {
    return this.byFamily.has(family);
  }
}
