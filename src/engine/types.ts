// Domain types ported from Impulse.Core (C#). State is plain JSON-able data —
// no classes, no Date, no functions — so it snapshots and round-trips through
// the digital-boardgame-framework unchanged.
import type { GameLogEntry } from 'digital-boardgame-framework';

// ---------- seats ----------

/** Seat id: 'P1'..'P6'. String because the framework keys players by string. */
export type Seat = string;

export function seatOf(index1: number): Seat {
  return `P${index1}`;
}

// ---------- cards ----------

export type CardActionType =
  | 'Command' | 'Build' | 'Plan' | 'Research' | 'Mine'
  | 'Refine' | 'Trade' | 'Sabotage' | 'Draw' | 'Execute';

export type CardColor = 'Blue' | 'Yellow' | 'Red' | 'Green';

export interface Card {
  id: number;
  actionType: CardActionType;
  color: CardColor;
  size: number;         // 1..3, the white-box matching number
  boostNumber: number;
  effectFamily: string; // registry key; many cards share one family
  effectText: string;   // verbatim rulebook text (UI only, never parsed)
}

// ---------- races & techs ----------

export type PlayerColor = 'Blue' | 'Green' | 'Purple' | 'Red' | 'White' | 'Yellow';

export interface Race {
  id: number;
  name: string;
  color: PlayerColor;
  basicUniqueTechSlug: string;
  basicUniqueTechText: string;
}

// Names and tech texts confirmed against raza1-6.jpg (Vassal art) + rulebook.
export const RACES: readonly Race[] = [
  { id: 1, name: 'Piscesish', color: 'Blue', basicUniqueTechSlug: 'tech_basic_unique_piscesish',
    basicUniqueTechText: 'Draw one size one card from the deck.' },
  { id: 2, name: 'Ariek', color: 'Green', basicUniqueTechSlug: 'tech_basic_unique_ariek',
    basicUniqueTechText: 'Command one fleet for one move. It must end the move occupying or patrolling the Sector Core.' },
  { id: 3, name: 'Herculese', color: 'Purple', basicUniqueTechSlug: 'tech_basic_unique_herculese',
    basicUniqueTechText: 'Command one Cruiser for one move through an unexplored card.' },
  { id: 4, name: 'Draconians', color: 'Red', basicUniqueTechSlug: 'tech_basic_unique_draconians',
    basicUniqueTechText: 'Research one card from your hand. It must match color and size with the last card on the Impulse.' },
  { id: 5, name: 'Triangulumnists', color: 'White', basicUniqueTechSlug: 'tech_basic_unique_triangulumnists',
    basicUniqueTechText: 'Build a Cruiser at home on an edge that touches an unexplored card.' },
  { id: 6, name: 'Caelumnites', color: 'Yellow', basicUniqueTechSlug: 'tech_basic_unique_caelumnites',
    basicUniqueTechText: 'Mine one card from your hand. It must match color and size with the last card on the Impulse.' },
];

export const BASIC_COMMON_TECH_TEXT =
  // Impulserules p.20
  'Discard a card in order to either: Command one fleet for one move OR Build one ship at home.';

export type TechSlotName = 'left' | 'right';

export type Tech =
  | { type: 'basicCommon' }
  | { type: 'basicUnique'; raceId: number }
  | { type: 'researched'; cardId: number };

// ---------- map ----------

export interface MapNode {
  id: number;
  q: number;            // hex axial coordinates, layout only
  r: number;
  isHome: boolean;
  owner: Seat | null;   // only set if isHome
  isSectorCore: boolean;
}

export interface MapGate {
  id: number;
  a: number;            // endpoint node ids
  b: number;
}

export interface SectorMapData {
  nodes: MapNode[];
  gates: MapGate[];
  sectorCoreNodeId: number;
  homeNodeIds: Record<Seat, number>;
}

export type ShipLocation =
  | { type: 'node'; id: number }
  | { type: 'gate'; id: number };

export interface ShipPlacement {
  owner: Seat;
  loc: ShipLocation;
}

// Per-node card state. Sector Core has no underlying card; home corners are
// face-up at setup; everything else starts face-down with a deck card.
export type NodeCard =
  | { kind: 'core' }
  | { kind: 'faceDown'; cardId: number }
  | { kind: 'faceUp'; cardId: number };

// ---------- choices (the pause/resume protocol) ----------

// Mid-effect input requests. A handler creates the request and pauses; the
// answer arrives as an ImpulseAction of kind 'answer' and is attached to
// `answer` before the handler is re-entered (mirrors the C# `Chosen` fields).
// `seat` is who answers — usually the activating player, but e.g. battle
// defender-reinforcement prompts target the defender.

export interface SelectHandCardRequest {
  type: 'selectHandCard';
  seat: Seat;
  prompt: string;
  legalCardIds: number[];
  allowNone: boolean;
  noneLabel: string;
  answer?: { cardId: number | null };
}

export interface SelectMineralCardRequest {
  type: 'selectMineralCard';
  seat: Seat;
  prompt: string;
  legalCardIds: number[];
  answer?: { cardId: number };
}

export interface SelectShipPlacementRequest {
  type: 'selectShipPlacement';
  seat: Seat;
  prompt: string;
  legalLocations: ShipLocation[];
  answer?: { loc: ShipLocation };
}

export interface SelectFleetRequest {
  type: 'selectFleet';
  seat: Seat;
  prompt: string;
  legalLocations: ShipLocation[];
  allowSkip: boolean;
  answer?: { loc: ShipLocation | null };
}

export interface DeclareMoveRequest {
  type: 'declareMove';
  seat: Seat;
  prompt: string;
  origin: ShipLocation;
  maxMoves: number;
  legalPaths: ShipLocation[][];
  // When true, pathIndex -1 means "stay" (no movement) — the C# empty-path
  // convention from the WPF STAY button.
  allowStay: boolean;
  answer?: { pathIndex: number };
}

export interface SelectFleetSizeRequest {
  type: 'selectFleetSize';
  seat: Seat;
  prompt: string;
  min: number;
  max: number;
  answer?: { size: number };
}

export interface SelectTechSlotRequest {
  type: 'selectTechSlot';
  seat: Seat;
  prompt: string;
  incomingCardId: number | null;
  allowSkip: boolean;
  answer?: { slot: TechSlotName | null };
}

export interface SelectFromOptionsRequest {
  type: 'selectFromOptions';
  seat: Seat;
  prompt: string;
  options: string[];
  answer?: { index: number };
}

export interface SabotageTarget {
  owner: Seat;
  loc: ShipLocation;
}

export interface SelectSabotageTargetRequest {
  type: 'selectSabotageTarget';
  seat: Seat;
  prompt: string;
  legalTargets: SabotageTarget[];
  answer?: { index: number };
}

export type ChoiceRequest =
  | SelectHandCardRequest
  | SelectMineralCardRequest
  | SelectShipPlacementRequest
  | SelectFleetRequest
  | DeclareMoveRequest
  | SelectFleetSizeRequest
  | SelectTechSlotRequest
  | SelectFromOptionsRequest
  | SelectSabotageTargetRequest;

// ---------- effects ----------

export type EffectSource =
  | { type: 'impulseCard'; cardId: number }
  | { type: 'planCard'; cardId: number }
  | { type: 'tech'; slot: TechSlotName; cardId: number | null }
  | { type: 'mapActivation'; nodeId: number; cardId: number }
  | { type: 'setup' }; // pre-game home pick

// Transient per-effect-invocation state (C# EffectContext), held on
// GameState.effect while an effect is in flight. handlerState is a plain JSON
// scratchpad — each handler documents its own shape.
export interface EffectCtx {
  seat: Seat;
  source: EffectSource;
  pendingChoice: ChoiceRequest | null;
  handlerState: unknown;
  isComplete: boolean;
  transportBonusGems: number;
  activationDepth: number;
  // Set while awaiting the attacker's choice of defender among multiple
  // eligible enemies (rulebook p.29); consumed on resume. See battle.ts.
  pendingDefenderCandidates: Seat[] | null;
}

// ---------- actions ----------

export type ChoiceAnswer =
  | { type: 'handCard'; cardId: number | null }
  | { type: 'mineralCard'; cardId: number }
  | { type: 'shipPlacement'; loc: ShipLocation }
  | { type: 'fleet'; loc: ShipLocation | null }
  | { type: 'declareMove'; pathIndex: number }
  | { type: 'fleetSize'; size: number }
  | { type: 'techSlot'; slot: TechSlotName | null }
  | { type: 'options'; index: number }
  | { type: 'sabotageTarget'; index: number }
  | { type: 'cancel' };

export type ImpulseAction =
  | { kind: 'placeImpulse'; cardId: number }
  | { kind: 'useTech'; slot: TechSlotName }
  | { kind: 'skipTech' }
  | { kind: 'useImpulseCard' }
  | { kind: 'skipImpulseCard' }
  | { kind: 'usePlan' }
  | { kind: 'skipPlan' }
  | { kind: 'answer'; answer: ChoiceAnswer };

// ---------- game state ----------

export type GamePhase =
  | 'homePick'        // pre-game: each seat picks its face-up home card
  | 'addImpulse'      // 1
  | 'useTech'         // 2
  | 'resolveImpulse'  // 3
  | 'usePlan'         // 4
  | 'score'           // 5 (automatic)
  | 'cleanup'         // 6 (automatic)
  | 'gameOver';

export interface PlayerState {
  seat: Seat;
  raceId: number;
  color: PlayerColor;
  hand: number[];
  plan: number[];
  nextPlan: number[] | null;
  minerals: number[];
  techLeft: Tech;
  techRight: Tech;
  shipsAvailable: number; // off-map reserve, starts at 12
  prestige: number;
}

// What input the engine is waiting on. 'action' = a phase-level PlayerAction
// from `seat`; 'choice' = the answer to state.effect.pendingChoice.
export type Pending =
  | { type: 'action'; seat: Seat }
  | { type: 'choice'; seat: Seat };

export interface ImpulseState {
  schemaVersion: number;
  seed: number;
  playerCount: number;
  rngState: number;             // framework Rng, serialized

  map: SectorMapData;
  players: PlayerState[];

  deck: number[];
  discard: number[];
  impulse: number[];            // shared FIFO track; [0] = oldest = top
  impulseCursor: number;

  ships: ShipPlacement[];
  nodeCards: Record<number, NodeCard>;

  turn: number;
  activeSeat: Seat;
  phase: GamePhase;
  isGameOver: boolean;
  winner: Seat | null;

  homePickIndex: number;        // next player index doing the setup home pick
  isResolvingPlan: boolean;
  currentlyResolvingPlanCardId: number | null;
  // Phase 4 sub-position: 'decide' = use/skip the whole plan not yet answered;
  // 'card' = per-card use/skip pending for currentlyResolvingPlanCardId.
  planWalk: 'decide' | 'card' | null;

  pending: Pending | null;
  effect: EffectCtx | null;

  log: GameLogEntry<Seat>[];
}

export function getPlayer(g: ImpulseState, seat: Seat): PlayerState {
  const p = g.players.find((p) => p.seat === seat);
  if (!p) throw new Error(`no player ${seat}`);
  return p;
}

export function techInSlot(p: PlayerState, slot: TechSlotName): Tech {
  return slot === 'left' ? p.techLeft : p.techRight;
}
