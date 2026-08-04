// Registry bootstrap (the C# CardRegistrations.RegisterAll). Families without
// a registered handler are filtered from the deck at setup (allowlist) and
// auto-skipped everywhere else, so the game stays playable while the port
// grows. Remaining families to port (see PORT-PLAN.md): sabotage_*,
// research_*, execute_*.
import { EffectRegistry } from '../effects';
import { registerBasicCommon } from './basicCommon';
import { registerBuild } from './build';
import { registerCommand } from './command';
import { registerDraw } from './draw';
import { homePickHandler } from './homePick';
import { registerMine } from './mine';
import { registerMovementTechs } from './movementTechs';
import { registerPlan } from './plan';
import { registerRaceTechs } from './raceTechs';
import { registerRefine } from './refine';
import { registerTrade } from './trade';

export function buildRegistry(): EffectRegistry {
  const r = new EffectRegistry();
  r.register('_home_pick', homePickHandler);
  registerDraw(r);
  registerTrade(r);
  registerMine(r);
  registerRefine(r);
  registerBuild(r);
  registerPlan(r);
  registerCommand(r);
  registerBasicCommon(r);
  registerRaceTechs(r);
  registerMovementTechs(r);
  return r;
}
