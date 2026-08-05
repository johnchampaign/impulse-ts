// AI opponent — a port of the C# PolicyController (../Impulse/src/Impulse.Core/
// Controllers/PolicyController.cs), whose weights were tuned against real-game
// telemetry (the comments carrying that evidence are preserved below).
//
// Structure matches the original: score every legal action and take the best
// with a random tiebreak. The C# controller had two entry points (PickAction
// for phase actions, AnswerChoice for mid-effect prompts); here both arrive as
// members of one `legalActions` list, so scoring is unified and whatever we
// return is legal by construction.
//
// IMPORTANT — this runs server-side and is handed the AI seat's OWN REDACTED
// VIEW (framework GameServer.driveAi), so it cannot see opponents' hands, the
// deck, face-down sectors, or handler state. Hidden card ids arrive as 0. That
// is deliberate: the AI plays with the same information a human seat has.
//
// Pure module: no DOM, no import.meta.env — it has to run in a Worker.
import type { Rng } from 'digital-boardgame-framework';
import { isValidReinforcement } from '../engine/battle';
import { card } from '../engine/catalog';
import { CORE_COLOR_DISPLAY_ORDER } from '../engine/handlers/movementExec';
import { BATTLE_MARK, PROMPT_PREFIX } from '../engine/prompts';
import { gate, gatesAt, locsEqual, node } from '../engine/map';
import { neighbors } from '../engine/movement';
import { WIN_THRESHOLD } from '../engine/scoring';
import {
  getPlayer,
  type Card, type ImpulseAction, type ImpulseState, type Seat, type ShipLocation,
  type TechSlotName,
} from '../engine/types';

export const AI_POLICIES = ['greedy', 'warrior', 'corerush', 'munchkin', 'refine'] as const;
export type AiPolicy = (typeof AI_POLICIES)[number];

// Prompt markers the AI keys off, imported from the engine (src/engine/prompts.ts)
// so a reworded prompt is a compile-time concern, not a silent behaviour change.
const { exploring: EXPLORE_PROMPT, homePick: HOME_PICK_PROMPT,
  sectorCoreColor: CORE_COLOR_PROMPT } = PROMPT_PREFIX;
const BATTLE_PROMPT = BATTLE_MARK;

// A score low enough that an option is only taken when it is the only one.
const LAST_RESORT = -1000;

// ---------------------------------------------------------------- geometry

function axialDistance(q1: number, r1: number, q2: number, r2: number): number {
  const dq = q1 - q2;
  const dr = r1 - r2;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

function distanceToCore(g: ImpulseState, loc: ShipLocation): number {
  const core = node(g.map, g.map.sectorCoreNodeId);
  if (loc.type === 'node') {
    const n = node(g.map, loc.id);
    return axialDistance(n.q, n.r, core.q, core.r);
  }
  const gt = gate(g.map, loc.id);
  const a = node(g.map, gt.a);
  const b = node(g.map, gt.b);
  return Math.min(
    axialDistance(a.q, a.r, core.q, core.r),
    axialDistance(b.q, b.r, core.q, core.r),
  );
}

function adjacent(g: ImpulseState, a: ShipLocation, b: ShipLocation): boolean {
  if (a.type === 'node' && b.type === 'gate') {
    const gt = gate(g.map, b.id);
    return gt.a === a.id || gt.b === a.id;
  }
  if (a.type === 'gate' && b.type === 'node') {
    const gt = gate(g.map, a.id);
    return gt.a === b.id || gt.b === b.id;
  }
  if (a.type === 'gate' && b.type === 'gate') {
    const g1 = gate(g.map, a.id);
    const g2 = gate(g.map, b.id);
    return g1.a === g2.a || g1.a === g2.b || g1.b === g2.a || g1.b === g2.b;
  }
  return false;
}

/** 2 = same location, 1 = adjacent, 0 = elsewhere. */
function proximityScore(g: ImpulseState, ships: ShipLocation[], loc: ShipLocation): number {
  let score = 0;
  for (const s of ships) {
    if (locsEqual(s, loc)) { score = Math.max(score, 2); continue; }
    if (adjacent(g, loc, s)) score = Math.max(score, 1);
  }
  return score;
}

function shipsOf(g: ImpulseState, seat: Seat): ShipLocation[] {
  return g.ships.filter((sp) => sp.owner === seat).map((sp) => sp.loc);
}

function enemyShips(g: ImpulseState, seat: Seat): ShipLocation[] {
  return g.ships.filter((sp) => sp.owner !== seat).map((sp) => sp.loc);
}

// ---------------------------------------------------------------- context

/** Everything the scorers need, computed once per decision. */
interface Ctx {
  g: ImpulseState;
  seat: Seat;
  policy: AiPolicy;
  rng: Rng;
  /** Leader by prestige excluding self, or null. */
  leader: Seat | null;
  meTrails: boolean;
  coreGates: Set<number>;
}

// The current leader by prestige (excluding self), or null if all tied.
// Null at 5+ players: the leader rotates often enough that fixed targeting
// underperforms simple Sector Core scoring (bench showed Munchkin's win rate
// dropping from 39% at 2p to 13% at 6p when always pursuing a leader).
function leaderOf(g: ImpulseState, seat: Seat): Seat | null {
  if (g.players.length >= 5) return null;
  const others = g.players.filter((p) => p.seat !== seat);
  if (others.length === 0) return null;
  const max = Math.max(...others.map((p) => p.prestige));
  const top = others.filter((p) => p.prestige === max);
  return top.length === 1 ? top[0]!.seat : null;
}

// ---------------------------------------------------------------- card value

// State-aware card scoring. Each policy applies a base bias by action type,
// then adjusts up or down based on whether the action is actually useful right
// now — a Refine card is worthless without minerals, a Mine card without
// matching size-1 hand cards, a Sabotage without a target.
function scoreCard(ctx: Ctx, c: Card): number {
  const { g, seat, policy } = ctx;
  const me = getPlayer(g, seat);

  let base: number;
  switch (policy) {
    // Greedy: prefer immediate-prestige actions, ranked by typical
    // points-per-use. Sabotage scores low across ALL policies because
    // placement empirically loses: 0/54 placements by winning humans across
    // 60 games of telemetry. Placing Sabotage on the shared Impulse track
    // gifts the bomb action to every other player — so the placer's own
    // fleets become targets too.
    case 'greedy':
      base = ({
        Trade: 6,     // +1 per icon, easy points
        Refine: 6,    // direct prestige
        Command: 4,   // patrols core gates
        Build: 3,     // adds combat material; humans place 3/97 (3%)
        Mine: 3,      // sets up future Refine
        Execute: 3,
        Sabotage: 2,  // shared use hurts the placer
        Research: 2,
        Plan: 2,      // delayed prestige
        Draw: 1,      // weakest card type
      } as Record<string, number>)[c.actionType] ?? 1;
      break;
    case 'warrior':
      base = ({ Command: 5, Build: 3, Sabotage: 3, Trade: 2, Refine: 2 } as Record<string, number>)[c.actionType] ?? 1;
      break;
    case 'corerush':
      base = ({ Command: 7, Build: 4, Trade: 2, Refine: 2 } as Record<string, number>)[c.actionType] ?? 1;
      break;
    case 'munchkin':
      base = ({ Command: 4, Sabotage: 3, Build: 2 } as Record<string, number>)[c.actionType] ?? 1;
      break;
    // Refine baseline tuned against 92-game telemetry. An earlier table
    // massively over-picked Mine (+96 vs winning humans) and Build (+56)
    // while under-picking Command (-143); Mine/Refine remain the identity but
    // at lower weight, and Command is explicit so the policy doesn't ignore
    // the most common winning placement.
    case 'refine':
      base = ({ Refine: 6, Mine: 5, Command: 4, Trade: 3, Build: 2 } as Record<string, number>)[c.actionType] ?? 1;
      break;
  }

  // State-aware adjustments — penalise cards that won't fire usefully now.
  switch (c.actionType) {
    case 'Refine': {
      if (me.minerals.length === 0) return 1;                       // nothing to refine
      const bestMineral = Math.max(...me.minerals.map((id) => card(id).size));
      base += bestMineral - 1;                                      // per-gem cards like big minerals
      break;
    }
    case 'Mine': {
      const sizeOnes = me.hand.filter((id) => id !== 0 && card(id).size === 1).length;
      if (sizeOnes === 0) base -= 2;                                // most Mine cards filter size 1
      break;
    }
    case 'Trade':
      if (me.hand.length <= 1) base -= 2;                           // nothing to trade away
      break;
    case 'Sabotage': {
      // Placement scoring only (this runs for placeImpulse). Keep one targeted
      // bump: an anti-leader Munchkin trailing by a clear margin, when the
      // leader has a fat fleet worth bombing.
      if (enemyShips(g, seat).length === 0) return 1;
      if (policy === 'munchkin' && ctx.meTrails && ctx.leader) {
        const fleets = new Map<string, number>();
        for (const sp of g.ships) {
          if (sp.owner !== ctx.leader) continue;
          const k = `${sp.loc.type}:${sp.loc.id}`;
          fleets.set(k, (fleets.get(k) ?? 0) + 1);
        }
        const biggest = fleets.size === 0 ? 0 : Math.max(...fleets.values());
        if (biggest >= 3) base += 2;
      }
      break;
    }
    case 'Build':
      if (me.shipsAvailable <= 0) return 1;                         // no ships to place
      break;
    case 'Command':
      if (shipsOf(g, seat).length === 0) return 1;                  // nothing to move
      break;
    case 'Plan':
      // Late game (somebody near winning): prefer immediate over deferred.
      if (g.players.some((p) => p.prestige >= WIN_THRESHOLD - 4)) base -= 2;
      break;
  }
  return Math.max(1, base);
}

function scoreCardId(ctx: Ctx, id: number): number {
  return id === 0 ? 1 : scoreCard(ctx, card(id));
}

// Activation utility of a destination: a transport path ending on a face-up
// sector (other than its origin) activates that card, with the just-moved
// transports as bonus matching gems. That enables combos card-type bias alone
// misses — e.g. home → Command sector activates Command for an EXTRA fleet
// move, which can push the same transport onward to the Sector Core this turn.
function activationUtility(ctx: Ctx, origin: ShipLocation, finalLoc: ShipLocation): number {
  if (finalLoc.type !== 'node') return 0;
  if (origin.type === 'node' && origin.id === finalLoc.id) return 0;
  const nc = ctx.g.nodeCards[finalLoc.id];
  if (!nc) return 0;
  // The core is already favoured by distance scoring in the policies that
  // target it; a light bump so the others still notice it as high-EV.
  if (nc.kind === 'core') return 4;
  if (nc.kind !== 'faceUp' || nc.cardId === 0) return 0;
  // Subtract a baseline so a "meh" card doesn't sway path choice.
  return Math.max(0, scoreCard(ctx, card(nc.cardId)) - 3);
}

// Battle-likelihood score for a path: positive when it ends in a winnable
// fight, strongly negative when it forces one we'll likely lose (the defender
// wins ties, and losing costs every committed cruiser AND pays the winner).
// Magnitudes scale with player count: at 6p a loss is worse because more
// opponents bank points while you rebuild; at 2p a win pays a bigger share of
// the win condition.
function battleSafetyScore(ctx: Ctx, origin: ShipLocation, finalLoc: ShipLocation): number {
  if (origin.type !== 'gate' || finalLoc.type !== 'gate') return 0;
  const { g, seat } = ctx;
  const mine = g.ships.filter((sp) =>
    sp.owner === seat && sp.loc.type === 'gate' && sp.loc.id === origin.id).length;
  const theirs = g.ships.filter((sp) =>
    sp.owner !== seat && sp.loc.type === 'gate' && sp.loc.id === finalLoc.id).length;
  if (theirs === 0) return 0;
  const n = g.players.length;
  const winBonus = n <= 2 ? 8 : n <= 4 ? 6 : 4;
  const tiePenalty = n <= 2 ? -8 : n <= 4 ? -10 : -14;
  const routPenalty = n <= 2 ? -12 : n <= 4 ? -14 : -18;
  if (mine > theirs) return winBonus;
  if (mine === theirs) return tiePenalty;
  return routPenalty;
}

// ---------------------------------------------------------------- scorers

/** Cruisers on Sector Core gates earn +1 prestige every turn from Phase-5
 *  patrol scoring, so moving them off forfeits future income. */
function coreGateStickiness(ctx: Ctx, loc: ShipLocation): number {
  return loc.type === 'gate' && ctx.coreGates.has(loc.id) ? -10 : 0;
}

/** Best activation available one step from an origin — prefer origins that set
 *  up a combo over ones that just sit there. Single neighbour scan, stays cheap. */
function bestComboFromOrigin(ctx: Ctx, origin: ShipLocation): number {
  let best = 0;
  for (const nb of neighbors(ctx.g, origin)) {
    const u = activationUtility(ctx, origin, nb);
    if (u > best) best = u;
  }
  return best;
}

function positionalScore(ctx: Ctx, loc: ShipLocation): number {
  switch (ctx.policy) {
    case 'warrior':
      return proximityScore(ctx.g, enemyShips(ctx.g, ctx.seat), loc);
    case 'munchkin':
      return ctx.leader
        ? proximityScore(ctx.g, shipsOf(ctx.g, ctx.leader), loc)
        : -distanceToCore(ctx.g, loc);
    case 'corerush':
    case 'greedy':
      return -distanceToCore(ctx.g, loc);
    case 'refine':
      return 0; // Refine has no positional agenda; safety + combos decide
  }
}

function scoreFleetOrigin(ctx: Ctx, loc: ShipLocation): number {
  return positionalScore(ctx, loc) + coreGateStickiness(ctx, loc) + bestComboFromOrigin(ctx, loc);
}

function scorePath(ctx: Ctx, origin: ShipLocation, path: ShipLocation[]): number {
  const end = path[path.length - 1]!;
  return positionalScore(ctx, end)
    + battleSafetyScore(ctx, origin, end)
    + activationUtility(ctx, origin, end);
}

function scorePlacement(ctx: Ctx, loc: ShipLocation): number {
  if (ctx.policy === 'corerush') return -distanceToCore(ctx.g, loc);
  // Warrior prefers gates (cruisers) over nodes (transports).
  if (ctx.policy === 'warrior') return loc.type === 'gate' ? 1 : 0;
  return 0;
}

// Tech slot: sacrifice a Basic tech before overwriting a Researched card we
// already invested in; with both basic prefer Right (BasicUnique), since Basic
// Common is the universally-useful flexible default.
function scoreTechSlot(ctx: Ctx, slot: TechSlotName | null): number {
  if (slot === null) return LAST_RESORT; // the C# controller always researches
  const p = getPlayer(ctx.g, ctx.seat);
  const leftBasic = p.techLeft.type !== 'researched';
  const rightBasic = p.techRight.type !== 'researched';
  if (leftBasic && !rightBasic) return slot === 'left' ? 1 : 0;
  if (rightBasic && !leftBasic) return slot === 'right' ? 1 : 0;
  if (leftBasic && rightBasic) return slot === 'right' ? 1 : 0;
  return 0; // both researched: arbitrary
}

/** Sabotage pays per ship destroyed, capped at fleet size (no overkill), so
 *  prefer the LARGEST enemy fleet; Warrior/Munchkin tiebreak on the
 *  highest-prestige owner. */
function scoreSabotageTarget(ctx: Ctx, owner: Seat, loc: ShipLocation): number {
  const fleet = ctx.g.ships.filter((sp) => sp.owner === owner && locsEqual(sp.loc, loc)).length;
  const spite = (ctx.policy === 'warrior' || ctx.policy === 'munchkin')
    ? getPlayer(ctx.g, owner).prestige / 100   // pure tiebreak, never outweighs fleet size
    : 0;
  return fleet + spite;
}

/** Explored sector: place my BEST card when the sector is at least as close to
 *  my home as to any opponent's (I'll activate it most), otherwise my WORST to
 *  deny them the slot. Returns null when the node can't be determined. */
function exploringSectorIsMine(ctx: Ctx, prompt: string): boolean | null {
  const m = /^Exploring N(\d+):/.exec(prompt);
  if (!m) return null;
  const exploredId = Number(m[1]);
  const myHomeId = ctx.g.map.homeNodeIds[ctx.seat];
  if (myHomeId === undefined) return null;
  const explored = node(ctx.g.map, exploredId);
  const myHome = node(ctx.g.map, myHomeId);
  const myDist = axialDistance(explored.q, explored.r, myHome.q, myHome.r);
  let closestOpp = Number.MAX_SAFE_INTEGER;
  for (const opp of ctx.g.players) {
    if (opp.seat === ctx.seat) continue;
    const homeId = ctx.g.map.homeNodeIds[opp.seat];
    if (homeId === undefined) continue;
    const h = node(ctx.g.map, homeId);
    closestOpp = Math.min(closestOpp, axialDistance(explored.q, explored.r, h.q, h.r));
  }
  return myDist <= closestOpp;
}

function scoreHandCard(ctx: Ctx, prompt: string, cardId: number | null): number {
  // Battle reinforcement. DEVIATION from the C# controller (which answered
  // these at random): a bluff adds no icons, so commit the biggest card that
  // actually matches an anchor and otherwise PASS rather than burning cards.
  if (prompt.includes(BATTLE_PROMPT)) {
    if (cardId === null) return 0;
    return isValidReinforcement(ctx.g, ctx.seat, cardId) ? 10 + card(cardId).size : LAST_RESORT;
  }
  // Declining is a last resort everywhere else: the C# controller took a card
  // whenever one was legal (these prompts loop until DONE).
  if (cardId === null) return LAST_RESORT;

  // Exploration: best card when the sector is mine to reach, worst otherwise.
  const explore = prompt.startsWith(EXPLORE_PROMPT) ? exploringSectorIsMine(ctx, prompt) : null;
  if (explore !== null) {
    const v = scoreCardId(ctx, cardId);
    return explore ? v : -v;
  }
  // Home pick. DEVIATION (C# answered at random): home is by definition the
  // sector I can reach most easily, so it gets my best card — the same logic
  // the exploration heuristic above already applies.
  if (prompt.startsWith(HOME_PICK_PROMPT)) return scoreCardId(ctx, cardId);

  // Refine doesn't want to give away mineral-friendly cards (size 1s get
  // mined, bigger ones trade for more points) — prefer discarding the largest.
  if (ctx.policy === 'refine') return card(cardId).size;
  return 0; // everything else: random among legal (C# behaviour)
}

/** Sector Core colour. DEVIATION (C# chose at random, throwing away prestige):
 *  the option list is in a known colour order, so score by the gems we hold. */
function scoreOption(ctx: Ctx, prompt: string, index: number): number {
  if (!prompt.startsWith(CORE_COLOR_PROMPT)) return 0;
  const color = CORE_COLOR_DISPLAY_ORDER[index];
  if (!color) return 0;
  return getPlayer(ctx.g, ctx.seat).minerals
    .filter((id) => id !== 0 && card(id).color === color)
    .reduce((sum, id) => sum + card(id).size, 0);
}

// ---------------------------------------------------------------- dispatch

function scoreAction(ctx: Ctx, a: ImpulseAction): number {
  const req = ctx.g.effect?.pendingChoice ?? null;
  const prompt = req?.prompt ?? '';
  switch (a.kind) {
    // Phase-level actions: generally do things rather than skip.
    case 'placeImpulse': return scoreCardId(ctx, a.cardId);
    case 'useImpulseCard': return 2;
    case 'skipImpulseCard': return 0;
    case 'useTech': return 2;
    case 'skipTech': return 0;
    case 'usePlan': return 2;
    case 'skipPlan': return 0;
    case 'answer': {
      const ans = a.answer;
      switch (ans.type) {
        case 'handCard': return scoreHandCard(ctx, prompt, ans.cardId);
        case 'mineralCard':
          // Refine prefers the highest size to maximise per-gem yield.
          return ctx.policy === 'refine' ? card(ans.cardId).size : 0;
        case 'shipPlacement': return scorePlacement(ctx, ans.loc);
        case 'fleet':
          return ans.loc === null ? LAST_RESORT : scoreFleetOrigin(ctx, ans.loc);
        case 'declareMove': {
          if (req?.type !== 'declareMove') return 0;
          if (ans.pathIndex < 0) return LAST_RESORT;    // STAY
          const path = req.legalPaths[ans.pathIndex];
          return path ? scorePath(ctx, req.origin, path) : LAST_RESORT;
        }
        case 'fleetSize':
          // Warriors and core-rushers send the maximum.
          return (ctx.policy === 'warrior' || ctx.policy === 'corerush') ? ans.size : 0;
        case 'techSlot': return scoreTechSlot(ctx, ans.slot);
        case 'options': return scoreOption(ctx, prompt, ans.index);
        case 'sabotageTarget': {
          if (req?.type !== 'selectSabotageTarget') return 0;
          const t = req.legalTargets[ans.index];
          return t ? scoreSabotageTarget(ctx, t.owner, t.loc) : LAST_RESORT;
        }
        case 'cancel': return LAST_RESORT;
      }
    }
  }
}

/**
 * Pick a move for `seat` from `legal`. Scores every option and takes the best,
 * breaking ties with `rng` (so a given state + seed always plays the same).
 */
export function pickAction(
  state: ImpulseState,
  seat: Seat,
  policy: AiPolicy,
  rng: Rng,
  legal: ImpulseAction[],
): ImpulseAction {
  if (legal.length === 0) throw new Error(`ai: no legal actions for ${seat}`);
  const ctx: Ctx = {
    g: state,
    seat,
    policy,
    rng,
    leader: leaderOf(state, seat),
    meTrails: false,
    coreGates: new Set(gatesAt(state.map, state.map.sectorCoreNodeId).map((gt) => gt.id)),
  };
  ctx.meTrails = ctx.leader !== null && ctx.leader !== seat;

  let best: ImpulseAction[] = [];
  let bestScore = -Infinity;
  for (const a of legal) {
    const s = scoreAction(ctx, a);
    if (s > bestScore) { bestScore = s; best = [a]; }
    else if (s === bestScore) best.push(a);
  }
  return rng.pick(best);
}
