import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Leaderboard, RankedStatus, SignInBar, useGame, useIdentity, VmodSetupDialog,
} from 'digital-boardgame-framework/client';
import { card } from '../engine/catalog';
import {
  RACES,
  type ImpulseAction, type ImpulseState, type PlayerState, type Tech,
} from '../engine/types';
import { AI_POLICY_LABELS } from '../ai/controllers';
import { ArtProvider, MODULE_NAME, MODULE_URL, useArt } from './assets';
import { CardChip, CardFace, RaceBadge } from './CardView';
import { claimSeat, createGameOnServer, makeClient, type CreatedGame } from './client';
import { actionLabel, cardLabel, cardTitle } from './labels';
import { MapView } from './MapView';

declare const __BUILD__: string | undefined;
const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';

// Hub slug for ratings; must match `ratings.game` in functions/api/[[path]].ts
// (and the ai:impulse:<policy> identities the server gives AI seats).
const RATINGS_GAME = 'impulse';
const LEADERBOARD_HREF =
  `https://games-hub-5vo.pages.dev/leaderboard.html?game=${RATINGS_GAME}`;

function params(): { game: string | null; token: string | null } {
  const u = new URLSearchParams(location.search);
  return { game: u.get('game'), token: u.get('token') };
}

export function App() {
  const { game, token } = params();
  return (
    <ArtProvider>
      {game && token ? <PlayPage gameId={game} token={token} /> : <Lobby />}
    </ArtProvider>
  );
}

/** Header control + setup dialog for the two presentation modes. */
function ArtControls() {
  const art = useArt();
  const [dismissed, setDismissed] = useState(false);
  const showDialog = art.needsSetup && !dismissed;

  const label = art.useArt
    ? 'card art: VASSAL'
    : art.prefersArt ? 'card art: not loaded' : 'card art: off (text UI)';

  return (
    <>
      <button
        className="linkish"
        title={
          art.useArt
            ? 'Switch to the built-in text UI'
            : 'Use card images from your own copy of the Impulse VASSAL module'
        }
        onClick={() => {
          if (art.useArt) {
            art.setPrefersArt(false);           // → text UI
          } else {
            art.setPrefersArt(true);            // → art (re-opens setup if needed)
            setDismissed(false);
          }
        }}
      >
        {label}
      </button>
      {art.vmod.loading && (
        <span className="art-progress">
          unpacking module… {Math.round(art.vmod.progress * 100)}%
        </span>
      )}
      {art.vmod.error && <span className="error">art: {art.vmod.error}</span>}
      {showDialog && (
        <VmodSetupDialog
          api={art.vmod}
          gameName="Impulse"
          moduleName={MODULE_NAME}
          moduleUrl={MODULE_URL}
          skipLabel="Play with the built-in text UI"
          onSkip={() => { setDismissed(true); art.setPrefersArt(false); }}
        />
      )}
    </>
  );
}

// ---------- lobby ----------

function Lobby() {
  const { identity } = useIdentity();
  const [numPlayers, setNumPlayers] = useState(2);
  // seat → AI policy key, or 'human'. Seat 1 is always the creator.
  const [seatKinds, setSeatKinds] = useState<Record<string, string>>({ P2: 'greedy' });
  const [created, setCreated] = useState<CreatedGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seats = Array.from({ length: numPlayers }, (_, i) => `P${i + 1}`);
  const aiSeats = Object.fromEntries(
    seats.slice(1)
      .filter((s) => (seatKinds[s] ?? 'human') !== 'human')
      .map((s) => [s, seatKinds[s]!]),
  );
  const humanCount = numPlayers - Object.keys(aiSeats).length;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createGameOnServer(numPlayers, aiSeats));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="lobby">
      <h1>IMPULSE</h1>
      <SignInBar
        leaderboardHref={LEADERBOARD_HREF}
        signedInNote="— your ranked results count on the leaderboard."
      />
      <p className="tagline">
        Async multiplayer port of Carl Chudyk's <em>Impulse</em> (2013).
        Create a game and send each player their invite link — turns are
        asynchronous, come back whenever.
      </p>
      {!created && (
        <>
          <div className="lobby-form">
            <label>
              Players:{' '}
              <select value={numPlayers} onChange={(e) => setNumPlayers(Number(e.target.value))}>
                {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create game'}</button>
          </div>
          <div className="seat-setup">
            <h2>Seats</h2>
            <p>
              Seat P1 is you. Set any other seat to an AI opponent, or leave it human
              and send that player their invite link.
            </p>
            <ul>
              {seats.map((seat, i) => (
                <li key={seat}>
                  <strong>{seat}</strong>{i === 0 ? ' — you' : (
                    <>
                      {' '}
                      <select
                        value={seatKinds[seat] ?? 'human'}
                        onChange={(e) => setSeatKinds({ ...seatKinds, [seat]: e.target.value })}
                      >
                        <option value="human">Human (invite link)</option>
                        {Object.entries(AI_POLICY_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>🤖 {label}</option>
                        ))}
                      </select>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {humanCount < 1 && <p className="error">At least one seat must be human.</p>}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {created && (
        <div className="invites">
          <h2>Game created</h2>
          <p>
            Open your own link to play. Send a link to each other human;
            AI seats are already being played by the server.
          </p>
          <ul>
            {Object.entries(created.invites).map(([seat, url], i) => {
              const policy = aiSeats[seat];
              if (policy) {
                return (
                  <li key={seat}>
                    <strong>{seat}:</strong>{' '}
                    <span className="ai-tag">🤖 {policy} — played by the server</span>
                  </li>
                );
              }
              return (
                <li key={seat}>
                  <strong>{seat}{i === 0 ? ' (you)' : ''}:</strong> <a href={url}>{url}</a>{' '}
                  <button onClick={() => navigator.clipboard?.writeText(url)}>copy</button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="lobby-art">
        <h2>Card art</h2>
        <p>
          Play with the built-in text UI, or load card images from your own copy of
          the official Impulse VASSAL module. The module stays on your machine —
          images are unpacked in your browser and cached there.
        </p>
        <ArtControls />
      </div>
      <div className="lobby-board">
        <Leaderboard
          game={RATINGS_GAME}
          highlightPlayerId={identity?.playerId}
          title="Leaderboard"
        />
        <p className="hint">
          Finished games between two signed-in players are rated (Glicko-2).
          Games against the AI are rated too — each AI personality has its own
          rating.
        </p>
      </div>
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

/** A tech slot: the researched card (art or text), or the basic tech's name. */
function TechSlotView({ tech }: { tech: Tech }) {
  if (tech.type === 'researched') return <CardChip id={tech.cardId} />;
  return <span className="chip" title={techTitle(tech)}>{techLabel(tech)}</span>;
}

function PlayerPanel({ g, p, you }: { g: ImpulseState; p: PlayerState; you: string | null }) {
  const race = RACES.find((r) => r.id === p.raceId);
  const isActive = g.activeSeat === p.seat;
  return (
    <div className={`player ${isActive ? 'active' : ''}`}>
      <div className="player-head">
        <span className={`swatch swatch-${p.color}`} />
        <strong>{p.seat}{p.seat === you ? ' (you)' : ''}</strong>
        <RaceBadge
          raceId={p.raceId}
          name={race?.name ?? '?'}
          text={race?.basicUniqueTechText ?? ''}
        />
        <span className="prestige">★ {p.prestige}/20</span>
      </div>
      <div className="player-row">
        ships in reserve: {p.shipsAvailable} · hand: {p.hand.length} · minerals:{' '}
        {p.minerals.length === 0 ? '—' : p.minerals.map((id, i) => (
          <CardChip key={`${id}-${i}`} id={id} />
        ))}
      </div>
      <div className="player-row">
        techs:{' '}
        <TechSlotView tech={p.techLeft} />
        <TechSlotView tech={p.techRight} />
        {p.plan.length > 0 && (
          <>
            {' '}· plan: {p.plan.map((id, i) => <CardChip key={`${id}-${i}`} id={id} />)}
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
  const { view, yourTurn, gameOver, you, legalActions, submit, reportBug, loading, error, refresh, ranked } =
    useGame<ImpulseState, ImpulseAction>(client);
  const { identity } = useIdentity();

  // Attach this browser's hub identity to the seat so a finished game can be
  // rated. Once per (game, seat, identity); failures are silent by design —
  // an unattributed seat still plays, it just isn't ranked.
  const claimed = useRef<string>('');
  useEffect(() => {
    if (!identity) return;
    const key = `${gameId}:${token}:${identity.playerId}`;
    if (claimed.current === key) return;
    claimed.current = key;
    void claimSeat(gameId, token, identity.token);
  }, [gameId, token, identity]);
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
        <ArtControls />
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
                    <CardChip id={id} />
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
                      onClick={() => shortcut && act(shortcut)}>
                      <CardFace id={id} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="prompt">
            <h3>{gameOver ? 'Result' : yourTurn ? 'Your decision' : 'Waiting'}</h3>
            {gameOver && (
              <>
                <p>
                  Final prestige:{' '}
                  {[...g.players].sort((a, b) => b.prestige - a.prestige)
                    .map((p) => `${p.seat} ${p.prestige}`).join(' · ')}
                </p>
                {ranked && <RankedStatus ranked={ranked} />}
                <p>
                  <a href={LEADERBOARD_HREF} target="_blank" rel="noreferrer">🏆 Leaderboard</a>
                </p>
              </>
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
