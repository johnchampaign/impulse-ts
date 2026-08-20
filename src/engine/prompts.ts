// Prompt text that something OTHER than the UI depends on.
//
// The AI has to tell certain same-shaped prompts apart — a "pick a hand card"
// request is a discard, a mine, a trade, an exploration placement, a home pick,
// or a battle reinforcement depending on context, and it plays each of them
// differently. The C# controller sniffed the prompt string for this; keeping the
// strings in one place makes that a compile-time dependency instead of a
// copy-paste one that silently breaks when a prompt is reworded.
//
// UI-only wording can still be edited freely — just do it here.

export const PROMPT = {
  /** Pre-game: choose which of your dealt cards goes face-up on your home. */
  homePick: (nodeId: number, count: number, defaultCardId: number): string =>
    `Pick one of your ${count} cards to place face-up on Home (N${nodeId}). ` +
    `Default was #${defaultCardId}.`,

  /** Mid-move: place a card face-up on a sector you just explored. */
  exploring: (nodeId: number): string =>
    `Exploring N${nodeId}: place a card from your hand face-up.`,

  /** Transports arriving on the Sector Core choose a mineral colour to boost. */
  sectorCoreColor: (arrivingTransports: number): string =>
    `Sector Core: choose mineral color for boost (+${arrivingTransports} arriving transports).`,

  /** Battle: commit a face-down reinforcement, or pass. */
  // `facing` is what the opposing side has already committed face-down. The
  // rulebook has the defender place cards "face-down in front of them,
  // followed by the attacker" (p.34) — so at the table the attacker can COUNT
  // the defender's commitment before choosing, even though the faces stay
  // hidden. Withholding the count would make the attacker strictly worse off
  // than in the physical game, so it goes in the prompt.
  battleReinforce: (
    who: string,
    defender: boolean,
    committed: number,
    facing: number | null,
  ): string => {
    const facingText = facing === null
      ? ''
      : facing === 0
        ? 'The defender committed NO cards face-down. '
        : `The defender committed ${facing} card${facing === 1 ? '' : 's'} face-down ` +
          '(faces hidden until reveal). ';
    const soFar = committed === 0
      ? ''
      : ` You have committed ${committed} so far.`;
    return `${BATTLE_MARK} ${defender ? 'DEFENDER' : 'ATTACKER'} ${who}: ${facingText}` +
      'Commit any card face-down as a reinforcement (bluffs return to hand on reveal), ' +
      `or PASS — placing zero cards is legal (rulebook p.34).${soFar}`;
  },
} as const;

/** Prefixes/markers consumers match on. Kept next to the builders above so a
 *  reworded prompt fails the prefix test in tests/ai.test.ts. */
export const BATTLE_MARK = '⚔';
export const PROMPT_PREFIX = {
  homePick: 'Pick one of your',
  exploring: 'Exploring N',
  sectorCoreColor: 'Sector Core: choose mineral color',
} as const;
