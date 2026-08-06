// Cloudflare Pages Functions backend for the lobby + game API. Mirrors the
// proven innovation-ts router (same framework version, same env names so the
// shared Supabase project secret works across games).
// Routes:
//   POST  /api/games                    body: {numPlayers} → {gameId, invites}
//   GET   /api/games/:id?token=...      → ViewResult
//   GET   /api/games/:id/legal?token=…  → Action[]
//   POST  /api/games/:id/submit?token=… body: {action, identityToken?} → ViewResult
//   POST  /api/games/:id/claim?token=…  body: {identityToken} → {ok, playerId}
//   POST  /api/games/:id/report?token=… body: report → {reportId}
//   GET   /api/games/:id/chat?token=…   → ChatMessage[]
//   POST  /api/games/:id/chat?token=…   body: {body} → ChatMessage[]
//   POST  /api/upload-log               body: state+log → GitHub issue
import { createClient } from '@supabase/supabase-js';
import {
  GameServer, SupabaseStore, SupabaseBroadcaster, NoopNotifier,
  verifyIdentityToken, type Jwks,
} from 'digital-boardgame-framework/server';
import { jsonCodec } from 'digital-boardgame-framework';
import { createGame as newImpulseGame, impulseAdapter } from '../../src/adapter/impulseAdapter';
import { impulseAiControllers } from '../../src/ai/controllers';
import { seatOf, type ImpulseAction, type ImpulseState, type Seat } from '../../src/engine/types';

interface Env {
  SUPABASE_URL: string;
  /** Service-role key; named to match the other games so one shared Supabase
   *  project's secret works everywhere. Never exposed to the client. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  PUBLIC_ORIGIN?: string;
  /** PUBLIC anon key for the same Supabase project. Optional: when set, the
   *  server broadcasts move/chat signals and hands the key to clients via
   *  GET /api/realtime so they get instant updates instead of ~10s polling.
   *  Safe in browsers — RLS denies anon on every table. */
  SUPABASE_ANON_KEY?: string;
  /** PAT with issues:write on the reports repo (optional; 503 without). */
  GITHUB_TOKEN?: string;
  /** owner/repo for bug-report issues. Defaults to johnchampaign/impulse-ts-reports. */
  REPORTS_REPO?: string;
  /** Shared secret matching the hub's RATINGS_INGEST_KEY (enables ranked play). */
  RATINGS_INGEST_KEY?: string;
}

interface RouteCtx { request: Request; env: Env; }

// Cached hub JWKS for verifying ranked-play identity tokens (refreshed hourly).
const HUB = 'https://games-hub-5vo.pages.dev';
let _jwks: Jwks | undefined;
let _jwksAt = 0;
async function getJwks(): Promise<Jwks> {
  if (!_jwks || Date.now() - _jwksAt > 3_600_000) {
    _jwks = (await (await fetch(`${HUB}/id/jwks`)).json()) as Jwks;
    _jwksAt = Date.now();
  }
  return _jwks;
}

function server(env: Env, origin: string) {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return new GameServer<ImpulseState, ImpulseAction, Seat>({
    snapshotHistory: 20,
    appId: 'impulse', // isolates this game's bug reports on the shared backend
    adapter: impulseAdapter,
    codec: jsonCodec<ImpulseState>(),
    store: new SupabaseStore(supabase),
    aiControllers: impulseAiControllers,   // server-driven AI seats (rated)
    // Signal-only realtime: broadcasts "something changed"; clients re-fetch
    // their own redacted view. Only wired when the public anon key exists,
    // since a client with no key can't subscribe anyway.
    ...(env.SUPABASE_ANON_KEY
      ? {
          broadcaster: new SupabaseBroadcaster({
            supabaseUrl: env.SUPABASE_URL,
            serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
          }),
        }
      : {}),
    notifier: new NoopNotifier(),
    playBeacon: { appId: 'impulse' },
    gameUrl: (gameId, token) =>
      `${origin}/?game=${encodeURIComponent(gameId)}&token=${encodeURIComponent(token)}`,
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
    ...(env.RATINGS_INGEST_KEY
      ? { ratings: { game: 'impulse', ingestKey: env.RATINGS_INGEST_KEY } }
      : {}),
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function bad(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

async function readJson<T>(req: Request): Promise<T> {
  try { return await req.json() as T; }
  catch { throw new Error('invalid JSON body'); }
}

function originOf(env: Env, req: Request): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN.replace(/\/$/, '');
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** Engine seeds come from server-side entropy — the engine itself stays
 *  deterministic from this single number. */
function randomSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}

interface UploadLogBody {
  kind: 'bug' | 'logs';
  severity: 'bug' | 'rules-question' | 'feedback';
  message: string;
  timestamp: string;
  userAgent: string;
  build: string;
  state: unknown;
  log: unknown;
  screenshotDownloaded?: boolean;
}

/** File a GitHub Issue with the user-submitted state + log (innovation-ts
 *  pattern; body bounded to fit GitHub's 65,536-char limit). */
async function uploadLog(env: Env, request: Request): Promise<Response> {
  if (!env.GITHUB_TOKEN) {
    return bad('GitHub upload not configured (missing GITHUB_TOKEN secret).', 503);
  }
  const body = await request.json() as UploadLogBody;
  const repo = env.REPORTS_REPO ?? 'johnchampaign/impulse-ts-reports';

  const firstLine = (body.message || '').split('\n')[0]!.slice(0, 80).trim();
  const title = body.kind === 'bug'
    ? `[bug] ${firstLine || '(no description)'}`
    : `[log] session ${body.timestamp}`;

  let jsonBlob = JSON.stringify({ state: body.state, log: body.log }, null, 2);
  const MAX_JSON = 58_000;
  let truncated = false;
  if (jsonBlob.length > MAX_JSON) {
    jsonBlob = jsonBlob.slice(0, MAX_JSON) + '\n... [truncated]';
    truncated = true;
  }

  const issueBody = [
    body.kind === 'bug' ? '**Bug report from the in-game UI.**' : '**Session log upload.**',
    '',
    body.message
      ? body.message.split('\n').map((l) => '> ' + l).join('\n')
      : '_(no description provided)_',
    '',
    `- **Severity:** \`${body.severity}\``,
    `- **Build:** \`${body.build}\``,
    `- **Timestamp:** \`${body.timestamp}\``,
    `- **User agent:** \`${body.userAgent}\``,
    truncated ? '- **State+log:** truncated to 58KB' : '',
    body.screenshotDownloaded
      ? '- **Screenshot:** downloaded to the reporter\'s machine — drag it into a comment here to attach.'
      : '',
    '',
    '<details><summary>State + log (JSON)</summary>',
    '',
    '```json',
    jsonBlob,
    '```',
    '',
    '</details>',
  ].filter(Boolean).join('\n');

  const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'impulse-ts-pages-function',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      body: issueBody,
      labels: body.kind === 'bug' ? ['user-bug', body.severity] : ['session-log'],
    }),
  });
  if (!ghRes.ok) {
    const errText = await ghRes.text();
    return bad(`GitHub API ${ghRes.status}: ${errText.slice(0, 300)}`, 502);
  }
  const issue = await ghRes.json() as { html_url: string; number: number };
  return json({ issueUrl: issue.html_url, issueNumber: issue.number });
}

export const onRequest = async ({ request, env }: RouteCtx): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const token = url.searchParams.get('token') ?? undefined;

  try {
    if (path === '/upload-log' && request.method === 'POST') {
      return await uploadLog(env, request);
    }

    // GET /api/realtime — hands the client the PUBLIC anon key so it can
    // subscribe to move/chat signals. Returns {enabled:false} when unset, and
    // the client falls back to polling. Never exposes the service-role key.
    if (path === '/realtime' && request.method === 'GET') {
      return env.SUPABASE_ANON_KEY
        ? json({ enabled: true, supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY })
        : json({ enabled: false });
    }

    // GET /api/reports — triage listing for the automated problem-report loop.
    // Public-read on purpose: reports carry no PII (tokens and emails live in
    // GameMeta, never in a report row), and token-gating this would mean the
    // triage agent has no way to read reports without a human ferrying a
    // secret every run. `?unresolved=1` is the normal triage query. The heavy
    // reproduction blobs are dropped unless `?full=1` — a listing should stay
    // scannable, and the blobs are per-report detail.
    if (path === '/reports' && request.method === 'GET') {
      const p = url.searchParams;
      const rows = await server(env, originOf(env, request)).listReports({
        appId: 'impulse', // shared backend — never surface another game's reports
        ...(p.get('unresolved') ? { unresolved: true } : {}),
        ...(p.get('since') ? { since: p.get('since')! } : {}),
        ...(p.get('severity') ? { severity: p.get('severity')! } : {}),
        ...(p.get('category') ? { category: p.get('category')! } : {}),
        ...(p.get('gameId') ? { gameId: p.get('gameId')! } : {}),
      });
      if (p.get('full')) return json({ reports: rows });
      return json({
        reports: rows.map(({ serverSnapshot: _s, reporterView: _v, clientLog: _l, ...rest }) => rest),
      });
    }

    // POST /api/reports/:id/resolve — public-write, matching the read tier: this
    // is a routine, reversible triage action (it stamps a resolution string), so
    // the same reasoning that makes the listing public applies here.
    const resolveMatch = path.match(/^\/reports\/([^/]+)\/resolve$/);
    if (resolveMatch && request.method === 'POST') {
      const body = await readJson<{ resolution?: string }>(request);
      if (typeof body?.resolution !== 'string' || !body.resolution.trim()) {
        return bad('resolution required', 422);
      }
      await server(env, originOf(env, request))
        .resolveReport(resolveMatch[1]!, body.resolution.trim());
      return json({ ok: true });
    }

    // POST /api/games — create. `ai` maps seats to AI policy keys, e.g.
    // {"numPlayers":2,"ai":{"P2":"greedy"}} for one human vs one AI.
    if (path === '/games' && request.method === 'POST') {
      const body = await readJson<{
        numPlayers: number;
        seed?: number;
        ai?: Partial<Record<Seat, string>>;
      }>(request);
      const numPlayers = Number(body.numPlayers);
      if (!Number.isInteger(numPlayers) || numPlayers < 2 || numPlayers > 6) {
        return bad('numPlayers must be 2..6');
      }
      const seed = Number.isInteger(body.seed) ? Number(body.seed) : randomSeed();
      const players: Seat[] = Array.from({ length: numPlayers }, (_, i) => seatOf(i + 1));

      const ai: Partial<Record<Seat, string>> = {};
      for (const [seat, policy] of Object.entries(body.ai ?? {})) {
        if (!players.includes(seat)) return bad(`unknown seat ${seat}`, 422);
        if (typeof policy !== 'string' || !(policy in impulseAiControllers)) {
          return bad(`unknown AI policy ${String(policy)}; ` +
            `expected one of ${Object.keys(impulseAiControllers).join(', ')}`, 422);
        }
        ai[seat] = policy;
      }
      // Leave at least one human seat, or nobody could ever move the game on.
      if (Object.keys(ai).length >= numPlayers) return bad('at least one seat must be human', 422);

      const initialState = newImpulseGame({ playerCount: numPlayers, seed });
      const out = await server(env, originOf(env, request)).createGame({
        initialState,
        players,
        ...(Object.keys(ai).length > 0 ? { ai } : {}),
      });
      return json(out);
    }

    // /api/games/:id...
    const gameMatch = path.match(/^\/games\/([^/]+)(.*)$/);
    if (gameMatch) {
      const [, gameId, rest] = gameMatch as unknown as [string, string, string];
      if (!token) return bad('missing token', 401);
      const srv = server(env, originOf(env, request));

      if (rest === '' && request.method === 'GET') {
        return json(await srv.fetch(gameId, token));
      }
      if (rest === '/legal' && request.method === 'GET') {
        return json(await srv.legalActions(gameId, token));
      }
      if (rest === '/submit' && request.method === 'POST') {
        const body = await readJson<ImpulseAction | { action: ImpulseAction; identityToken?: string }>(request);
        const hasWrapper = body && typeof body === 'object' && 'action' in body;
        const action = (hasWrapper ? (body as { action: ImpulseAction }).action : body) as ImpulseAction;
        const identityToken = hasWrapper ? (body as { identityToken?: string }).identityToken : undefined;
        if (typeof identityToken === 'string' && identityToken) {
          try { await srv.claimSeat(gameId, token, identityToken); } catch { /* optional */ }
        }
        return json(await srv.submit(gameId, token, action));
      }
      if (rest === '/claim' && request.method === 'POST') {
        const body = await readJson<{ identityToken?: string }>(request);
        if (typeof body?.identityToken !== 'string' || !body.identityToken) {
          return bad('identityToken required', 422);
        }
        const v = await srv.claimSeat(gameId, token, body.identityToken);
        return json({ ok: true, playerId: v.playerId });
      }
      if (rest === '/report' && request.method === 'POST') {
        const body = await readJson<Parameters<typeof srv.report>[2]>(request);
        return json(await srv.report(gameId, token, body));
      }
      if (rest === '/chat' && request.method === 'GET') {
        return json(await srv.listMessages(gameId, token));
      }
      if (rest === '/chat' && request.method === 'POST') {
        const body = await readJson<{ body: string }>(request);
        const text = typeof body?.body === 'string' ? body.body : '';
        return json(await srv.postMessage(gameId, token, text));
      }
    }

    return bad('not found', 404);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    const status =
      /not found|invalid token|forbidden/i.test(msg) ? 404 :
      /conflict/i.test(msg) ? 409 :
      400;
    return bad(msg, status);
  }
};
