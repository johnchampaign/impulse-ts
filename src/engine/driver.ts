// The turn machine. This is the C# GameRunner inverted for async play: instead
// of a blocking loop that calls controllers synchronously, the engine pauses
// into serializable state (`pending`) whenever it needs input, and
// `applyAction` resumes it. One full C# turn = the same six phases; every
// prompt (top-level action or mid-effect choice) is a network round-trip.
import { card } from './catalog';
import type { EffectHandler, EffectRegistry } from './effects';
import { log, logInfo } from './log';
import * as Mechanics from './mechanics';
import { runPhase5 } from './scoring';
import {
  getPlayer, techInSlot, RACES,
  type ChoiceAnswer, type ChoiceRequest, type EffectSource, type ImpulseAction,
  type ImpulseState, type Seat, type Tech, type TechSlotName,
} from './types';

export const IMPULSE_CAP = 3;
export const CLEANUP_DRAW = 2;
export const PLAN_FORCE_THRESHOLD = 4;
export const MAX_TURNS = 400; // stall backstop; smoke asserts games end well before

// ---------- advance: run automatic steps until input is needed ----------

export function advance(g: ImpulseState, registry: EffectRegistry): void {
  let guard = 0;
  while (!g.isGameOver && !g.pending) {
    if (++guard > 10_000) throw new Error('advance: no progress (engine stall)');
    switch (g.phase) {
      case 'homePick': stepHomePick(g, registry); break;
      case 'addImpulse': stepAddImpulse(g); break;
      case 'useTech': stepUseTech(g, registry); break;
      case 'resolveImpulse': stepResolveImpulse(g, registry); break;
      case 'usePlan': stepUsePlan(g, registry); break;
      case 'score':
        runPhase5(g, g.activeSeat);
        if (!g.isGameOver) g.phase = 'cleanup';
        break;
      case 'cleanup': stepCleanup(g); break;
      case 'gameOver': return;
    }
  }
}

function stepHomePick(g: ImpulseState, registry: EffectRegistry): void {
  if (g.effect) throw new Error('homePick: effect already in flight');
  if (g.homePickIndex >= g.players.length) {
    g.phase = 'addImpulse';
    return;
  }
  const seat = g.players[g.homePickIndex]!.seat;
  startEffect(g, registry, seat, { type: 'setup' });
}

function stepAddImpulse(g: ImpulseState): void {
  const p = getPlayer(g, g.activeSeat);
  log(g, {
    side: g.activeSeat, kind: 'turn.phase',
    payload: { turn: g.turn, phase: 'addImpulse', skipped: p.hand.length === 0 },
    msg: `— ${g.activeSeat} turn ${g.turn} phase addImpulse${p.hand.length === 0 ? ' (skipped: empty hand)' : ''}`,
  });
  if (p.hand.length === 0) {
    g.phase = 'useTech';
    return;
  }
  g.pending = { type: 'action', seat: g.activeSeat };
}

function stepUseTech(g: ImpulseState, registry: EffectRegistry): void {
  const p = getPlayer(g, g.activeSeat);
  const usable = (['left', 'right'] as const).filter((slot) =>
    techIsUsable(registry, techInSlot(p, slot)));
  if (usable.length === 0) {
    // No slot has a ported handler yet — auto-skip rather than offering a
    // dead choice. (Deviation from C#, which offers unhandled slots and
    // no-ops them; pointless as a network round-trip.)
    toResolveImpulse(g);
    return;
  }
  g.pending = { type: 'action', seat: g.activeSeat };
}

export function techIsUsable(registry: EffectRegistry, tech: Tech): boolean {
  switch (tech.type) {
    case 'basicCommon': return registry.isRegistered('_tech_basic_common');
    case 'basicUnique': {
      const race = RACES.find((r) => r.id === tech.raceId)!;
      return registry.isRegistered(race.basicUniqueTechSlug);
    }
    case 'researched': return registry.isRegistered(card(tech.cardId).effectFamily);
  }
}

function toResolveImpulse(g: ImpulseState): void {
  g.phase = 'resolveImpulse';
  g.impulseCursor = 0;
}

function stepResolveImpulse(g: ImpulseState, registry: EffectRegistry): void {
  while (g.impulseCursor < g.impulse.length && !g.isGameOver) {
    const cardId = g.impulse[g.impulseCursor]!;
    const c = card(cardId);
    if (!registry.isRegistered(c.effectFamily)) {
      log(g, {
        kind: 'impulse.autoskip', payload: { cursor: g.impulseCursor, cardId, family: c.effectFamily },
        msg: `cursor=[${g.impulseCursor}] #${cardId} (${c.effectFamily}) — no handler, auto-skip`,
      });
      g.impulseCursor++;
      continue;
    }
    g.pending = { type: 'action', seat: g.activeSeat };
    return;
  }
  if (g.isGameOver) return;
  g.phase = 'usePlan';
  g.planWalk = null;
}

function stepUsePlan(g: ImpulseState, registry: EffectRegistry): void {
  const p = getPlayer(g, g.activeSeat);
  if (!g.isResolvingPlan) {
    if (p.plan.length === 0) {
      g.phase = 'score';
      return;
    }
    // Force-use if Plan has >= 4 cards (rulebook p.20).
    if (p.plan.length >= PLAN_FORCE_THRESHOLD) {
      log(g, {
        side: g.activeSeat, kind: 'plan.forced', payload: { size: p.plan.length },
        msg: `Plan forced (≥${PLAN_FORCE_THRESHOLD} cards) for ${g.activeSeat}`,
      });
      g.isResolvingPlan = true;
      return; // loop re-enters, now resolving
    }
    g.planWalk = 'decide';
    g.pending = { type: 'action', seat: g.activeSeat };
    return;
  }

  // Walk the Plan in order, prompting USE/SKIP per card; every card discards
  // as it is passed (C# removes before the effect runs so mid-effect
  // references see consistent state).
  while (p.plan.length > 0 && !g.isGameOver) {
    const cardId = p.plan.shift()!;
    g.discard.push(cardId);
    g.currentlyResolvingPlanCardId = cardId;
    const c = card(cardId);
    if (!registry.isRegistered(c.effectFamily)) {
      log(g, {
        kind: 'plan.autoskip', payload: { cardId, family: c.effectFamily },
        msg: `plan #${cardId} (${c.effectFamily}) — no handler, auto-skip`,
      });
      g.currentlyResolvingPlanCardId = null;
      continue;
    }
    g.planWalk = 'card';
    g.pending = { type: 'action', seat: g.activeSeat };
    return;
  }
  if (g.isGameOver) return;
  endPlanResolution(g);
}

function endPlanResolution(g: ImpulseState): void {
  const p = getPlayer(g, g.activeSeat);
  g.isResolvingPlan = false;
  g.planWalk = null;
  g.currentlyResolvingPlanCardId = null;
  if (p.nextPlan && p.nextPlan.length > 0) {
    p.plan.push(...p.nextPlan);
    log(g, {
      side: g.activeSeat, kind: 'plan.promote', payload: { count: p.nextPlan.length },
      msg: `${g.activeSeat} NextPlan (${p.nextPlan.length}) → Plan for next turn`,
    });
  }
  p.nextPlan = null;
  g.phase = 'score';
}

function stepCleanup(g: ImpulseState): void {
  Mechanics.trimImpulseTopTo(g, IMPULSE_CAP);
  Mechanics.drawFromDeck(g, g.activeSeat, CLEANUP_DRAW);
  if (g.isGameOver) return;

  const idx = g.players.findIndex((p) => p.seat === g.activeSeat);
  const nextIdx = (idx + 1) % g.players.length;
  g.activeSeat = g.players[nextIdx]!.seat;
  if (nextIdx === 0) g.turn++;
  g.phase = 'addImpulse';
  if (g.turn > MAX_TURNS) {
    // Stall backstop for AI-vs-AI games in restricted decks; a real game
    // ends by prestige long before this.
    g.isGameOver = true;
    g.phase = 'gameOver';
    logInfo(g, `!! game stopped at turn cap ${MAX_TURNS}`);
  }
}

// ---------- effects ----------

export function startEffect(
  g: ImpulseState, registry: EffectRegistry, seat: Seat, source: EffectSource,
): void {
  g.effect = {
    seat,
    source,
    pendingChoice: null,
    handlerState: null,
    isComplete: false,
    transportBonusGems: 0,
    activationDepth: 0,
  };
  runEffectLoop(g, registry);
}

export function resolveHandlerFor(
  g: ImpulseState, registry: EffectRegistry, source: EffectSource,
): EffectHandler | null {
  switch (source.type) {
    case 'setup':
      return registry.resolve('_home_pick');
    case 'impulseCard':
    case 'planCard':
    case 'mapActivation':
      return registry.resolve(card(source.cardId).effectFamily);
    case 'tech': {
      if (source.cardId !== null) return registry.resolve(card(source.cardId).effectFamily);
      const p = getPlayer(g, g.activeSeat);
      const tech = techInSlot(p, source.slot);
      if (tech.type === 'basicCommon') return registry.resolve('_tech_basic_common');
      if (tech.type === 'basicUnique') {
        const race = RACES.find((r) => r.id === tech.raceId)!;
        return registry.resolve(race.basicUniqueTechSlug);
      }
      return null;
    }
  }
}

function runEffectLoop(g: ImpulseState, registry: EffectRegistry): void {
  const ctx = g.effect;
  if (!ctx) throw new Error('runEffectLoop: no effect in flight');
  const handler = resolveHandlerFor(g, registry, ctx.source);
  if (!handler) {
    logInfo(g, `! no handler for effect source ${JSON.stringify(ctx.source)}; skipping`);
    finishEffect(g, registry);
    return;
  }
  while (!ctx.isComplete && !g.isGameOver) {
    handler.execute(g, ctx);
    if (ctx.isComplete) break;
    if (ctx.pendingChoice && ctx.pendingChoice.answer === undefined) {
      g.pending = { type: 'choice', seat: ctx.pendingChoice.seat };
      return; // paused, awaiting the answer
    }
    if (!ctx.pendingChoice) {
      logInfo(g, '! handler returned without pause or completion');
      break;
    }
    // pendingChoice has an answer attached: loop re-executes to consume it.
  }
  finishEffect(g, registry);
}

function finishEffect(g: ImpulseState, _registry: EffectRegistry): void {
  g.effect = null;
  if (g.isGameOver) return;
  switch (g.phase) {
    case 'homePick':
      g.homePickIndex++;
      break;
    case 'useTech':
      toResolveImpulse(g);
      break;
    case 'resolveImpulse':
      g.impulseCursor++;
      break;
    case 'usePlan':
      g.currentlyResolvingPlanCardId = null;
      break;
  }
}

// ---------- action application ----------

export class IllegalActionError extends Error {}

export function applyAction(
  g: ImpulseState, registry: EffectRegistry, action: ImpulseAction, actor: Seat,
): void {
  if (g.isGameOver) throw new IllegalActionError('game is over');
  const pending = g.pending;
  if (!pending) throw new IllegalActionError('engine is not awaiting input');
  if (pending.seat !== actor) throw new IllegalActionError(`not ${actor}'s turn to act`);

  if (pending.type === 'choice') {
    if (action.kind !== 'answer') throw new IllegalActionError('a choice answer is required');
    const ctx = g.effect;
    if (!ctx?.pendingChoice) throw new IllegalActionError('no pending choice');
    if (action.answer.type === 'cancel') {
      // Restart the effect from scratch (mirrors the C# Cancelled path).
      log(g, { side: actor, kind: 'choice.cancel', msg: `${actor} cancelled; restarting effect` });
      ctx.pendingChoice = null;
      ctx.handlerState = null;
      g.pending = null;
      runEffectLoop(g, registry);
      advance(g, registry);
      return;
    }
    attachAnswer(ctx.pendingChoice, action.answer);
    g.pending = null;
    runEffectLoop(g, registry);
    advance(g, registry);
    return;
  }

  // Phase-level action.
  if (action.kind === 'answer') throw new IllegalActionError('no choice is pending');
  const p = getPlayer(g, g.activeSeat);
  switch (g.phase) {
    case 'addImpulse': {
      if (action.kind !== 'placeImpulse') throw new IllegalActionError(`expected placeImpulse in ${g.phase}`);
      if (!p.hand.includes(action.cardId)) throw new IllegalActionError(`card #${action.cardId} not in hand`);
      Mechanics.placeOnImpulse(g, g.activeSeat, action.cardId);
      g.phase = 'useTech';
      break;
    }
    case 'useTech': {
      if (action.kind === 'skipTech') {
        toResolveImpulse(g);
        break;
      }
      if (action.kind !== 'useTech') throw new IllegalActionError(`expected useTech/skipTech in ${g.phase}`);
      const tech = techInSlot(p, action.slot);
      if (!techIsUsable(registry, tech)) throw new IllegalActionError(`tech in slot ${action.slot} is not usable`);
      log(g, {
        side: g.activeSeat, kind: 'tech.use', payload: { slot: action.slot, tech },
        msg: `Phase2: ${g.activeSeat} uses tech ${action.slot} (${tech.type})`,
      });
      g.pending = null;
      startEffect(g, registry, g.activeSeat, {
        type: 'tech',
        slot: action.slot,
        cardId: tech.type === 'researched' ? tech.cardId : null,
      });
      advance(g, registry);
      return;
    }
    case 'resolveImpulse': {
      const cardId = g.impulse[g.impulseCursor];
      if (cardId === undefined) throw new IllegalActionError('impulse cursor out of range');
      if (action.kind === 'skipImpulseCard') {
        log(g, {
          side: g.activeSeat, kind: 'impulse.skip', payload: { cursor: g.impulseCursor, cardId },
          msg: `cursor=[${g.impulseCursor}] #${cardId} skipped by ${g.activeSeat}`,
        });
        g.impulseCursor++;
        break;
      }
      if (action.kind !== 'useImpulseCard') throw new IllegalActionError(`expected use/skipImpulseCard in ${g.phase}`);
      const c = card(cardId);
      log(g, {
        side: g.activeSeat, kind: 'impulse.use', payload: { cursor: g.impulseCursor, cardId },
        msg: `cursor=[${g.impulseCursor}] #${cardId} used by ${g.activeSeat} (${c.actionType})`,
      });
      g.pending = null;
      startEffect(g, registry, g.activeSeat, { type: 'impulseCard', cardId });
      advance(g, registry);
      return;
    }
    case 'usePlan': {
      if (g.planWalk === 'decide') {
        if (action.kind === 'skipPlan') {
          log(g, {
            side: g.activeSeat, kind: 'plan.delay', payload: { size: p.plan.length },
            msg: `Plan delayed by ${g.activeSeat} (${p.plan.length} cards)`,
          });
          g.planWalk = null;
          g.phase = 'score';
          break;
        }
        if (action.kind !== 'usePlan') throw new IllegalActionError(`expected usePlan/skipPlan`);
        g.planWalk = null;
        g.isResolvingPlan = true;
        break;
      }
      if (g.planWalk === 'card') {
        const cardId = g.currentlyResolvingPlanCardId;
        if (cardId === null) throw new IllegalActionError('no plan card being resolved');
        if (action.kind === 'skipImpulseCard') {
          log(g, {
            side: g.activeSeat, kind: 'plan.skip', payload: { cardId },
            msg: `plan #${cardId} skipped by ${g.activeSeat}`,
          });
          g.currentlyResolvingPlanCardId = null;
          g.planWalk = null;
          break;
        }
        if (action.kind !== 'useImpulseCard') throw new IllegalActionError(`expected use/skipImpulseCard for plan card`);
        const c = card(cardId);
        log(g, {
          side: g.activeSeat, kind: 'plan.use', payload: { cardId },
          msg: `plan #${cardId} used by ${g.activeSeat} (${c.actionType})`,
        });
        g.planWalk = null;
        g.pending = null;
        startEffect(g, registry, g.activeSeat, { type: 'planCard', cardId });
        advance(g, registry);
        return;
      }
      throw new IllegalActionError('usePlan: no decision pending');
    }
    default:
      throw new IllegalActionError(`no action expected in phase ${g.phase}`);
  }
  g.pending = null;
  advance(g, registry);
}

function attachAnswer(req: ChoiceRequest, answer: ChoiceAnswer): void {
  const fail = (): never => {
    throw new IllegalActionError(`answer ${answer.type} does not fit request ${req.type}`);
  };
  switch (req.type) {
    case 'selectHandCard': {
      if (answer.type !== 'handCard') return fail();
      if (answer.cardId === null && !req.allowNone) return fail();
      if (answer.cardId !== null && !req.legalCardIds.includes(answer.cardId)) return fail();
      req.answer = { cardId: answer.cardId };
      return;
    }
    case 'selectMineralCard': {
      if (answer.type !== 'mineralCard') return fail();
      if (!req.legalCardIds.includes(answer.cardId)) return fail();
      req.answer = { cardId: answer.cardId };
      return;
    }
    case 'selectShipPlacement': {
      if (answer.type !== 'shipPlacement') return fail();
      if (!req.legalLocations.some((l) => l.type === answer.loc.type && l.id === answer.loc.id)) return fail();
      req.answer = { loc: answer.loc };
      return;
    }
    case 'selectFleet': {
      if (answer.type !== 'fleet') return fail();
      if (answer.loc === null && !req.allowSkip) return fail();
      if (answer.loc !== null && !req.legalLocations.some((l) => l.type === answer.loc!.type && l.id === answer.loc!.id)) return fail();
      req.answer = { loc: answer.loc };
      return;
    }
    case 'declareMove': {
      if (answer.type !== 'declareMove') return fail();
      if (answer.pathIndex < 0 || answer.pathIndex >= req.legalPaths.length) return fail();
      req.answer = { pathIndex: answer.pathIndex };
      return;
    }
    case 'selectFleetSize': {
      if (answer.type !== 'fleetSize') return fail();
      if (answer.size < req.min || answer.size > req.max) return fail();
      req.answer = { size: answer.size };
      return;
    }
    case 'selectTechSlot': {
      if (answer.type !== 'techSlot') return fail();
      if (answer.slot === null && !req.allowSkip) return fail();
      req.answer = { slot: answer.slot };
      return;
    }
    case 'selectFromOptions': {
      if (answer.type !== 'options') return fail();
      if (answer.index < 0 || answer.index >= req.options.length) return fail();
      req.answer = { index: answer.index };
      return;
    }
    case 'selectSabotageTarget': {
      if (answer.type !== 'sabotageTarget') return fail();
      if (answer.index < 0 || answer.index >= req.legalTargets.length) return fail();
      req.answer = { index: answer.index };
      return;
    }
  }
}

// ---------- legal actions ----------

export function legalActions(
  g: ImpulseState, registry: EffectRegistry, actor: Seat,
): ImpulseAction[] {
  if (g.isGameOver || !g.pending || g.pending.seat !== actor) return [];

  if (g.pending.type === 'choice') {
    const req = g.effect?.pendingChoice;
    if (!req) return [];
    return answersFor(req).map((answer) => ({ kind: 'answer' as const, answer }));
  }

  const p = getPlayer(g, g.activeSeat);
  switch (g.phase) {
    case 'addImpulse':
      return [...new Set(p.hand)].map((cardId) => ({ kind: 'placeImpulse' as const, cardId }));
    case 'useTech': {
      const actions: ImpulseAction[] = [{ kind: 'skipTech' }];
      for (const slot of ['left', 'right'] as const) {
        if (techIsUsable(registry, techInSlot(p, slot))) actions.push({ kind: 'useTech', slot });
      }
      return actions;
    }
    case 'resolveImpulse':
      return [{ kind: 'useImpulseCard' }, { kind: 'skipImpulseCard' }];
    case 'usePlan':
      return g.planWalk === 'decide'
        ? [{ kind: 'usePlan' }, { kind: 'skipPlan' }]
        : [{ kind: 'useImpulseCard' }, { kind: 'skipImpulseCard' }];
    default:
      return [];
  }
}

function answersFor(req: ChoiceRequest): ChoiceAnswer[] {
  switch (req.type) {
    case 'selectHandCard': {
      const out: ChoiceAnswer[] = [...new Set(req.legalCardIds)]
        .map((cardId) => ({ type: 'handCard' as const, cardId }));
      if (req.allowNone) out.push({ type: 'handCard', cardId: null });
      return out;
    }
    case 'selectMineralCard':
      return [...new Set(req.legalCardIds)].map((cardId) => ({ type: 'mineralCard' as const, cardId }));
    case 'selectShipPlacement':
      return req.legalLocations.map((loc) => ({ type: 'shipPlacement' as const, loc }));
    case 'selectFleet': {
      const out: ChoiceAnswer[] = req.legalLocations.map((loc) => ({ type: 'fleet' as const, loc }));
      if (req.allowSkip) out.push({ type: 'fleet', loc: null });
      return out;
    }
    case 'declareMove':
      return req.legalPaths.map((_, pathIndex) => ({ type: 'declareMove' as const, pathIndex }));
    case 'selectFleetSize':
      return Array.from({ length: req.max - req.min + 1 }, (_, i) => ({
        type: 'fleetSize' as const, size: req.min + i,
      }));
    case 'selectTechSlot': {
      const out: ChoiceAnswer[] = (['left', 'right'] as const).map((slot) => ({ type: 'techSlot' as const, slot }));
      if (req.allowSkip) out.push({ type: 'techSlot', slot: null });
      return out;
    }
    case 'selectFromOptions':
      return req.options.map((_, index) => ({ type: 'options' as const, index }));
    case 'selectSabotageTarget':
      return req.legalTargets.map((_, index) => ({ type: 'sabotageTarget' as const, index }));
  }
}
