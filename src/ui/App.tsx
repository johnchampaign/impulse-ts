import { useMemo, useState } from 'react';
import { useGame } from 'digital-boardgame-framework/client';
import { card } from '../engine/catalog';
import {
  RACES,
  type ImpulseAction, type ImpulseState, type PlayerState, type Tech,
} from '../engine/types';
import { createGameOnServer, makeClient, type CreatedGame } from './client';
import { actionLabel, cardLabel, cardTitle } from './labels';
import { MapView } from './MapView';

declare const __BUILD__: string | undefined;
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

function params(): { game: string | null; token: string | null } {
  const u = new URLSearchParams(location.search);
  return { game: u.get('game'), token: u.get('token') };
}

export function App() {
  const { game, token } = params();
  if (game && token) return <PlayPage gameId={game} token={token} />;
  return <Lobby />;
}

// ---------- lobby ----------

function Lobby() {
  const [numPlayers, setNumPlayers] = useState(2);
  const [created, setCreated] = useState<CreatedGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createGameOnServer(numPlayers));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="lobby">
      <h1>IMPULSE</h1>
      <p className="tagline">
        Async multiplayer port of Carl Chudyk's <em>Impulse</em> (2013).
        Create a game and send each player their invite link — turns are
        asynchronous, come back whenever.
      </p>
      {!created && (
        <div className="lobby-form">
          <label>
            Players:{' '}
            <select value={numPlayers} onChange={(e) => setNumPlayers(Number(e.target.value))}>
              {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create game'}</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {created && (
        <div className="invites">
          <h2>Game created — share these links</h2>
          <p>Each link is one seat's credential. Keep yours, send the rest.</p>
          <ul>
            {Object.entries(created.invites).map(([seat, url]) => (
              <li key={seat}>
                <strong>{seat}:</strong> <a href={url}>{url}</a>{' '}
                <button onClick={() => navigator.clipboard?.writeText(url)}>copy</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer>
        <a href="https://github.com/johnchampaign/impulse-ts" rel="noreferrer">source</a> · build {BUILD}
      </footer>
    </main>
  );
}

// ---------- play ----------

function techLabel(t: Tech): string {
  if (t.type === 'basicCommon') return 'Basic: Command/Build';
  if (t.type === 'basicUnique') return `Basic: ${RACES.find((r) => r.id === t.raceId)?.name ?? '?'}`;
  return cardLabel(t.cardId);
}

function techTitle(t: Tech): string {
  if (t.type === 'basicCommon') return 'Discard a card in order to either: Command one fleet for one move OR Build one ship at home.';
  if (t.type === 'basicUnique') return RACES.find((r) => r.id === t.raceId)?.basicUniqueTechText ?? '';
  return cardTitle(t.cardId);
}

function PlayerPanel({ g, p, you }: { g: ImpulseState; p: PlayerState; you: string | null }) {
  const race = RACES.find((r) => r.id === p.raceId);
  const isActive = g.activeSeat === p.seat;
  return (
    <div className={`player ${isActive ? 'active' : ''}`}>
      <div className="player-head">
        <span className={`swatch swatch-${p.color}`} />
        <strong>{p.seat}{p.seat === you ? ' (you)' : ''}</strong>
        <span className="race">{race?.name}</span>
        <span className="prestige">★ {p.prestige}/20</span>
      </div>
      <div className="player-row">
        ships in reserve: {p.shipsAvailable} · hand: {p.hand.length} · minerals:{' '}
        {p.minerals.length === 0 ? '—' : p.minerals.map((id) => (
          <span key={id} className="chip" title={cardTitle(id)}>{cardLabel(id)}</span>
        ))}
      </div>
      <div className="player-row">
        techs:{' '}
        <span className="chip" title={techTitle(p.techLeft)}>{techLabel(p.techLeft)}</span>
        <span className="chip" title={techTitle(p.techRight)}>{techLabel(p.techRight)}</span>
        {p.plan.length > 0 && (
          <>
            {' '}· plan: {p.plan.map((id) => (
              <span key={id} className="chip" title={cardTitle(id)}>{cardLabel(id)}</span>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ReportDialog({ onClose, reportBug }: {
  onClose: () => void;
  reportBug: (msg: string, severity?: 'bug' | 'rules-question' | 'feedback') => Promise<string>;
}) {
  const [msg, setMsg] = useState('');
  const [severity, setSeverity] = useState<'bug' | 'rules-question' | 'feedback'>('bug');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [detail, setDetail] = useState('');

  const send = async () => {
    setState('sending');
    try {
      const id = await reportBug(msg, severity);
      setDetail(id);
      setState('done'); // thank-you ONLY on a real server-issued reportId
    } catch (e) {
      setDetail((e as Error).message);
      setState('error');
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Report a problem</h3>
        {state === 'done' ? (
          <>
            <p>Thank you! Your report was saved (id <code>{detail}</code>).
              Reports like this are the single most useful thing you can send.</p>
            <button onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <p>The current game state is attached automatically.</p>
            <select value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
              <option value="bug">Something is broken</option>
              <option value="rules-question">Rules question</option>
              <option value="feedback">Feedback</option>
            </select>
            <textarea
              rows={5}
              placeholder="What happened? What did you expect?"
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
            />
            {state === 'error' && <p className="error">Report NOT sent: {detail}. Please try again.</p>}
            <div className="dialog-buttons">
              <button onClick={send} disabled={state === 'sending' || msg.trim().length === 0}>
                {state === 'sending' ? 'Sending…' : 'Send report'}
              </button>
              <button onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PlayPage({ gameId, token }: { gameId: string; token: string }) {
  const client = useMemo(() => makeClient(gameId, token), [gameId, token]);
  const { view, yourTurn, gameOver, you, legalActions, submit, reportBug, loading, error, refresh } =
    useGame<ImpulseState, ImpulseAction>(client);
  const [showReport, setShowReport] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (loading && !view) return <main className="center"><p>Loading the game…</p></main>;
  if (error && !view) {
    return (
      <main className="center">
        <p className="error">Couldn't load the game: {error.message}</p>
        <button onClick={() => refresh()}>Retry</button>
      </main>
    );
  }
  if (!view) return null;
  const g = view;
  const me = g.players.find((p) => p.seat === you);
  const prompt = g.effect?.pendingChoice;
  const pendingSeat = g.pending?.seat ?? null;

  const act = async (action: ImpulseAction) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submit(action);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  // Hand-card shortcut: clicking a hand card submits the matching legal action.
  const handAction = (cardId: number): ImpulseAction | null =>
    legalActions.find((a) =>
      (a.kind === 'placeImpulse' && a.cardId === cardId) ||
      (a.kind === 'answer' && a.answer.type === 'handCard' && a.answer.cardId === cardId)) ?? null;

  return (
    <main className="play">
      <header>
        <h1>IMPULSE</h1>
        <span>turn {g.turn} · phase <strong>{g.phase}</strong> · active {g.activeSeat}</span>
        <span className={yourTurn ? 'your-turn' : ''}>
          {gameOver
            ? `Game over — ${g.winner ?? 'nobody'} wins`
            : yourTurn ? '● YOUR MOVE' : `waiting for ${pendingSeat ?? '…'}`}
        </span>
        <button className="linkish" onClick={() => setShowReport(true)}>report a problem</button>
      </header>

      <div className="columns">
        <section className="left">
          <MapView g={g} />
          <div className="impulse">
            <h3>Impulse track (top → bottom)</h3>
            {g.impulse.length === 0 ? <p>empty</p> : (
              <ol>
                {g.impulse.map((id, i) => (
                  <li key={`${id}-${i}`}
                    className={g.phase === 'resolveImpulse' && i === g.impulseCursor ? 'cursor' : ''}>
                    <span className="chip" title={cardTitle(id)}>{cardLabel(id)}</span>
                    {id !== 0 && <span className="etext"> {card(id).effectText}</span>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>

        <section className="right">
          {g.players.map((p) => <PlayerPanel key={p.seat} g={g} p={p} you={you} />)}

          {me && (
            <div className="hand">
              <h3>Your hand</h3>
              <div className="hand-cards">
                {me.hand.map((id, i) => {
                  const shortcut = handAction(id);
                  return (
                    <button key={`${id}-${i}`} className="card-btn" disabled={!shortcut || submitting}
                      title={cardTitle(id)} onClick={() => shortcut && act(shortcut)}>
                      <div className={`band band-${id === 0 ? 'hidden' : card(id).color}`} />
                      <div>{cardLabel(id)}</div>
                      {id !== 0 && <div className="etext">{card(id).effectText}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="prompt">
            <h3>{gameOver ? 'Result' : yourTurn ? 'Your decision' : 'Waiting'}</h3>
            {gameOver && (
              <p>
                Final prestige:{' '}
                {[...g.players].sort((a, b) => b.prestige - a.prestige)
                  .map((p) => `${p.seat} ${p.prestige}`).join(' · ')}
              </p>
            )}
            {!gameOver && prompt && pendingSeat === you && <p className="prompt-text">{prompt.prompt}</p>}
            {!gameOver && prompt && pendingSeat !== you && (
              <p className="prompt-text">{pendingSeat} is choosing…</p>
            )}
            {!gameOver && yourTurn && (
              <div className="actions">
                {legalActions.map((a, i) => (
                  <button key={i} disabled={submitting} onClick={() => act(a)}>
                    {actionLabel(g, a)}
                  </button>
                ))}
              </div>
            )}
            {submitError && <p className="error">{submitError}</p>}
          </div>

          <div className="log">
            <h3>Log</h3>
            <ul>
              {g.log.slice(-25).reverse().map((e) => (
                <li key={e.seq}><span className="seq">{e.turn}</span> {e.msg ?? e.kind}</li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {showReport && <ReportDialog onClose={() => setShowReport(false)} reportBug={reportBug} />}
      <footer>game {gameId} · you are {you ?? '…'} · build {BUILD}</footer>
    </main>
  );
}
