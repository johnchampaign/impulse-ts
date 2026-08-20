// Battle prompts are the one place the engine asks a NON-active player to
// decide (the defender reinforces first, p.34). That crosses the driver, the
// adapter's redaction, and the UI's label layer at once — and it's rare enough
// under random play that a live game may not hit it for hundreds of moves. So
// drive it deterministically here, all the way through the real code paths the
// deployed server uses.
import { describe, expect, it } from 'vitest';
import { CARDS, card } from '../src/engine/catalog';
import { impulseAdapter } from '../src/adapter/impulseAdapter';
import { advance, applyAction, legalActions } from '../src/engine/driver';
import { buildRegistry } from '../src/engine/handlers';
import { gatesAt } from '../src/engine/map';
import { newGame } from '../src/engine/setup';
import { getPlayer, type ImpulseAction, type ImpulseState } from '../src/engine/types';
import { actionLabel } from '../src/ui/labels';

const registry = buildRegistry();

// A cruiser-vs-cruiser attack staged on two gates that share the Sector Core:
// P1 attacks from g0 onto g1 where P2 patrols. Returns the state paused at the
// battle's first prompt.
function stagedBattle(): { g: ImpulseState; attackerCard: number } {
  const g = newGame({ playerCount: 2, seed: 4242 }, registry);
  advance(g, registry);
  while (g.phase === 'homePick') {
    const seat = g.pending!.seat;
    applyAction(g, registry, legalActions(g, registry, seat)[0]!, seat);
  }

  const coreGates = gatesAt(g.map, g.map.sectorCoreNodeId).map((gt) => gt.id);
  const [g0, g1] = coreGates as [number, number];

  // c38 "Command one Cruiser for [1] move." — cruiserOnly, one move, so the
  // fleet-size prompt is skipped and the flow is fleet → path → battle.
  const attackerCard = 38;
  const anchor = card(attackerCard); // Yellow/1 — the reinforcement anchor

  g.ships = [
    { owner: 'P1', loc: { type: 'gate', id: g0 } },
    { owner: 'P2', loc: { type: 'gate', id: g1 } },
  ];
  for (const p of g.players) p.shipsAvailable = 11;

  // Both players hold one card matching the impulse anchor (a legal
  // reinforcement) plus one that doesn't (a legal bluff).
  const match = CARDS.find((c) => c.color === anchor.color && c.size === anchor.size && c.id !== attackerCard)!;
  const mismatch = CARDS.find((c) => c.color !== anchor.color && c.size === 3)!;
  getPlayer(g, 'P1').hand = [match.id, mismatch.id];
  getPlayer(g, 'P2').hand = [match.id, mismatch.id];

  g.impulse = [attackerCard];
  g.impulseCursor = 0;
  g.phase = 'resolveImpulse';
  g.activeSeat = 'P1';
  g.pending = { type: 'action', seat: 'P1' };

  // P1 uses the command card, picks its cruiser, and declares the step onto
  // P2's gate — which starts the battle.
  applyAction(g, registry, { kind: 'useImpulseCard' }, 'P1');
  const fleet = legalActions(g, registry, 'P1').find(
    (a) => a.kind === 'answer' && a.answer.type === 'fleet' && a.answer.loc?.id === g0,
  )!;
  applyAction(g, registry, fleet, 'P1');

  const req = g.effect!.pendingChoice!;
  expect(req.type).toBe('declareMove');
  const attack = legalActions(g, registry, 'P1').find((a) => {
    if (a.kind !== 'answer' || a.answer.type !== 'declareMove') return false;
    if (req.type !== 'declareMove' || a.answer.pathIndex < 0) return false;
    const path = req.legalPaths[a.answer.pathIndex]!;
    const end = path[path.length - 1]!;
    return end.type === 'gate' && end.id === g1;
  })!;
  expect(attack, 'a step onto the enemy-held gate must be offered').toBeTruthy();
  applyAction(g, registry, attack, 'P1');

  return { g, attackerCard };
}

describe('battle reinforcement prompt (cross-seat)', () => {
  it('asks the DEFENDER first even though the attacker is the active player', () => {
    const { g } = stagedBattle();
    expect(g.isGameOver).toBe(false);
    const req = g.effect!.pendingChoice!;
    expect(req.type).toBe('selectHandCard');
    expect(req.prompt).toContain('DEFENDER');
    // The defender answers while P1 remains the active player — the case the
    // driver's `pending.seat` (not activeSeat) exists for.
    expect(g.activeSeat).toBe('P1');
    expect(req.seat).toBe('P2');
    expect(g.pending).toEqual({ type: 'choice', seat: 'P2' });
    // The framework asks "whose turn is it" via currentActor — it must name
    // the defender, or the deployed server would reject their answer.
    expect(impulseAdapter.currentActor(g)).toBe('P2');
  });

  it('offers the defender their whole hand (bluffs are legal) plus PASS, and the UI labels each', () => {
    const { g } = stagedBattle();
    const acts = legalActions(g, registry, 'P2');
    const hand = getPlayer(g, 'P2').hand;
    const offered = acts.flatMap((a) =>
      a.kind === 'answer' && a.answer.type === 'handCard' && a.answer.cardId !== null
        ? [a.answer.cardId] : []);
    expect(new Set(offered)).toEqual(new Set(hand)); // p.34: any card may be committed
    const pass = acts.find((a) => a.kind === 'answer' && a.answer.type === 'handCard' && a.answer.cardId === null);
    expect(pass, 'placing zero cards is legal').toBeTruthy();
    expect(actionLabel(g, pass!)).toBe('PASS — no reinforcement');
    for (const a of acts) expect(actionLabel(g, a)).toMatch(/\S/);
    // The attacker must not be offered anything while the defender decides.
    expect(legalActions(g, registry, 'P1')).toEqual([]);
  });

  it('never leaks a committed reinforcement to the opponent', () => {
    const { g } = stagedBattle();
    const defenderCard = getPlayer(g, 'P2').hand[0]!;
    const commit: ImpulseAction = { kind: 'answer', answer: { type: 'handCard', cardId: defenderCard } };
    applyAction(g, registry, commit, 'P2');

    // The face-down commit lives in handler state and a `secret` log entry.
    const attackerView = impulseAdapter.viewFor(g, 'P1');
    expect(attackerView.effect?.handlerState).toBeNull();
    const leaked = JSON.stringify(attackerView.log).includes(`#${defenderCard}`);
    expect(leaked, 'defender reinforcement must stay hidden from the attacker').toBe(false);
    // The defender still sees their own commit (they need it to play).
    expect(JSON.stringify(impulseAdapter.viewFor(g, 'P2').log)).toContain(`#${defenderCard}`);
    // Spectators see neither.
    expect(JSON.stringify(impulseAdapter.viewFor(g, null).log)).not.toContain(`#${defenderCard}`);
  });

  // Rulebook p.34: "The defending player places any number of cards face-down
  // in front of them, followed by the attacker." At the table the attacker can
  // COUNT that commitment before choosing — that is the whole point of the
  // defender going first. Reported by a player who could not find it anywhere.
  it('tells the attacker how many cards the defender committed, without revealing them', () => {
    const { g } = stagedBattle();
    const [first, second] = getPlayer(g, 'P2').hand as [number, number];
    // Defender commits both cards; the empty hand closes their commitment.
    applyAction(g, registry, { kind: 'answer', answer: { type: 'handCard', cardId: first } }, 'P2');
    applyAction(g, registry, { kind: 'answer', answer: { type: 'handCard', cardId: second } }, 'P2');

    const req = g.effect!.pendingChoice!;
    expect(req.type).toBe('selectHandCard');
    expect(req.seat).toBe('P1');
    expect(req.prompt).toContain('ATTACKER');
    expect(req.prompt).toContain('committed 2 cards face-down');

    const attackerLog = JSON.stringify(impulseAdapter.viewFor(g, 'P1').log);
    expect(attackerLog).toContain('P2 commits 2 cards face-down');
    // The count is public; the faces are still not.
    expect(attackerLog).not.toMatch(new RegExp(`#${first}\\b`));
    expect(attackerLog).not.toMatch(new RegExp(`#${second}\\b`));
    // Spectators see the count too — it is public information at the table.
    expect(JSON.stringify(impulseAdapter.viewFor(g, null).log))
      .toContain('P2 commits 2 cards face-down');
  });

  it('tells the attacker when the defender committed nothing, and keeps the defender blind', () => {
    const { g } = stagedBattle();
    // The defender decides with no knowledge of the attacker (who goes second).
    expect(g.effect!.pendingChoice!.prompt).not.toContain('committed');

    applyAction(g, registry, { kind: 'answer', answer: { type: 'handCard', cardId: null } }, 'P2');
    const req = g.effect!.pendingChoice!;
    expect(req.seat).toBe('P1');
    expect(req.prompt).toContain('committed NO cards face-down');
    expect(JSON.stringify(impulseAdapter.viewFor(g, 'P1').log))
      .toContain('P2 commits no cards face-down');
  });

  it('resolves to a winner, destroys the losing fleet, and awards prestige', () => {
    const { g } = stagedBattle();
    let guard = 0;
    while (g.effect && !g.isGameOver && guard++ < 40) {
      const seat = g.pending!.seat;
      const acts = legalActions(g, registry, seat);
      if (acts.length === 0) break;
      // Both sides PASS on reinforcements when offered, so cruiser draws decide.
      const pass = acts.find((a) => a.kind === 'answer' && a.answer.type === 'handCard' && a.answer.cardId === null);
      applyAction(g, registry, pass ?? acts[0]!, seat);
    }
    const done = g.log.filter((e) => e.kind === 'battle.result');
    expect(done).toHaveLength(1);
    const payload = done[0]!.payload as { winner: string; destroyedCount: number };
    // Exactly one cruiser fleet survives on the contested gates.
    const survivors = g.ships.length;
    expect(survivors).toBe(1);
    expect(payload.destroyedCount).toBeGreaterThan(0);
    expect(getPlayer(g, payload.winner).prestige).toBeGreaterThan(0);
    // Ship conservation across the destruction.
    for (const p of g.players) {
      const onMap = g.ships.filter((s) => s.owner === p.seat).length;
      expect(p.shipsAvailable + onMap).toBe(12);
    }
  });
});
