// Human-readable labels for actions and cards. UI-only; never parsed.
import { card } from '../engine/catalog';
import type { ImpulseAction, ImpulseState, ShipLocation } from '../engine/types';

export function cardLabel(id: number): string {
  if (id === 0) return '🂠'; // redacted
  const c = card(id);
  return `#${c.id} ${c.actionType} ${c.color}/${c.size}`;
}

export function cardTitle(id: number): string {
  if (id === 0) return 'Hidden card';
  const c = card(id);
  return `#${c.id} — ${c.actionType} (${c.color}, size ${c.size})\n${c.effectText}`;
}

export function locLabel(loc: ShipLocation): string {
  return loc.type === 'node' ? `card N${loc.id}` : `gate G${loc.id}`;
}

function pathLabel(g: ImpulseState, action: Extract<ImpulseAction, { kind: 'answer' }>): string {
  const req = g.effect?.pendingChoice;
  if (req?.type !== 'declareMove' || action.answer.type !== 'declareMove') return 'Move';
  if (action.answer.pathIndex === -1) return 'STAY (no movement)';
  const path = req.legalPaths[action.answer.pathIndex];
  if (!path) return 'Move';
  return `Move ${locLabel(req.origin)} → ${path.map(locLabel).join(' → ')}`;
}

export function actionLabel(g: ImpulseState, action: ImpulseAction): string {
  switch (action.kind) {
    case 'placeImpulse': return `Place ${cardLabel(action.cardId)} on the Impulse`;
    case 'useTech': return `Use ${action.slot} tech`;
    case 'skipTech': return 'Skip tech';
    case 'useImpulseCard': return 'USE this card';
    case 'skipImpulseCard': return 'Skip this card';
    case 'usePlan': return 'Resolve your Plan now';
    case 'skipPlan': return 'Delay your Plan';
    case 'answer': {
      const a = action.answer;
      const req = g.effect?.pendingChoice;
      switch (a.type) {
        case 'handCard':
          return a.cardId === null
            ? (req?.type === 'selectHandCard' ? req.noneLabel : 'DONE')
            : cardLabel(a.cardId);
        case 'mineralCard': return `Refine ${cardLabel(a.cardId)}`;
        case 'shipPlacement': return `Build at ${locLabel(a.loc)}`;
        case 'fleet': return a.loc === null ? 'SKIP (no fleet)' : `Fleet at ${locLabel(a.loc)}`;
        case 'declareMove': return pathLabel(g, action);
        case 'fleetSize': return `${a.size} ship${a.size === 1 ? '' : 's'}`;
        case 'techSlot': return a.slot === null ? 'SKIP' : `${a.slot} slot`;
        case 'options':
          return req?.type === 'selectFromOptions' ? (req.options[a.index] ?? `Option ${a.index + 1}`) : `Option ${a.index + 1}`;
        case 'sabotageTarget': {
          if (req?.type === 'selectSabotageTarget') {
            const t = req.legalTargets[a.index];
            if (t) return `Sabotage ${t.owner} at ${locLabel(t.loc)}`;
          }
          return `Target ${a.index + 1}`;
        }
        case 'cancel': return 'Cancel';
      }
    }
  }
}
