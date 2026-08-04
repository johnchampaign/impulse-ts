// GameClientApi over the Pages Functions API. Every fetch wrapped in
// withDeadline (framework contract: a hung request must not freeze the
// session); reports via submitReportViaHttp (never-silent contract).
import {
  submitReportViaHttp, withDeadline, type GameClientApi,
} from 'digital-boardgame-framework/client';
import type { ImpulseAction, ImpulseState } from '../engine/types';

export function makeClient(gameId: string, token: string): GameClientApi<ImpulseState, ImpulseAction> {
  const base = `/api/games/${encodeURIComponent(gameId)}`;
  const q = `?token=${encodeURIComponent(token)}`;
  const readJson = async (r: Response) => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = ((await r.json()) as { error?: string }).error ?? msg; } catch { /* keep */ }
      throw new Error(msg);
    }
    return r.json();
  };
  return {
    fetch: () => withDeadline((signal) =>
      fetch(`${base}${q}`, { signal }).then(readJson), 20_000, 'Loading the game'),
    submit: (action) => withDeadline((signal) =>
      fetch(`${base}/submit${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal,
      }).then(readJson), 60_000, 'Your move'),
    legalActions: () => withDeadline((signal) =>
      fetch(`${base}/legal${q}`, { signal }).then(readJson), 20_000, 'Loading moves'),
    report: (body) => submitReportViaHttp(`${base}/report${q}`, body),
  };
}

export interface CreatedGame {
  gameId: string;
  invites: Record<string, string>;
}

export async function createGameOnServer(numPlayers: number): Promise<CreatedGame> {
  return withDeadline(async (signal) => {
    const r = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numPlayers }),
      signal,
    });
    if (!r.ok) throw new Error(`create failed: HTTP ${r.status}`);
    return r.json() as Promise<CreatedGame>;
  }, 30_000, 'Creating the game');
}
