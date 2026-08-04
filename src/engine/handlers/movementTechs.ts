// Movement-dependent Basic Unique techs: Ariek (fleet must end on/patrolling
// the Sector Core) and Herculese (cruiser through an unexplored card).
// Ported from C# BasicUniqueTechHandlers.
import type { EffectHandler, EffectRegistry } from '../effects';
import { logInfo } from '../log';
import { gatesAt } from '../map';
import { countShipsAt } from '../mechanics';
import { enumeratePaths, sharedNode } from '../movement';
import {
  type EffectCtx, type ImpulseState, type Seat,
  type SelectFleetSizeRequest, type SelectFromOptionsRequest, type ShipLocation,
} from '../types';
import {
  applySectorCoreColor, newMovementState, resumeInterrupts, sectorCoreColorOptions,
  walkPath, type MovementState,
} from './movementExec';

// ---------- Ariek ----------
// "Command one fleet for one move. It must end the move occupying or
// patrolling the Sector Core."

type AriekStage = 'start' | 'awaitingFleet' | 'awaitingCount' | 'awaitingPath' | 'executing' | 'awaitingSectorCoreColor';

interface AriekState {
  stage: AriekStage;
  ms: MovementState;
}

function endsAtCore(loc: ShipLocation, coreId: number, coreGates: Set<number>): boolean {
  return loc.type === 'node' ? loc.id === coreId : coreGates.has(loc.id);
}

const ariekHandler: EffectHandler = {
  execute(g: ImpulseState, ctx: EffectCtx): void {
    const st = (ctx.handlerState as AriekState | null) ?? {
      stage: 'start' as AriekStage,
      ms: newMovementState(),
    };
    ctx.handlerState = st;
    const coreId = g.map.sectorCoreNodeId;
    const coreGates = new Set(gatesAt(g.map, coreId).map((gt) => gt.id));

    const interrupt = resumeInterrupts(g, ctx, st.ms);
    if (interrupt === 'paused' || interrupt === 'abort') return;
    if (interrupt === 'battleDone') { ctx.isComplete = true; return; }

    const beginPath = (origin: ShipLocation): void => {
      const paths = enumeratePaths(g, ctx.seat, origin, 1)
        .filter((path) => endsAtCore(path[path.length - 1]!, coreId, coreGates));
      if (paths.length === 0) {
        logInfo(g, 'Ariek: no legal Sector Core path from origin');
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'declareMove',
        seat: ctx.seat,
        origin,
        maxMoves: 1,
        legalPaths: paths,
        allowStay: false,
        prompt: 'Move toward the Sector Core.',
      };
      st.stage = 'awaitingPath';
    };

    if (st.stage === 'start') {
      const legal = ariekLegalOrigins(g, ctx.seat, coreId, coreGates);
      if (legal.length === 0) {
        logInfo(g, 'Ariek: no fleet can reach Sector Core in 1 move');
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectFleet',
        seat: ctx.seat,
        legalLocations: legal,
        allowSkip: true,
        prompt: 'Select a fleet (must end move on/patrolling Sector Core).',
      };
      st.stage = 'awaitingFleet';
      return;
    }

    if (st.stage === 'awaitingFleet') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'selectFleet') throw new Error('ariek: expected selectFleet');
      ctx.pendingChoice = null;
      const origin = req.answer?.loc ?? null;
      if (origin === null) {
        logInfo(g, 'Ariek: fleet skipped');
        ctx.isComplete = true;
        return;
      }
      st.ms.origin = origin;
      const shipsHere = countShipsAt(g, ctx.seat, origin);
      if (shipsHere > 1) {
        ctx.pendingChoice = {
          type: 'selectFleetSize',
          seat: ctx.seat,
          min: 1,
          max: shipsHere,
          prompt: `How many ships to move? (1–${shipsHere})`,
        };
        st.stage = 'awaitingCount';
        return;
      }
      st.ms.chosenCount = 1;
      beginPath(origin);
      return;
    }

    if (st.stage === 'awaitingCount') {
      const req = ctx.pendingChoice as SelectFleetSizeRequest;
      ctx.pendingChoice = null;
      st.ms.chosenCount = req.answer?.size ?? req.min;
      beginPath(st.ms.origin!);
      return;
    }

    if (st.stage === 'awaitingPath') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'declareMove') throw new Error('ariek: expected declareMove');
      ctx.pendingChoice = null;
      st.ms.path = req.legalPaths[req.answer!.pathIndex]!;
      st.ms.pathStepIndex = 0;
      st.stage = 'executing';
    }

    if (st.stage === 'executing') {
      const result = walkPath(g, ctx, st.ms);
      switch (result.status) {
        case 'paused': return;
        case 'battleDone':
        case 'gameOver':
          ctx.isComplete = true;
          return;
        case 'arrived': break;
      }
      // Core activation when a transport fleet ends ON the core node
      // (rulebook p.27). Ariek does not activate other face-up cards.
      const finalLoc = result.finalLoc;
      const startedOnCore = st.ms.origin?.type === 'node' && st.ms.origin.id === coreId;
      if (finalLoc.type === 'node' && finalLoc.id === coreId && !startedOnCore) {
        ctx.pendingChoice = {
          type: 'selectFromOptions',
          seat: ctx.seat,
          options: sectorCoreColorOptions(g, ctx.seat, st.ms.chosenCount),
          prompt: `Sector Core: choose mineral color for boost (+${st.ms.chosenCount} arriving transport(s)).`,
        };
        st.stage = 'awaitingSectorCoreColor';
        return;
      }
      ctx.isComplete = true;
      return;
    }

    if (st.stage === 'awaitingSectorCoreColor') {
      const req = ctx.pendingChoice as SelectFromOptionsRequest;
      const chosen = req.answer?.index ?? 0;
      ctx.pendingChoice = null;
      applySectorCoreColor(g, ctx.seat, chosen, st.ms.chosenCount);
      ctx.isComplete = true;
    }
  },
};

function ariekLegalOrigins(g: ImpulseState, mover: Seat, coreId: number, coreGates: Set<number>): ShipLocation[] {
  const result: ShipLocation[] = [];
  const seen = new Set<string>();
  for (const sp of g.ships) {
    if (sp.owner !== mover) continue;
    const key = `${sp.loc.type}:${sp.loc.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const paths = enumeratePaths(g, mover, sp.loc, 1);
    if (paths.some((path) => endsAtCore(path[path.length - 1]!, coreId, coreGates))) {
      result.push(sp.loc);
    }
  }
  return result;
}

// ---------- Herculese ----------
// "Command one Cruiser for one move through an unexplored card."

type HerculeseStage = 'start' | 'awaitingFleet' | 'awaitingPath' | 'executing';

interface HerculeseState {
  stage: HerculeseStage;
  ms: MovementState;
}

function pathPassesUnexplored(g: ImpulseState, origin: ShipLocation, path: ShipLocation[]): boolean {
  if (origin.type !== 'gate') return false;
  if (path.length !== 1 || path[0]!.type !== 'gate') return false;
  const pass = sharedNode(g, origin.id, path[0]!.id);
  return pass !== null && g.nodeCards[pass]?.kind === 'faceDown';
}

const herculeseHandler: EffectHandler = {
  execute(g: ImpulseState, ctx: EffectCtx): void {
    const st = (ctx.handlerState as HerculeseState | null) ?? {
      stage: 'start' as HerculeseStage,
      ms: newMovementState(),
    };
    ctx.handlerState = st;

    const interrupt = resumeInterrupts(g, ctx, st.ms);
    if (interrupt === 'paused' || interrupt === 'abort') return;
    if (interrupt === 'battleDone') { ctx.isComplete = true; return; }

    if (st.stage === 'start') {
      const legal: ShipLocation[] = [];
      const seen = new Set<number>();
      for (const sp of g.ships) {
        if (sp.owner !== ctx.seat || sp.loc.type !== 'gate') continue;
        if (seen.has(sp.loc.id)) continue;
        seen.add(sp.loc.id);
        const paths = enumeratePaths(g, ctx.seat, sp.loc, 1);
        if (paths.some((path) => pathPassesUnexplored(g, sp.loc, path))) legal.push(sp.loc);
      }
      if (legal.length === 0) {
        logInfo(g, 'Herculese: no cruiser can move through an unexplored card');
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectFleet',
        seat: ctx.seat,
        legalLocations: legal,
        allowSkip: true,
        prompt: 'Select a Cruiser to move through an unexplored card.',
      };
      st.stage = 'awaitingFleet';
      return;
    }

    if (st.stage === 'awaitingFleet') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'selectFleet') throw new Error('herculese: expected selectFleet');
      ctx.pendingChoice = null;
      const origin = req.answer?.loc ?? null;
      if (origin === null) {
        logInfo(g, 'Herculese: fleet skipped');
        ctx.isComplete = true;
        return;
      }
      st.ms.origin = origin;
      st.ms.chosenCount = 1; // "one Cruiser"
      const paths = enumeratePaths(g, ctx.seat, origin, 1)
        .filter((path) => pathPassesUnexplored(g, origin, path));
      if (paths.length === 0) {
        logInfo(g, `Herculese: no path through unexplored card from ${origin.type}:${origin.id}`);
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'declareMove',
        seat: ctx.seat,
        origin,
        maxMoves: 1,
        legalPaths: paths,
        allowStay: false,
        prompt: 'Choose a gate; passage must be face-down.',
      };
      st.stage = 'awaitingPath';
      return;
    }

    if (st.stage === 'awaitingPath') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'declareMove') throw new Error('herculese: expected declareMove');
      ctx.pendingChoice = null;
      st.ms.path = req.legalPaths[req.answer!.pathIndex]!;
      st.ms.pathStepIndex = 0;
      st.stage = 'executing';
    }

    if (st.stage === 'executing') {
      const result = walkPath(g, ctx, st.ms);
      if (result.status === 'paused') return;
      ctx.isComplete = true;
    }
  },
};

export function registerMovementTechs(r: EffectRegistry): void {
  r.register('tech_basic_unique_ariek', ariekHandler);
  r.register('tech_basic_unique_herculese', herculeseHandler);
}
