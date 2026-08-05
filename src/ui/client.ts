// GameClientApi over the Pages Functions API. Every fetch wrapped in
// withDeadline (framework contract: a hung request must not freeze the
// session); reports via submitReportViaHttp (never-silent contract).
import {
  submitReportViaHttp, withDeadline,
  type ChatMessage, type GameClientApi, type MessagingClientApi,
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

/** Chat transport for <ChatPanel>. The server stamps the sender's seat from
 *  the token, so a client can't post as somebody else. */
export function makeChatClient(gameId: string, token: string): MessagingClientApi {
  const base = `/api/games/${encodeURIComponent(gameId)}/chat`;
  const q = `?token=${encodeURIComponent(token)}`;
  const readJson = async (r: Response): Promise<ChatMessage[]> => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<ChatMessage[]>;
  };
  return {
    listMessages: () => withDeadline((signal) =>
      fetch(`${base}${q}`, { signal }).then(readJson), 20_000, 'Loading chat'),
    postMessage: (body) => withDeadline((signal) =>
      fetch(`${base}${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
        signal,
      }).then(readJson), 20_000, 'Sending'),
  };
}

export interface CreatedGame {
  gameId: string;
  invites: Record<string, string>;
}

/** Attach a hub identity to this seat so results can be rated. Best-effort:
 *  play works fine unattributed, so a failure here must never block the game. */
export async function claimSeat(
  gameId: string, token: string, identityToken: string,
): Promise<boolean> {
  try {
    return await withDeadline(async (signal) => {
      const r = await fetch(
        `/api/games/${encodeURIComponent(gameId)}/claim?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identityToken }),
          signal,
        },
      );
      return r.ok;
    }, 20_000, 'Linking your account');
  } catch {
    return false;
  }
}

/** `ai` maps seat → AI policy key; omitted seats are human. */
export async function createGameOnServer(
  numPlayers: number,
  ai: Record<string, string> = {},
): Promise<CreatedGame> {
  return withDeadline(async (signal) => {
    const r = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numPlayers, ...(Object.keys(ai).length > 0 ? { ai } : {}) }),
      signal,
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = ((await r.json()) as { error?: string }).error ?? msg; } catch { /* keep */ }
      throw new Error(`create failed: ${msg}`);
    }
    return r.json() as Promise<CreatedGame>;
  }, 30_000, 'Creating the game');
}
