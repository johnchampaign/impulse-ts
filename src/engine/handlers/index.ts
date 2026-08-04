// Registry bootstrap (the C# CardRegistrations.RegisterAll). All 47 card
// families are registered — the setup allowlist now admits the full
// 108-card deck.
import { EffectRegistry } from '../effects';
import { registerBasicCommon } from './basicCommon';
import { registerBuild } from './build';
import { registerCommand } from './command';
import { registerDraw } from './draw';
import { registerExecute } from './execute';
import { homePickHandler } from './homePick';
import { registerMine } from './mine';
import { registerMovementTechs } from './movementTechs';
import { registerPlan } from './plan';
import { registerRaceTechs } from './raceTechs';
import { registerRefine } from './refine';
import { registerResearch } from './research';
import { registerSabotage } from './sabotage';
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
  registerResearch(r);
  registerExecute(r);
  registerSabotage(r);
  return r;
}
