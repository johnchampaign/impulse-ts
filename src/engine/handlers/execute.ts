// Execute (rulebook p.35): perform an Action Card's text once and discard it
// without placing it on the Impulse — or activate one of your Techs. The
// only meta-action: it invokes another card's/tech's effect via a nested
// sub-context. Ported from C# ExecuteHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { ensureDeckCanDraw } from '../mechanics';
import {
  getPlayer, techInSlot, RACES,
  type EffectCtx, type ImpulseState, type SelectFromOptionsRequest,
  type SelectHandCardRequest, type SelectTechSlotRequest, type TechSlotName,
} from '../types';

type ExecuteSourceKind = 'hand' | 'deck';

interface ExecuteParams {
  source: ExecuteSourceKind;
  sizeFilter: number;
}

const PARAMS_BY_CARD_ID: Record<number, ExecuteParams> = {
  64: { source: 'hand', sizeFilter: 2 },
  65: { source: 'hand', sizeFilter: 2 },
  82: { source: 'deck', sizeFilter: 1 },
  86: { source: 'deck', sizeFilter: 1 },
  89: { source: 'hand', sizeFilter: 1 },
  97: { source: 'deck', sizeFilter: 1 },
};

type Stage = 'start' | 'awaitingSourceChoice' | 'awaitingHandPick' | 'awaitingTechSlot' | 'runningSub';

interface State {
  stage: Stage;
  subCtx: EffectCtx | null;
  // The executed card, in limbo (no zone) until the sub-effect completes,
  // then discarded. Null for the tech path. Conservation checks count it.
  cardToDiscardOnComplete: number | null;
}

export class ExecuteHandler implements EffectHandler {
  constructor(private registry: EffectRegistry) {}

  execute(g: ImpulseState, ctx: EffectCtx): void {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `execute: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const st = (ctx.handlerState as State | null) ?? {
      stage: 'start' as Stage, subCtx: null, cardToDiscardOnComplete: null,
    };
    ctx.handlerState = st;
    const p = getPlayer(g, ctx.seat);

    // Boost raises the size cap so larger cards become eligible.
    const effectiveSize = prms.sizeFilter + boostFromSource(g, ctx);

    if (st.stage === 'start') {
      // The deck path is spelled out: the top card is drawn at random and
      // performed immediately (a live report found this surprising).
      const options = [
        prms.source === 'hand'
          ? `Execute a card from your hand (size ≤ ${effectiveSize}), then discard it`
          : `Execute the deck's top card (size ≤ ${effectiveSize}) — drawn at random and performed now`,
        'Execute one of your techs',
      ];
      ctx.pendingChoice = {
        type: 'selectFromOptions',
        seat: ctx.seat,
        options,
        prompt: prms.source === 'hand'
          ? 'Execute what?'
          : 'Execute what? (the deck card is random — whatever it says happens immediately)',
      };
      st.stage = 'awaitingSourceChoice';
      return;
    }

    if (st.stage === 'awaitingSourceChoice') {
      const req = ctx.pendingChoice as SelectFromOptionsRequest;
      ctx.pendingChoice = null;
      const chosen = req.answer?.index ?? 0;

      if (chosen === 1) {
        ctx.pendingChoice = {
          type: 'selectTechSlot',
          seat: ctx.seat,
          incomingCardId: null,
          allowSkip: false,
          prompt: 'Choose a tech to execute.',
        };
        st.stage = 'awaitingTechSlot';
        return;
      }

      if (prms.source === 'hand') {
        const legal = p.hand.filter((id) => card(id).size <= effectiveSize);
        if (legal.length === 0) {
          logInfo(g, `execute: no eligible size≤${effectiveSize} card in hand`);
          ctx.isComplete = true;
          return;
        }
        ctx.pendingChoice = {
          type: 'selectHandCard',
          seat: ctx.seat,
          legalCardIds: legal,
          allowNone: true,
          noneLabel: 'DONE',
          prompt: `Execute a card size up to ${effectiveSize} from hand, or DONE.`,
        };
        st.stage = 'awaitingHandPick';
        return;
      }

      // Deck source: draw top, check filter.
      if (!ensureDeckCanDraw(g)) {
        logInfo(g, 'execute: deck empty');
        ctx.isComplete = true;
        return;
      }
      const drawn = g.deck.shift()!;
      const dc = card(drawn);
      if (dc.size > effectiveSize) {
        g.discard.push(drawn);
        log(g, {
          side: ctx.seat, kind: 'execute.reveal', payload: { cardId: drawn, outcome: 'discarded' },
          msg: `drew #${drawn} (${dc.color}/${dc.size}) — discard (need size ≤ ${effectiveSize})`,
        });
        ctx.isComplete = true;
        return;
      }
      this.beginCardSubEffect(g, ctx, st, drawn, false);
      return;
    }

    if (st.stage === 'awaitingHandPick') {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId === null) { ctx.isComplete = true; return; }
      this.beginCardSubEffect(g, ctx, st, cardId, true);
      return;
    }

    if (st.stage === 'awaitingTechSlot') {
      const req = ctx.pendingChoice as SelectTechSlotRequest;
      ctx.pendingChoice = null;
      const slot = req.answer?.slot;
      if (slot == null) throw new Error('execute: slot not chosen');
      this.beginTechSubEffect(g, ctx, st, slot);
      return;
    }

    if (st.stage === 'runningSub') {
      const sub = st.subCtx!;
      sub.pendingChoice = ctx.pendingChoice;
      const handler = this.resolveSubHandler(g, ctx, sub);
      handler?.execute(g, sub);
      this.mirrorSubState(ctx, sub);
      if (sub.isComplete && st.cardToDiscardOnComplete !== null) {
        g.discard.push(st.cardToDiscardOnComplete);
        logInfo(g, `executed #${st.cardToDiscardOnComplete} → discard`);
        st.cardToDiscardOnComplete = null;
      }
    }
  }

  // Sub-handler resolution from the sub-context's source (re-derived each
  // entry — handler instances can't live in JSON handler state).
  private resolveSubHandler(g: ImpulseState, outer: EffectCtx, sub: EffectCtx): EffectHandler | null {
    if (sub.source.type === 'tech' && sub.source.cardId === null) {
      const tech = techInSlot(getPlayer(g, outer.seat), sub.source.slot);
      if (tech.type === 'basicCommon') return this.registry.resolve('_tech_basic_common');
      if (tech.type === 'basicUnique') {
        const race = RACES.find((r) => r.id === tech.raceId)!;
        return this.registry.resolve(race.basicUniqueTechSlug);
      }
      return null;
    }
    const cardId = sourceCardId(sub.source);
    return cardId === null ? null : this.registry.resolve(card(cardId).effectFamily);
  }

  private beginCardSubEffect(
    g: ImpulseState, ctx: EffectCtx, st: State, cardId: number, removeFromHand: boolean,
  ): void {
    const c = card(cardId);
    if (removeFromHand) {
      const hand = getPlayer(g, ctx.seat).hand;
      hand.splice(hand.indexOf(cardId), 1);
    }
    const sub = this.registry.resolve(c.effectFamily);
    if (!sub) {
      logInfo(g, `execute: no handler for #${cardId} (${c.effectFamily}); discard`);
      g.discard.push(cardId);
      ctx.isComplete = true;
      return;
    }
    logInfo(g, `executing #${cardId} (${c.actionType}/${c.color}/${c.size})`);
    const subCtx: EffectCtx = {
      seat: ctx.seat,
      source: { type: 'impulseCard', cardId },
      pendingChoice: null,
      handlerState: null,
      isComplete: false,
      transportBonusGems: 0,
      activationDepth: ctx.activationDepth,
      pendingDefenderCandidates: null,
    };
    st.subCtx = subCtx;
    st.stage = 'runningSub';
    st.cardToDiscardOnComplete = cardId;

    sub.execute(g, subCtx);
    this.mirrorSubState(ctx, subCtx);
    if (subCtx.isComplete && st.cardToDiscardOnComplete !== null) {
      g.discard.push(st.cardToDiscardOnComplete);
      logInfo(g, `executed #${st.cardToDiscardOnComplete} → discard`);
      st.cardToDiscardOnComplete = null;
    }
  }

  private beginTechSubEffect(g: ImpulseState, ctx: EffectCtx, st: State, slot: TechSlotName): void {
    const tech = techInSlot(getPlayer(g, ctx.seat), slot);
    const techCardId = tech.type === 'researched' ? tech.cardId : null;
    const subCtx: EffectCtx = {
      seat: ctx.seat,
      source: { type: 'tech', slot, cardId: techCardId },
      pendingChoice: null,
      handlerState: null,
      isComplete: false,
      transportBonusGems: 0,
      activationDepth: ctx.activationDepth,
      pendingDefenderCandidates: null,
    };
    const sub = this.resolveSubHandler(g, ctx, subCtx);
    if (!sub) {
      logInfo(g, `execute tech: handler unavailable for ${tech.type}`);
      ctx.isComplete = true;
      return;
    }
    logInfo(g, `executing tech ${slot} (${tech.type})`);
    st.subCtx = subCtx;
    st.stage = 'runningSub';
    st.cardToDiscardOnComplete = null; // tech: nothing to discard

    sub.execute(g, subCtx);
    this.mirrorSubState(ctx, subCtx);
  }

  private mirrorSubState(outer: EffectCtx, sub: EffectCtx): void {
    if (sub.isComplete) {
      outer.pendingChoice = null;
      outer.isComplete = true;
      return;
    }
    if (sub.pendingChoice) {
      outer.pendingChoice = sub.pendingChoice;
      return;
    }
    // Sub returned without progress — bail to avoid a hang.
    outer.isComplete = true;
  }
}

const FAMILIES = [
  'execute_size_n_or_tech',
  'execute_size_n_from_deck_or_tech',
  'execute_size_n_from_hand_or_tech',
];

export function registerExecute(r: EffectRegistry): void {
  const handler = new ExecuteHandler(r);
  for (const f of FAMILIES) r.register(f, handler);
}
