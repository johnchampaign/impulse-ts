// Pre-game home pick (rulebook p.3): "Draw 5 cards plus the card on your Home
// location, and choose one of the six to place face-up there." The default
// home card is moved into hand so the player picks among all six; the pick
// goes face-up at home. handlerState = the default card id.
import type { EffectHandler } from '../effects';
import { log } from '../log';
import { getPlayer, type SelectHandCardRequest } from '../types';

export const homePickHandler: EffectHandler = {
  execute(g, ctx) {
    const p = getPlayer(g, ctx.seat);
    const homeId = g.map.homeNodeIds[ctx.seat];
    if (homeId === undefined) throw new Error(`no home for ${ctx.seat}`);

    if (ctx.pendingChoice) {
      const req = ctx.pendingChoice as SelectHandCardRequest;
      ctx.pendingChoice = null;
      const picked = req.answer?.cardId ?? (ctx.handlerState as number);
      const i = p.hand.indexOf(picked);
      if (i < 0) throw new Error(`home pick: hand missing #${picked}`);
      p.hand.splice(i, 1);
      g.nodeCards[homeId] = { kind: 'faceUp', cardId: picked };
      log(g, {
        side: ctx.seat, kind: 'setup.homePick', payload: { nodeId: homeId, cardId: picked },
        msg: `${ctx.seat} home N${homeId} = #${picked}`,
      });
      ctx.isComplete = true;
      return;
    }

    const nc = g.nodeCards[homeId];
    if (!nc || nc.kind !== 'faceUp') {
      ctx.isComplete = true; // nothing to pick (already done or no card dealt)
      return;
    }
    p.hand.push(nc.cardId);
    delete g.nodeCards[homeId];
    ctx.handlerState = nc.cardId;
    ctx.pendingChoice = {
      type: 'selectHandCard',
      seat: ctx.seat,
      legalCardIds: [...p.hand],
      allowNone: false,
      noneLabel: 'DONE',
      prompt: `Pick one of your ${p.hand.length} cards to place face-up on Home (N${homeId}). ` +
        `Default was #${nc.cardId}.`,
    };
  },
};
