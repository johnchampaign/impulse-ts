// One logging choke point per engine (framework log-format v2). `kind` +
// `payload` carry the data; `msg` is the UI rendering. Registry of kinds:
// docs/log-events.md (grow it as kinds are added). Always capped.
import { appendGameLog, type GameLogEntry } from 'digital-boardgame-framework';
import type { ImpulseState, Seat } from './types';

const CAP = 500;

export function log(
  g: ImpulseState,
  e: Omit<GameLogEntry<Seat>, 'seq' | 'turn' | 'phase'>,
): void {
  appendGameLog(g.log, { turn: g.turn, phase: g.phase, ...e }, CAP);
}

/** Convenience for neutral prose events. */
export function logInfo(g: ImpulseState, msg: string): void {
  log(g, { kind: 'info', msg });
}
