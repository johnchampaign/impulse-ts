// Command families — the heart of the game. Ported 1:1 from C#
// CommandHandler.cs including its documented rule interpretations:
//  - multi-fleet commands resolve sequentially, each fleet with full
//    knowledge of prior fleets' outcomes (../Impulse/docs/engine.md)
//  - "same card" convergence (c75/c98) via ConvergenceSet narrowing; the
//    first fleet pins the card (rulebook p.30, designer ruling 2016-12-26:
//    move together, activate once — activation deferred until all fleets
//    finish, bonus gems accumulate across converging transport fleets)
//  - transports ending on a face-up card they didn't start on activate it,
//    arriving transports counting as bonus matching gems (p.27/p.29)
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { gate } from '../map';
import { countShipsAt } from '../mechanics';
import { enumeratePaths } from '../movement';
import {
  getPlayer,
  type EffectCtx, type EffectSource, type ImpulseState, type Seat,
  type SelectFleetSizeRequest, type SelectFromOptionsRequest, type ShipLocation,
} from '../types';
import {
  applySectorCoreColor, newMovementState, resumeInterrupts, sectorCoreColorOptions,
  walkPath, type MovementState,
} from './movementExec';

type CommandBoostTarget = 'maxFleetSize' | 'moveCount' | 'fleetCount';
type ShipTypeFilter = 'transportOnly' | 'cruiserOnly' | 'either';

export interface CommandParams {
  maxFleetSize: number;
  moveCount: number;
  shipType: ShipTypeFilter;
  boostTarget: CommandBoostTarget;
  fleetCount: number;
}

const cp = (
  maxFleetSize: number, moveCount: number, shipType: ShipTypeFilter,
  boostTarget: CommandBoostTarget, fleetCount = 1,
): CommandParams => ({ maxFleetSize, moveCount, shipType, boostTarget, fleetCount });

// BoostTarget points at the [N] in each card's text:
//   "[N] ship/cruiser/transport fleet for one/two move(s)" → maxFleetSize
//   "(one|two) ... fleet for [N] move(s)" / "one ... for [N] move" → moveCount
//   "[N] fleet[s]" (multi-fleet) → fleetCount (maxFleetSize 12 = at-origin cap)
export const COMMAND_PARAMS_BY_CARD_ID: Record<number, CommandParams> = {
  4: cp(1, 1, 'either', 'maxFleetSize'),
  6: cp(2, 1, 'cruiserOnly', 'maxFleetSize'),
  12: cp(12, 1, 'either', 'fleetCount', 1),
  13: cp(2, 1, 'either', 'moveCount'),
  26: cp(1, 1, 'either', 'maxFleetSize'),
  31: cp(1, 1, 'cruiserOnly', 'moveCount'),
  35: cp(1, 1, 'transportOnly', 'moveCount'),
  38: cp(1, 1, 'cruiserOnly', 'moveCount'),
  39: cp(2, 1, 'cruiserOnly', 'moveCount'),
  40: cp(1, 2, 'transportOnly', 'maxFleetSize'),
  41: cp(1, 1, 'transportOnly', 'maxFleetSize'),
  42: cp(1, 1, 'either', 'maxFleetSize'),
  44: cp(1, 1, 'cruiserOnly', 'moveCount'),
  55: cp(2, 1, 'either', 'moveCount'),
  56: cp(1, 1, 'transportOnly', 'maxFleetSize'),
  69: cp(1, 1, 'cruiserOnly', 'moveCount'),
  70: cp(1, 1, 'cruiserOnly', 'moveCount'),
  71: cp(1, 1, 'transportOnly', 'maxFleetSize'),
  75: cp(12, 1, 'either', 'fleetCount', 2),
  78: cp(12, 1, 'either', 'fleetCount', 1),
  81: cp(1, 1, 'transportOnly', 'moveCount'),
  88: cp(2, 1, 'transportOnly', 'moveCount'),
  91: cp(1, 2, 'either', 'maxFleetSize'),
  94: cp(1, 1, 'transportOnly', 'moveCount'),
  98: cp(12, 1, 'either', 'fleetCount', 2),
  100: cp(1, 1, 'either', 'maxFleetSize'),
  105: cp(1, 2, 'either', 'maxFleetSize'),
};

type Stage =
  | 'start' | 'awaitingFleet' | 'awaitingCount' | 'awaitingPath'
  | 'executingPath' | 'awaitingActivation' | 'awaitingSectorCoreColor' | 'done';

interface CommandState {
  stage: Stage;
  ms: MovementState;
  activationCtx: EffectCtx | null;
  fleetIndex: number;
  totalFleets: number;
  usedOrigins: string[]; // locKey strings — "you cannot move the same fleet twice" (p.31)
  convergenceSet: number[] | null;
  pendingActivationNode: number | null;
  pendingActivationLoc: ShipLocation | null;
  pendingActivationBonus: number;
}

function keyOf(loc: ShipLocation): string {
  return `${loc.type}:${loc.id}`;
}

// Which "card"(s) (node ids) a location is associated with: transport on N →
// {N}; cruiser on gate → both endpoints.
function compatNodes(g: ImpulseState, loc: ShipLocation): Set<number> {
  if (loc.type === 'node') return new Set([loc.id]);
  const gt = gate(g.map, loc.id);
  return new Set([gt.a, gt.b]);
}

function describeShipType(f: ShipTypeFilter): string {
  return f === 'transportOnly' ? 'Transport' : f === 'cruiserOnly' ? 'Cruiser' : 'ship';
}

export class CommandHandler implements EffectHandler {
  constructor(
    private registry: EffectRegistry,
    private byCardId: Record<number, CommandParams>,
  ) {}

  execute(g: ImpulseState, ctx: EffectCtx): void {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = this.byCardId[srcId];
    if (!prms) {
      logInfo(g, `command: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const st = (ctx.handlerState as CommandState | null) ?? {
      stage: 'start' as Stage,
      ms: newMovementState(),
      activationCtx: null,
      fleetIndex: 0,
      totalFleets: 0,
      usedOrigins: [],
      convergenceSet: null,
      pendingActivationNode: null,
      pendingActivationLoc: null,
      pendingActivationBonus: 0,
    };
    ctx.handlerState = st;

    // Sector Core color resume.
    if (st.stage === 'awaitingSectorCoreColor') {
      const req = ctx.pendingChoice as SelectFromOptionsRequest;
      const chosen = req.answer?.index ?? 0;
      ctx.pendingChoice = null;
      applySectorCoreColor(g, ctx.seat, chosen, st.ms.chosenCount);
      this.completeFleet(g, ctx, st);
      return;
    }

    // Activation sub-effect in progress? Forward. The pending choice is
    // synced down explicitly (the C# version relied on shared object refs,
    // which don't survive JSON serialization).
    if (st.stage === 'awaitingActivation' && st.activationCtx) {
      const sub = st.activationCtx;
      sub.pendingChoice = ctx.pendingChoice;
      const handler = this.resolveSub(sub.source);
      handler?.execute(g, sub);
      this.mirrorActivation(g, ctx, st, sub);
      return;
    }

    // Battle / exploration resumption.
    const interrupt = resumeInterrupts(g, ctx, st.ms);
    if (interrupt === 'paused' || interrupt === 'abort') return;
    if (interrupt === 'battleDone') {
      // A battle ends that fleet's movement (p.31); continue with the next.
      this.completeFleet(g, ctx, st);
      return;
    }

    // Boost: applied to the correct knob per rulebook p.22.
    const boost = boostFromSource(g, ctx);
    const effectiveMaxFleet = prms.boostTarget === 'maxFleetSize' ? prms.maxFleetSize + boost : prms.maxFleetSize;
    const effectiveMoves = prms.boostTarget === 'moveCount' ? prms.moveCount + boost : prms.moveCount;
    const effectiveFleetCount = prms.boostTarget === 'fleetCount' ? prms.fleetCount + boost : prms.fleetCount;

    if (st.stage === 'start') {
      st.totalFleets = effectiveFleetCount;
      logInfo(g, `command #${srcId} (${describeShipType(prms.shipType)} ${st.totalFleets} fleet(s) ` +
        `up to ${effectiveMaxFleet}, ${effectiveMoves} move(s)${boost > 0 ? `, +${boost} boost` : ''})`);
      const legal = this.legalOrigins(g, ctx.seat, prms, st.usedOrigins, null, effectiveMoves);
      if (legal.length === 0) {
        ctx.isComplete = true;
        return;
      }
      // Multi-fleet "same card" (c75/c98): spell out the convergence rule up
      // front — the first fleet pins the card the rest must share (learned
      // from a live problem report; see the C# comment trail).
      const fleetPrompt = st.totalFleets > 1
        ? `Select a ${describeShipType(prms.shipType)} fleet (1/${st.totalFleets}) to Command. ` +
          `All ${st.totalFleets} fleets must finish on the SAME sector card — whichever fleet you move ` +
          `FIRST sets that card, so move the fleet you care about most (e.g. a cruiser heading for the core) first.`
        : `Select a ${describeShipType(prms.shipType)} fleet to Command.`;
      ctx.pendingChoice = {
        type: 'selectFleet',
        seat: ctx.seat,
        legalLocations: legal,
        allowSkip: true,
        prompt: fleetPrompt,
      };
      st.stage = 'awaitingFleet';
      return;
    }

    if (st.stage === 'awaitingFleet') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'selectFleet') throw new Error('command: expected selectFleet');
      ctx.pendingChoice = null;
      const origin = req.answer?.loc ?? null;
      if (origin === null) {
        // Skip: declined this fleet (actions are always optional, p.22).
        logInfo(g, `command: fleet ${st.fleetIndex + 1}/${st.totalFleets} skipped`);
        this.completeFleet(g, ctx, st);
        return;
      }
      st.ms.origin = origin;

      const shipsHere = countShipsAt(g, ctx.seat, origin);
      const maxPick = Math.min(effectiveMaxFleet, shipsHere);
      if (maxPick <= 1) {
        st.ms.chosenCount = 1;
        st.stage = 'awaitingPath';
        this.transitionToPath(g, ctx, st, origin, effectiveMoves);
        return;
      }
      ctx.pendingChoice = {
        type: 'selectFleetSize',
        seat: ctx.seat,
        min: 1,
        max: maxPick,
        prompt: `How many ships to move? (1–${maxPick})`,
      };
      st.stage = 'awaitingCount';
      return;
    }

    if (st.stage === 'awaitingCount') {
      const req = ctx.pendingChoice as SelectFleetSizeRequest;
      ctx.pendingChoice = null;
      const chosen = req.answer?.size ?? req.min;
      st.ms.chosenCount = Math.min(Math.max(chosen, req.min), req.max);
      st.stage = 'awaitingPath';
      this.transitionToPath(g, ctx, st, st.ms.origin!, effectiveMoves);
      return;
    }

    if (st.stage === 'awaitingPath') {
      const req = ctx.pendingChoice;
      if (req?.type !== 'declareMove') throw new Error('command: expected declareMove');
      ctx.pendingChoice = null;
      const idx = req.answer!.pathIndex;
      if (idx === -1) {
        // Stay: no movement for this fleet.
        logInfo(g, `fleet stays at ${st.ms.origin!.type}:${st.ms.origin!.id}`);
        this.completeFleet(g, ctx, st);
        return;
      }
      const path = req.legalPaths[idx]!;
      st.ms.path = path;
      st.ms.pathStepIndex = 0;
      st.stage = 'executingPath';
      // Convergence narrowing by the chosen path's endpoint compatibility.
      if (st.totalFleets > 1) {
        const endCompat = compatNodes(g, path[path.length - 1]!);
        st.convergenceSet = st.convergenceSet === null
          ? [...endCompat]
          : st.convergenceSet.filter((n) => endCompat.has(n));
      }
    }

    if (st.stage === 'executingPath') {
      this.continuePath(g, ctx, st);
    }
  }

  private resolveSub(source: EffectSource): EffectHandler | null {
    const cardId = sourceCardId(source);
    return cardId === null ? null : this.registry.resolve(card(cardId).effectFamily);
  }

  private continuePath(g: ImpulseState, ctx: EffectCtx, st: CommandState): void {
    const result = walkPath(g, ctx, st.ms);
    switch (result.status) {
      case 'paused': return;
      case 'battleDone': this.completeFleet(g, ctx, st); return;
      case 'gameOver': st.stage = 'done'; ctx.isComplete = true; return;
      case 'arrived': break;
    }
    // Single-fleet commands activate immediately; multi-fleet commands defer
    // activation until every fleet has finished moving.
    if (st.totalFleets > 1) {
      this.captureDeferredActivationAndComplete(g, ctx, st, result.finalLoc);
      return;
    }
    this.tryStartActivation(g, ctx, st, result.finalLoc);
  }

  private captureDeferredActivationAndComplete(
    g: ImpulseState, ctx: EffectCtx, st: CommandState, finalLoc: ShipLocation,
  ): void {
    if (finalLoc.type === 'node') {
      const nc = g.nodeCards[finalLoc.id];
      const activatable = nc?.kind === 'faceUp' || nc?.kind === 'core';
      const startedOnSameNode = st.ms.origin?.type === 'node' && st.ms.origin.id === finalLoc.id;
      if (activatable && !startedOnSameNode) {
        if (st.pendingActivationNode === null) {
          st.pendingActivationNode = finalLoc.id;
          st.pendingActivationLoc = finalLoc;
          st.pendingActivationBonus = st.ms.chosenCount;
        } else if (st.pendingActivationNode === finalLoc.id) {
          // Convergence — accumulate bonus gems from this fleet.
          st.pendingActivationBonus += st.ms.chosenCount;
        }
        // A different node shouldn't happen with correct convergence
        // enforcement; if it does, stick with the first.
      }
    }
    this.completeFleet(g, ctx, st);
  }

  // Rulebook p.27/p.29: transports ending on a face-up card other than the
  // one they started on may activate it; arriving transports count as bonus
  // matching gems.
  private tryStartActivation(
    g: ImpulseState, ctx: EffectCtx, st: CommandState, finalLoc: ShipLocation,
  ): void {
    if (finalLoc.type !== 'node') { this.completeFleet(g, ctx, st); return; }
    if (st.ms.origin?.type === 'node' && st.ms.origin.id === finalLoc.id) {
      this.completeFleet(g, ctx, st); return;
    }
    const nc = g.nodeCards[finalLoc.id];
    if (!nc) { this.completeFleet(g, ctx, st); return; }
    if (nc.kind === 'core') {
      ctx.pendingChoice = {
        type: 'selectFromOptions',
        seat: ctx.seat,
        options: sectorCoreColorOptions(g, ctx.seat, st.ms.chosenCount),
        prompt: `Sector Core: choose mineral color for boost (+${st.ms.chosenCount} arriving transports).`,
      };
      st.stage = 'awaitingSectorCoreColor';
      return;
    }
    if (nc.kind !== 'faceUp') { this.completeFleet(g, ctx, st); return; }
    const c = card(nc.cardId);
    const sub = this.registry.resolve(c.effectFamily);
    if (!sub) {
      logInfo(g, `activate #${nc.cardId} (${c.effectFamily}): no handler; skip`);
      this.completeFleet(g, ctx, st);
      return;
    }
    // Cap chain depth so transports landing on Command cards can't recurse
    // without bound.
    const MAX_ACTIVATION_DEPTH = 4;
    if (ctx.activationDepth >= MAX_ACTIVATION_DEPTH) {
      logInfo(g, `activate #${nc.cardId}: max chain depth (${MAX_ACTIVATION_DEPTH}) reached; skip`);
      this.completeFleet(g, ctx, st);
      return;
    }
    log(g, {
      side: ctx.seat, kind: 'card.activate', payload: { nodeId: finalLoc.id, cardId: nc.cardId },
      msg: `activating #${nc.cardId} on N${finalLoc.id} (+${st.ms.chosenCount} bonus gems from arriving transports)`,
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
    this.mirrorActivation(g, ctx, st, subCtx);
  }

  private mirrorActivation(g: ImpulseState, ctx: EffectCtx, st: CommandState, sub: EffectCtx): void {
    if (sub.isComplete) {
      ctx.pendingChoice = null;
      st.activationCtx = null;
      this.completeFleet(g, ctx, st);
      return;
    }
    if (sub.pendingChoice) {
      ctx.pendingChoice = sub.pendingChoice;
      return; // paused; forwarded on next execute
    }
    ctx.isComplete = true;
  }

  private completeFleet(g: ImpulseState, ctx: EffectCtx, st: CommandState): void {
    // Rulebook p.31: "you cannot move the same fleet twice." Exclude both
    // the origin and the destination of the fleet that just moved.
    if (st.ms.origin) st.usedOrigins.push(keyOf(st.ms.origin));
    if (st.ms.path && st.ms.path.length > 0) st.usedOrigins.push(keyOf(st.ms.path[st.ms.path.length - 1]!));
    st.fleetIndex++;
    if (g.isGameOver) {
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }
    if (st.fleetIndex >= st.totalFleets) {
      // All fleets done — fire any deferred multi-fleet activation now, with
      // the accumulated bonus, against the final post-movement board state.
      if (st.pendingActivationNode !== null && st.pendingActivationLoc) {
        const loc = st.pendingActivationLoc;
        st.ms.chosenCount = st.pendingActivationBonus;
        st.pendingActivationNode = null;
        st.pendingActivationLoc = null;
        st.pendingActivationBonus = 0;
        this.tryStartActivation(g, ctx, st, loc);
        return;
      }
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }
    // Reset per-fleet state and prompt for the next origin.
    st.ms = newMovementState();
    st.activationCtx = null;

    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = this.byCardId[srcId]!;
    const boost = boostFromSource(g, ctx); // fixed at action start per FAQ p.45
    const effectiveMoves = prms.boostTarget === 'moveCount' ? prms.moveCount + boost : prms.moveCount;
    const convergence = st.convergenceSet === null ? null : new Set(st.convergenceSet);
    const legal = this.legalOrigins(g, ctx.seat, prms, st.usedOrigins, convergence, effectiveMoves);
    if (legal.length === 0) {
      logInfo(g, `command: no legal origins for fleet ${st.fleetIndex + 1}/${st.totalFleets} ` +
        `(convergence: [${st.convergenceSet?.join(',') ?? 'none'}])`);
      // Player-facing explanation for the multi-fleet auto-skip (from a live
      // problem report — see C# EmitNoConvergentFleetAlert).
      const desc = st.convergenceSet && st.convergenceSet.length > 0
        ? [...st.convergenceSet].sort((a, b) => a - b).map((n) => `N${n}`).join(' or ')
        : null;
      log(g, {
        kind: 'alert',
        payload: { reason: 'noConvergentFleet', convergence: st.convergenceSet },
        msg: desc !== null
          ? `Command: every fleet from this card must move onto the same sector card. ` +
            `The first fleet committed to ${desc}, and no other ship can reach there with the ` +
            `move(s) available — so the remaining fleet(s) stay put. ` +
            `Tip: whichever fleet you move first sets the card the others must share.`
          : 'Command: no remaining ship has a legal move, so the rest of this Command ends.',
      });
      if (st.pendingActivationNode !== null && st.pendingActivationLoc) {
        const loc = st.pendingActivationLoc;
        st.ms.chosenCount = st.pendingActivationBonus;
        st.pendingActivationNode = null;
        st.pendingActivationLoc = null;
        st.pendingActivationBonus = 0;
        this.tryStartActivation(g, ctx, st, loc);
        return;
      }
      st.stage = 'done';
      ctx.isComplete = true;
      return;
    }
    ctx.pendingChoice = {
      type: 'selectFleet',
      seat: ctx.seat,
      legalLocations: legal,
      allowSkip: true,
      prompt: `Select fleet ${st.fleetIndex + 1}/${st.totalFleets}.`,
    };
    st.stage = 'awaitingFleet';
  }

  private transitionToPath(
    g: ImpulseState, ctx: EffectCtx, st: CommandState, origin: ShipLocation, effectiveMoves: number,
  ): void {
    let paths = enumeratePaths(g, ctx.seat, origin, effectiveMoves);
    if (st.convergenceSet !== null) {
      const cset = new Set(st.convergenceSet);
      paths = paths.filter((p) => [...compatNodes(g, p[p.length - 1]!)].some((n) => cset.has(n)));
    }
    if (paths.length === 0) {
      logInfo(g, `no legal paths from ${origin.type}:${origin.id}`);
      this.completeFleet(g, ctx, st);
      return;
    }
    let prompt = `Declare a path of up to ${effectiveMoves} move(s)`;
    if (st.convergenceSet !== null) {
      prompt += ` — must converge on card(s) [${st.convergenceSet.map((n) => `N${n}`).join(', ')}]`;
    }
    ctx.pendingChoice = {
      type: 'declareMove',
      seat: ctx.seat,
      origin,
      maxMoves: effectiveMoves,
      legalPaths: paths,
      allowStay: true,
      prompt: prompt + '.',
    };
  }

  private legalOrigins(
    g: ImpulseState, mover: Seat, prms: CommandParams,
    exclude: string[], convergenceSet: Set<number> | null, effectiveMoves: number,
  ): ShipLocation[] {
    const result: ShipLocation[] = [];
    const seen = new Set<string>();
    const excluded = new Set(exclude);
    for (const sp of g.ships) {
      if (sp.owner !== mover) continue;
      const isNode = sp.loc.type === 'node';
      if (isNode && prms.shipType === 'cruiserOnly') continue;
      if (!isNode && prms.shipType === 'transportOnly') continue;
      const key = keyOf(sp.loc);
      if (seen.has(key)) continue;
      seen.add(key);
      if (excluded.has(key)) continue;
      if (countShipsAt(g, mover, sp.loc) < 1) continue;
      let paths = enumeratePaths(g, mover, sp.loc, effectiveMoves);
      if (convergenceSet !== null) {
        paths = paths.filter((p) => [...compatNodes(g, p[p.length - 1]!)].some((n) => convergenceSet.has(n)));
      }
      if (paths.length === 0) continue;
      result.push(sp.loc);
    }
    return result;
  }
}

const FAMILIES = [
  'command_n_ship_fleet_one_move',
  'command_n_cruiser_fleet_one_move',
  'command_n_transport_fleet_one_move',
  'command_one_cruiser_n_moves',
  'command_one_transport_n_moves',
  'command_n_fleets_one_move_same_card',
  'command_two_ship_fleet_n_moves',
  'command_two_cruiser_fleet_n_moves',
  'command_two_transport_fleet_n_moves',
  'command_n_ship_fleet_two_moves',
  'command_n_transport_fleet_two_moves',
];

export function registerCommand(r: EffectRegistry): void {
  const handler = new CommandHandler(r, COMMAND_PARAMS_BY_CARD_ID);
  for (const f of FAMILIES) r.register(f, handler);
}
