// Game setup. Ported from C# SetupFactory. The deck is restricted to card
// families with a registered handler (the allowlist pattern) so the game is
// strictly smaller while families are still being ported — never broken.
import { Rng } from 'digital-boardgame-framework';
import { CARDS } from './catalog';
import type { EffectRegistry } from './effects';
import { buildMap, gatesAt, node, otherEndpoint } from './map';
import { log } from './log';
import {
  RACES, seatOf,
  type ImpulseState, type NodeCard, type PlayerState, type Seat,
} from './types';

export const SCHEMA_VERSION = 1;

export interface SetupOptions {
  playerCount: number;
  seed: number;
  initialHandSize?: number;
  // Rulebook p.4: 2 transports on the home card, 1 cruiser on the gate
  // facing the Sector Core.
  initialTransportsAtHome?: number;
  initialCruisersAtHomeGate?: number;
  allNodesFaceUp?: boolean; // tests only
}

export function newGame(opts: SetupOptions, registry: EffectRegistry): ImpulseState {
  const {
    playerCount, seed,
    initialHandSize = 5,
    initialTransportsAtHome = 2,
    initialCruisersAtHomeGate = 1,
    allNodesFaceUp = false,
  } = opts;
  if (playerCount < 2 || playerCount > 6) throw new Error(`playerCount ${playerCount} out of range 2..6`);

  const rng = new Rng(seed);
  const seats: Seat[] = Array.from({ length: playerCount }, (_, i) => seatOf(i + 1));
  const map = buildMap(seats);

  const deckCards = CARDS.filter((c) => registry.isRegistered(c.effectFamily));
  const deck = rng.shuffle(deckCards.map((c) => c.id));

  // Shuffle the 6-race pool so seat→race is random but deterministic.
  const racePool = rng.shuffle(RACES);
  const players: PlayerState[] = seats.map((seat, i) => {
    const race = racePool[i]!;
    return {
      seat,
      raceId: race.id,
      color: race.color,
      hand: [],
      plan: [],
      nextPlan: null,
      minerals: [],
      techLeft: { type: 'basicCommon' },
      techRight: { type: 'basicUnique', raceId: race.id },
      shipsAvailable: 12,
      prestige: 0,
    };
  });

  const g: ImpulseState = {
    schemaVersion: SCHEMA_VERSION,
    seed,
    playerCount,
    rngState: 0, // set below, after all setup randomness
    map,
    players,
    deck,
    discard: [],
    impulse: [],
    impulseCursor: 0,
    ships: [],
    nodeCards: {},
    turn: 1,
    activeSeat: seats[0]!,
    phase: 'homePick',
    isGameOver: false,
    winner: null,
    homePickIndex: 0,
    isResolvingPlan: false,
    currentlyResolvingPlanCardId: null,
    planWalk: null,
    pending: null,
    effect: null,
    log: [],
  };

  // Deal initial hands.
  for (const p of players) {
    for (let i = 0; i < initialHandSize && g.deck.length > 0; i++) {
      p.hand.push(g.deck.shift()!);
    }
  }

  // Per-node card state: Sector Core special, homes face-up, rest face-down.
  for (const n of map.nodes) {
    if (n.isSectorCore) {
      g.nodeCards[n.id] = { kind: 'core' };
      continue;
    }
    if (g.deck.length === 0) continue;
    const cardId = g.deck.shift()!;
    const nc: NodeCard = n.isHome || allNodesFaceUp
      ? { kind: 'faceUp', cardId }
      : { kind: 'faceDown', cardId };
    g.nodeCards[n.id] = nc;
  }

  // Initial ships per rulebook p.4. The starting cruiser goes on the home
  // gate whose other endpoint sits closest (axial distance) to the core.
  const core = node(map, map.sectorCoreNodeId);
  for (const p of players) {
    const home = map.homeNodeIds[p.seat]!;
    for (let i = 0; i < initialTransportsAtHome; i++) {
      g.ships.push({ owner: p.seat, loc: { type: 'node', id: home } });
      p.shipsAvailable--;
    }
    const coreFacing = gatesAt(map, home)
      .map((gt) => {
        const other = node(map, otherEndpoint(gt, home));
        const dq = other.q - core.q;
        const dr = other.r - core.r;
        const dist = (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
        return { gt, dist };
      })
      .sort((x, y) => x.dist - y.dist)
      .map((t) => t.gt);
    for (let i = 0; i < initialCruisersAtHomeGate && i < coreFacing.length; i++) {
      g.ships.push({ owner: p.seat, loc: { type: 'gate', id: coreFacing[i]!.id } });
      p.shipsAvailable--;
    }
  }

  g.rngState = rng.serialize();
  log(g, {
    kind: 'game.start',
    payload: { playerCount, seed, deck: g.deck.length },
    msg: `=== game start: ${playerCount} players, seed ${seed}, deck ${g.deck.length} ===`,
  });
  return g;
}
