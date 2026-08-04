// Shared movement-execution machinery for every handler that walks a
// declared path (Command, Basic Common tech, Ariek, Herculese). The C#
// versions duplicate this per-step logic verbatim; here it is factored once.
// Per-step semantics (all from the C# ContinuePath implementations):
//  - exploration: transport landing on a face-down card, or cruiser passing
//    through one, pauses for the place-a-card pick (rulebook p.29)
//  - battle: cruiser stepping onto a gate with enemy cruisers fights there;
//    a patrolled passage marks passageNode for transport destruction
//  - a cruiser passage without battle destroys enemy transports on the
//    traversed card (rulebook p.28)
import { battleStep, newBattle, resolveDefender, type BattleState } from '../battle';
import { card } from '../catalog';
import { log } from '../log';
import { destroyShipAt, finishExploration, moveShip, startExploration } from '../mechanics';
import { hasEnemyCruiserOnGate, isPatrolledByEnemy, sharedNode } from '../movement';
import { addPrestige } from '../scoring';
import {
  getPlayer,
  type CardColor, type EffectCtx, type ImpulseState, type Seat, type ShipLocation,
} from '../types';

// The movement fragment each handler embeds in its JSON handlerState.
export interface MovementState {
  origin: ShipLocation | null;
  chosenCount: number;
  path: ShipLocation[] | null;
  pathStepIndex: number;
  explorationNode: number | null;
  battle: BattleState | null;
}

export function newMovementState(): MovementState {
  return {
    origin: null,
    chosenCount: 1,
    path: null,
    pathStepIndex: 0,
    explorationNode: null,
    battle: null,
  };
}

export type InterruptResult = 'none' | 'paused' | 'battleDone' | 'abort';

// Handle in-flight battle / exploration-pick resumption. Call at the top of
// execute (mirrors the C# handler preambles).
export function resumeInterrupts(g: ImpulseState, ctx: EffectCtx, ms: MovementState): InterruptResult {
  if (ms.battle) {
    const done = battleStep(g, ctx, ms.battle);
    if (done) {
      ms.battle = null;
      return 'battleDone';
    }
    return 'paused';
  }
  if (ms.explorationNode !== null) {
    if (ctx.pendingChoice?.type === 'selectHandCard' && ctx.pendingChoice.answer?.cardId != null) {
      const picked = ctx.pendingChoice.answer.cardId;
      ctx.pendingChoice = null;
      finishExploration(g, ctx.seat, ms.explorationNode, picked);
      ms.explorationNode = null;
      return 'none'; // fall through to path continuation
    }
    // Defensive: should always have a pending choice here.
    ctx.isComplete = true;
    return 'abort';
  }
  return 'none';
}

export type WalkResult =
  | { status: 'paused' }
  | { status: 'battleDone' }
  | { status: 'gameOver' }
  | { status: 'arrived'; finalLoc: ShipLocation };

// Walk the declared path from ms.pathStepIndex. Moves ships as it goes; may
// pause for exploration, defender choice, or battle reinforcement.
export function walkPath(g: ImpulseState, ctx: EffectCtx, ms: MovementState): WalkResult {
  const path = ms.path!;
  let here = ms.pathStepIndex === 0 ? ms.origin! : path[ms.pathStepIndex - 1]!;

  while (ms.pathStepIndex < path.length) {
    const step = path[ms.pathStepIndex]!;

    // Exploration trigger: transport landing on face-down, or cruiser
    // passing through face-down.
    let exploreNode: number | null = null;
    if (here.type === 'node' && step.type === 'node') {
      if (g.nodeCards[step.id]?.kind === 'faceDown') exploreNode = step.id;
    } else if (here.type === 'gate' && step.type === 'gate') {
      const pass = sharedNode(g, here.id, step.id);
      if (pass !== null && g.nodeCards[pass]?.kind === 'faceDown') exploreNode = pass;
    }
    if (exploreNode !== null) {
      startExploration(g, ctx.seat, exploreNode);
      ms.explorationNode = exploreNode;
      const p = getPlayer(g, ctx.seat);
      ctx.pendingChoice = {
        type: 'selectHandCard',
        seat: ctx.seat,
        legalCardIds: [...p.hand],
        allowNone: false,
        noneLabel: 'DONE',
        prompt: `Exploring N${exploreNode}: place a card from your hand face-up.`,
      };
      return { status: 'paused' };
    }

    // Cruiser passage: battle / transport destruction.
    if (here.type === 'gate' && step.type === 'gate') {
      const pass = sharedNode(g, here.id, step.id);
      const passagePatrolled = pass !== null && isPatrolledByEnemy(g, ctx.seat, pass);
      if (hasEnemyCruiserOnGate(g, ctx.seat, step.id)) {
        const defender = resolveDefender(
          g, ctx,
          findEnemiesOnGate(g, ctx.seat, step.id),
          `Multiple players have cruisers on G${step.id} — choose who to fight.`,
        );
        if (defender === null) return { status: 'paused' };
        ms.battle = newBattle({
          attacker: ctx.seat,
          defender,
          battleGate: step.id,
          attackerOrigin: here,
          attackerCruiserCount: ms.chosenCount,
          // Battle at the destination the player chose; passageNode marks
          // the traversed card so its transports die on an attacker win.
          passageNode: passagePatrolled ? pass : null,
        });
        if (battleStep(g, ctx, ms.battle)) {
          ms.battle = null;
          return { status: 'battleDone' };
        }
        return { status: 'paused' };
      }
      if (pass !== null) destroyEnemyTransportsOn(g, ctx.seat, pass);
      if (g.isGameOver) return { status: 'gameOver' };
    }

    for (let s = 0; s < ms.chosenCount; s++) moveShip(g, ctx.seat, here, step);
    here = step;
    ms.pathStepIndex++;
  }
  return { status: 'arrived', finalLoc: here };
}

export function findEnemiesOnGate(g: ImpulseState, mover: Seat, gateId: number): Seat[] {
  return [...new Set(
    g.ships
      .filter((sp) => sp.owner !== mover && sp.loc.type === 'gate' && sp.loc.id === gateId)
      .map((sp) => sp.owner),
  )].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

export function destroyEnemyTransportsOn(g: ImpulseState, mover: Seat, nodeId: number): void {
  const victims = g.ships.filter((sp) =>
    sp.owner !== mover && sp.loc.type === 'node' && sp.loc.id === nodeId);
  for (const v of victims) {
    destroyShipAt(g, v.owner, v.loc, mover);
    if (g.isGameOver) return;
  }
}

// Sector Core activation (rulebook p.27): player chooses a mineral color;
// score 1 + floor((gems of that color + arriving transports) / 2).
// Display order: Red, Blue, Green, Yellow (deliberately NOT the CardColor
// enum order — inherited from the C# UI).
const CORE_COLOR_DISPLAY_ORDER: readonly CardColor[] = ['Red', 'Blue', 'Green', 'Yellow'];

function gemsOf(g: ImpulseState, seat: Seat, color: CardColor): number {
  return getPlayer(g, seat).minerals
    .filter((id) => card(id).color === color)
    .reduce((sum, id) => sum + card(id).size, 0);
}

export function sectorCoreColorOptions(g: ImpulseState, seat: Seat, bonusTransports: number): string[] {
  return CORE_COLOR_DISPLAY_ORDER.map((c) => {
    const gems = gemsOf(g, seat, c);
    const b = Math.floor((gems + bonusTransports) / 2);
    return `${c}: ${gems} gem(s) → +${1 + b} prestige`;
  });
}

export function applySectorCoreColor(
  g: ImpulseState, seat: Seat, chosenIndex: number, bonusTransports: number,
): void {
  const idx = Math.min(Math.max(chosenIndex, 0), CORE_COLOR_DISPLAY_ORDER.length - 1);
  const color = CORE_COLOR_DISPLAY_ORDER[idx]!;
  const gems = gemsOf(g, seat, color);
  const points = 1 + Math.floor((gems + bonusTransports) / 2);
  log(g, {
    side: seat, kind: 'core.activate', payload: { color, gems, bonusTransports, points },
    msg: `Sector Core activated as ${color}: ${gems} gem(s) + ${bonusTransports} transport(s) → +${points} prestige`,
  });
  addPrestige(g, seat, points, 'sectorCoreActivatedByTransports');
}
