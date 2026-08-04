// Research: move a card from hand/deck/Plan into a tech slot, permanently
// covering what was there (p.20: "Once covered up, Basic Techs are gone!").
// c18 additionally executes the just-researched card ("Then Execute it").
// Ported from C# ResearchHandler.
import { boostFromSource, sourceCardId } from '../boost';
import { card } from '../catalog';
import type { EffectHandler, EffectRegistry } from '../effects';
import { log, logInfo } from '../log';
import { ensureDeckCanDraw, researchInto } from '../mechanics';
import {
  getPlayer,
  type CardColor, type EffectCtx, type ImpulseState,
  type SelectHandCardRequest, type SelectTechSlotRequest,
} from '../types';
import { describeFilter, matches } from './common';

type ResearchSource = 'hand' | 'deck' | 'plan';
type ResearchBoostTarget = 'count' | 'size';

interface ResearchParams {
  count: number;
  sizeFilter: number | null;
  colorFilter: CardColor | null;
  source: ResearchSource;
  boostTarget: ResearchBoostTarget;
  thenExecute: boolean;
}

const rp = (
  count: number, sizeFilter: number | null, colorFilter: CardColor | null,
  source: ResearchSource, boostTarget: ResearchBoostTarget, thenExecute = false,
): ResearchParams => ({ count, sizeFilter, colorFilter, source, boostTarget, thenExecute });

const PARAMS_BY_CARD_ID: Record<number, ResearchParams> = {
  // "Research one size [1] card" → boost size.
  2: rp(1, 1, null, 'hand', 'size'),
  18: rp(1, 1, null, 'hand', 'size', true),
  54: rp(1, 1, null, 'hand', 'size'),
  77: rp(1, 1, null, 'hand', 'size'),
  101: rp(1, 1, null, 'plan', 'size'),
  // "Research [1][color] card" → boost count.
  20: rp(1, null, 'Green', 'hand', 'count'),
  60: rp(1, null, 'Yellow', 'hand', 'count'),
  74: rp(1, null, 'Blue', 'hand', 'count'),
  76: rp(1, null, 'Red', 'hand', 'count'),
  // "Research two size [1] cards from the deck" → boost size.
  63: rp(2, 1, null, 'deck', 'size'),
  96: rp(2, 1, null, 'deck', 'size'),
}

interface State {
  remaining: number;
  pickedCardId: number | null;
  // True when pickedCardId was drawn from the deck and is in no zone until
  // the slot choice resolves ("limbo"). Hand/plan picks stay in their zone.
  // Conservation checks count limbo cards by this flag.
  pickedFromDeck: boolean;
  subCtx: EffectCtx | null; // ThenExecute sub-effect
}

export class ResearchHandler implements EffectHandler {
  constructor(private registry: EffectRegistry) {}

  execute(g: ImpulseState, ctx: EffectCtx): void {
    const srcId = sourceCardId(ctx.source) ?? 0;
    const prms = PARAMS_BY_CARD_ID[srcId];
    if (!prms) {
      logInfo(g, `research: no params for #${srcId}; noop`);
      ctx.isComplete = true;
      return;
    }
    const p = getPlayer(g, ctx.seat);
    const boost = boostFromSource(g, ctx);
    const effectiveCount = prms.boostTarget === 'count' ? prms.count + boost : prms.count;
    const effectiveSize = prms.boostTarget === 'size' && prms.sizeFilter !== null
      ? prms.sizeFilter + boost : prms.sizeFilter;
    const st = (ctx.handlerState as State | null) ?? {
      remaining: effectiveCount, pickedCardId: null, pickedFromDeck: false, subCtx: null,
    };
    ctx.handlerState = st;

    // ThenExecute sub-effect in progress: forward pause/resume cycles
    // (explicit choice sync-down — see command.ts for rationale).
    if (st.subCtx) {
      const sub = st.subCtx;
      sub.pendingChoice = ctx.pendingChoice;
      const subCardId = sourceCardId(sub.source);
      const handler = subCardId === null ? null : this.registry.resolve(card(subCardId).effectFamily);
      handler?.execute(g, sub);
      if (sub.isComplete) {
        ctx.pendingChoice = null;
        ctx.isComplete = true;
        st.subCtx = null;
        return;
      }
      if (sub.pendingChoice) {
        ctx.pendingChoice = sub.pendingChoice;
        return;
      }
      ctx.isComplete = true;
      return;
    }

    // Resume after picking a hand/plan card.
    if (ctx.pendingChoice?.type === 'selectHandCard') {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const cardId = req.answer?.cardId ?? null;
      if (cardId === null) { ctx.isComplete = true; return; }
      st.pickedCardId = cardId;
      ctx.pendingChoice = {
        type: 'selectTechSlot',
        seat: ctx.seat,
        incomingCardId: cardId,
        allowSkip: true,
        prompt: `Choose a tech slot to overwrite with #${cardId}, or SKIP to keep the card.`,
      };
      return;
    }

    // Resume after picking a tech slot.
    if (ctx.pendingChoice?.type === 'selectTechSlot') {
      const req = ctx.pendingChoice as SelectTechSlotRequest;
      ctx.pendingChoice = null;
      const cardId = st.pickedCardId!;
      const slot = req.answer?.slot ?? null;
      if (slot === null) {
        // Skip: hand/plan card stays where it was; a deck draw is discarded.
        if (prms.source === 'deck') {
          g.discard.push(cardId);
          logInfo(g, `research skipped — #${cardId} discarded`);
        } else {
          logInfo(g, `research skipped — #${cardId} stays in ${prms.source}`);
        }
        st.pickedCardId = null;
        st.pickedFromDeck = false;
        st.remaining--;
        if (st.remaining <= 0) { ctx.isComplete = true; return; }
        // Fall through to draw/prompt the next research slot.
      } else {
        // Move the card from its source into the slot.
        if (prms.source === 'hand') {
          const i = p.hand.indexOf(cardId);
          if (i < 0) throw new Error(`hand missing #${cardId}`);
          p.hand.splice(i, 1);
        } else if (prms.source === 'plan') {
          // splice preserves the order of the remaining plan cards, matching
          // c101 "leaving the other cards in the same order".
          const i = p.plan.indexOf(cardId);
          if (i < 0) throw new Error(`plan missing #${cardId}`);
          p.plan.splice(i, 1);
        }
        // (deck source: already removed when drawn)
        researchInto(g, ctx.seat, slot, cardId);
        st.pickedCardId = null;
        st.pickedFromDeck = false;
        st.remaining--;

        if (prms.thenExecute) {
          const c = card(cardId);
          const sub = this.registry.resolve(c.effectFamily);
          if (!sub) {
            logInfo(g, `ThenExecute: no handler for #${cardId} (${c.effectFamily}); skip`);
            ctx.isComplete = true;
            return;
          }
          logInfo(g, `ThenExecute: running #${cardId}`);
          const subCtx: EffectCtx = {
            seat: ctx.seat,
            source: { type: 'tech', slot, cardId },
            pendingChoice: null,
            handlerState: null,
            isComplete: false,
            transportBonusGems: 0,
            activationDepth: ctx.activationDepth,
            pendingDefenderCandidates: null,
          };
          st.subCtx = subCtx;
          sub.execute(g, subCtx);
          if (subCtx.isComplete) {
            ctx.isComplete = true;
            st.subCtx = null;
            return;
          }
          if (subCtx.pendingChoice) {
            ctx.pendingChoice = subCtx.pendingChoice;
            return;
          }
          ctx.isComplete = true;
          return;
        }
      }
    }

    if (st.remaining <= 0) { ctx.isComplete = true; return; }

    if (prms.source === 'hand' || prms.source === 'plan') {
      const pool = prms.source === 'hand' ? p.hand : p.plan;
      const legal = pool.filter((id) => matches(card(id), effectiveSize, prms.colorFilter));
      if (legal.length === 0) { ctx.isComplete = true; return; }
      ctx.pendingChoice = {
        type: 'selectHandCard',
        seat: ctx.seat,
        legalCardIds: legal,
        allowNone: true,
        noneLabel: 'DONE',
        prompt: `Research a card from your ${prms.source === 'hand' ? 'hand' : 'Plan'} matching ` +
          `${describeFilter(effectiveSize, prms.colorFilter)} (${st.remaining} remaining), or DONE.`,
      };
      return;
    }

    // Deck source: draw and decide.
    if (!ensureDeckCanDraw(g)) { ctx.isComplete = true; return; }
    const drawn = g.deck.shift()!;
    const c = card(drawn);
    if (matches(c, effectiveSize, prms.colorFilter)) {
      // Match → prompt slot. Card sits in limbo (handler state) until placed.
      st.pickedCardId = drawn;
      st.pickedFromDeck = true;
      ctx.pendingChoice = {
        type: 'selectTechSlot',
        seat: ctx.seat,
        incomingCardId: drawn,
        allowSkip: true,
        prompt: `Choose a tech slot to overwrite with #${drawn}, or SKIP to discard.`,
      };
      return;
    }
    g.discard.push(drawn);
    log(g, {
      side: ctx.seat, kind: 'research.reveal', payload: { cardId: drawn, outcome: 'discarded' },
      msg: `drew #${drawn} (${c.color}/${c.size}) — discard (${describeFilter(effectiveSize, prms.colorFilter)})`,
    });
    st.remaining--;
    // Loop by re-entering (the engine only re-enters on pause).
    this.execute(g, ctx);
  }
}

const FAMILIES = [
  'research_size_n_from_hand',
  'research_size_n_from_hand_then_execute',
  'research_n_color_from_hand',
  'research_n_size_from_deck',
  'research_n_from_plan_keep_order',
];

export function registerResearch(r: EffectRegistry): void {
  const handler = new ResearchHandler(r);
  for (const f of FAMILIES) r.register(f, handler);
}
