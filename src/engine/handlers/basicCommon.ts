// Basic Common tech (rulebook p.20): "Discard a card in order to either:
// Command one fleet for one move OR Build one ship at home." The Command
// sub-action has full path semantics — exploration, battle, activation.
// Ported from C# BasicCommonTechHandler.
import { PROMPT } from '../prompts';
import { sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { gatesAt } from '../map';
import { buildShip, countShipsAt, discardFromHand } from '../mechanics';
import { enumeratePaths } from '../movement';
import {
  getPlayer,
  type EffectCtx, type EffectSource, type ImpulseState, type Seat,
  type SelectFleetSizeRequest, type SelectFromOptionsRequest,
  type SelectShipPlacementRequest, type ShipLocation,
} from '../types';
import {
  applySectorCoreColor, newMovementState, resumeInterrupts, sectorCoreColorOptions,
  walkPath, type MovementState,
} from './movementExec';

type Stage =
  | 'start' | 'awaitingDiscard' | 'awaitingChoice' | 'awaitingFleet' | 'awaitingCount'
  | 'awaitingPath' | 'executingPath' | 'awaitingActivation' | 'awaitingSectorCoreColor'
  | 'awaitingPlacement' | 'done';

interface State {
  stage: Stage;
  ms: MovementState;
  activationCtx: EffectCtx | null;
}

export class BasicCommonTechHandler implements EffectHandler {
  constructor(private registry: EffectRegistry) {}

  execute(g: ImpulseState, ctx: EffectCtx): void {
    const st = (ctx.handlerState as State | null) ?? {
      stage: 'start' as Stage,
      ms: newMovementState(),
      activationCtx: null,
    };
    ctx.handlerState = st;
    const p = getPlayer(g, ctx.seat);

    // Sector Core color resume.
    if (st.stage === 'awaitingSectorCoreColor') {
      const req = ctx.pendingChoice as SelectFromOptionsRequest;
      const chosen = req.answer?.index ?? 0;
      ctx.pendingChoice = null;
      applySectorCoreColor(g, ctx.seat, chosen, st.ms.chosenCount);
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }

    // Activation sub-effect in progress? Forward (explicit choice sync-down).
    if (st.stage === 'awaitingActivation' && st.activationCtx) {
      const sub = st.activationCtx;
      sub.pendingChoice = ctx.pendingChoice;
      const cardId = sourceCardId(sub.source);
      const handler = cardId === null ? null : this.registry.resolve(card(cardId).effectFamily);
      handler?.execute(g, sub);
      this.mirrorActivation(ctx, st, sub);
      return;
    }

    // Battle / exploration resumption.
    const interrupt = resumeInterrupts(g, ctx, st.ms);
    if (interrupt === 'paused' || interrupt === 'abort') return;
    if (interrupt === 'battleDone') {
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }

    if (st.stage === 'start') {
      if (p.hand.length === 0) {
        logInfo(g, `BasicCommon tech: ${ctx.seat} hand empty, can't discard`);
        ctx.isComplete = true;
        return;
      }
      ctx.pendingChoice = {
        type: 'selectHandCard',
        seat: ctx.seat,
        legalCardIds: [...p.hand],
        allowNone: true,
        noneLabel: 'DONE',
        prompt: 'Discard a card to use Basic Common, or DONE to cancel.',
      };
      st.stage = 'awaitingDiscard';
      return;
    }

    if (st.stage === 'awaitingDiscard') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'selectHandCard') throw new Error('basicCommon: expected selectHandCard');
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId === null) { ctx.isComplete = true; return; }
      discardFromHand(g, ctx.seat, cardId);

      ctx.pendingChoice = {
        type: 'selectFromOptions',
        seat: ctx.seat,
        options: ['Command one fleet for one move', 'Build one ship at home'],
        prompt: 'Choose Basic Common sub-action:',
      };
      st.stage = 'awaitingChoice';
      return;
    }

    if (st.stage === 'awaitingChoice') {
      const req = ctx.pendingChoice as SelectFromOptionsRequest;
      ctx.pendingChoice = null;
      const chosen = req.answer?.index ?? 0;
      if (chosen === 0) {
        const legal = legalCommandOrigins(g, ctx.seat);
        if (legal.length === 0) {
          logInfo(g, 'BasicCommon: no legal Command origin');
          ctx.isComplete = true;
          return;
        }
        ctx.pendingChoice = {
          type: 'selectFleet',
          seat: ctx.seat,
          legalLocations: legal,
          allowSkip: true,
          prompt: 'Select a fleet to command (1 move).',
        };
        st.stage = 'awaitingFleet';
        return;
      }
      const home = g.map.homeNodeIds[ctx.seat]!;
      const legal: ShipLocation[] = [{ type: 'node', id: home }];
      for (const gt of gatesAt(g.map, home)) legal.push({ type: 'gate', id: gt.id });
      ctx.pendingChoice = {
        type: 'selectShipPlacement',
        seat: ctx.seat,
        legalLocations: legal,
        prompt: 'Build 1 ship at home.',
      };
      st.stage = 'awaitingPlacement';
      return;
    }

    if (st.stage === 'awaitingFleet') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'selectFleet') throw new Error('basicCommon: expected selectFleet');
      ctx.pendingChoice = null;
      const origin = req.answer?.loc ?? null;
      if (origin === null) {
        logInfo(g, 'BasicCommon: fleet skipped');
        ctx.isComplete = true;
        return;
      }
      st.ms.origin = origin;
      const shipsHere = countShipsAt(g, ctx.seat, origin);
      if (shipsHere <= 1) {
        st.ms.chosenCount = 1;
        this.transitionToPath(g, ctx, st);
        return;
      }
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

    if (st.stage === 'awaitingCount') {
      const req = ctx.pendingChoice as SelectFleetSizeRequest;
      ctx.pendingChoice = null;
      const chosen = req.answer?.size ?? req.min;
      st.ms.chosenCount = Math.min(Math.max(chosen, req.min), req.max);
      this.transitionToPath(g, ctx, st);
      return;
    }

    if (st.stage === 'awaitingPath') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'declareMove') throw new Error('basicCommon: expected declareMove');
      ctx.pendingChoice = null;
      const idx = req.answer!.pathIndex;
      st.ms.path = idx === -1 ? [] : req.legalPaths[idx]!;
      st.ms.pathStepIndex = 0;
      st.stage = 'executingPath';
    }

    if (st.stage === 'executingPath') {
      const result = walkPath(g, ctx, st.ms);
      switch (result.status) {
        case 'paused': return;
        case 'battleDone':
        case 'gameOver':
          st.stage = 'done';
          ctx.isComplete = true;
          return;
        case 'arrived':
          this.tryStartActivation(g, ctx, st, result.finalLoc);
          return;
      }
    }

    if (st.stage === 'awaitingPlacement') {
      const req = ctx.pendingChoice as SelectShipPlacementRequest;
      ctx.pendingChoice = null;
      buildShip(g, ctx.seat, req.answer!.loc);
      ctx.isComplete = true;
      return;
    }
  }

  private transitionToPath(g: ImpulseState, ctx: EffectCtx, st: State): void {
    const paths = enumeratePaths(g, ctx.seat, st.ms.origin!, 1);
    if (paths.length === 0) {
      logInfo(g, `BasicCommon: no legal paths from ${st.ms.origin!.type}:${st.ms.origin!.id}`);
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'declareMove',
      seat: ctx.seat,
      origin: st.ms.origin!,
      maxMoves: 1,
      legalPaths: paths,
      allowStay: false,
      prompt: 'Declare destination (1 move).',
    };
    st.stage = 'awaitingPath';
  }

  private tryStartActivation(g: ImpulseState, ctx: EffectCtx, st: State, finalLoc: ShipLocation): void {
    const complete = (): void => {
      st.stage = 'done';
      ctx.isComplete = true;
    };
    if (finalLoc.type !== 'node') { complete(); return; }
    if (st.ms.origin?.type === 'node' && st.ms.origin.id === finalLoc.id) { complete(); return; }
    const nc = g.nodeCards[finalLoc.id];
    if (!nc) { complete(); return; }
    if (nc.kind === 'core') {
      ctx.pendingChoice = {
        type: 'selectFromOptions',
        seat: ctx.seat,
        options: sectorCoreColorOptions(g, ctx.seat, st.ms.chosenCount),
        prompt: PROMPT.sectorCoreColor(st.ms.chosenCount),
      };
      st.stage = 'awaitingSectorCoreColor';
      return;
    }
    if (nc.kind !== 'faceUp') { complete(); return; }
    const c = card(nc.cardId);
    const sub = this.registry.resolve(c.effectFamily);
    if (!sub) {
      logInfo(g, `activate #${nc.cardId} (${c.effectFamily}): no handler; skip`);
      complete();
      return;
    }
    log(g, {
      side: ctx.seat, kind: 'card.activate', payload: { nodeId: finalLoc.id, cardId: nc.cardId },
      msg: `activating #${nc.cardId} on N${finalLoc.id} (+${st.ms.chosenCount} bonus gem(s) from arriving transports)`,
    });
    const subCtx: EffectCtx = {
      seat: ctx.seat,
      source: { type: 'mapActivation', nodeId: finalLoc.id, cardId: nc.cardId },
      pendingChoice: null,
      handlerState: null,
      isComplete: false,
      transportBonusGems: st.ms.chosenCount,
      activationDepth: ctx.activationDepth + 1,
      pendingDefenderCandidates: null,
    };
    st.activationCtx = subCtx;
    st.stage = 'awaitingActivation';
    sub.execute(g, subCtx);
    this.mirrorActivation(ctx, st, subCtx);
  }

  private mirrorActivation(ctx: EffectCtx, st: State, sub: EffectCtx): void {
    if (sub.isComplete) {
      ctx.pendingChoice = null;
      st.activationCtx = null;
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }
    if (sub.pendingChoice) {
      ctx.pendingChoice = sub.pendingChoice;
      return;
    }
    ctx.isComplete = true;
  }
}

function legalCommandOrigins(g: ImpulseState, mover: Seat): ShipLocation[] {
  const result: ShipLocation[] = [];
  const seen = new Set<string>();
  for (const sp of g.ships) {
    if (sp.owner !== mover) continue;
    const key = `${sp.loc.type}:${sp.loc.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (enumeratePaths(g, mover, sp.loc, 1).length === 0) continue;
    result.push(sp.loc);
  }
  return result;
}

export function registerBasicCommon(r: EffectRegistry): void {
  r.register('_tech_basic_common', new BasicCommonTechHandler(r));
}
