# Deploying Impulse

Live at **https://impulse-ts.pages.dev** (Cloudflare Pages project
`impulse-ts`, production branch `main`).

## Architecture

- **Client** (`src/`, `index.html`) — built by Vite to `dist/`. Currently a
  stub page; the play UI is the next phase.
- **API** (`functions/api/[[path]].ts`) — Cloudflare Pages Functions running
  the framework `GameServer` on Workers.
- **Store** — the shared games Supabase project (same one the hub,
  innovation-ts, tyrants-online, and star-wars-rebellion use; framework
  `dbf_*` tables already applied, RLS on).
- **Notifier** — `NoopNotifier` (swap for `ResendNotifier` for email pings).

## Environment (Pages project → Settings → Environment variables)

Already set as encrypted secrets on the production environment:

- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — shared games project.
- `RATINGS_INGEST_KEY` — hub ranked-play ingest secret.
- `SUPABASE_ANON_KEY` — the project's PUBLIC anon key, enabling realtime push.
  The server broadcasts move/chat signals and serves this key to clients via
  `GET /api/realtime`; without it clients fall back to ~10s polling. Safe in
  browsers (RLS denies anon on every table). Verify with
  `npx vite-node scripts/probe-realtime.ts`.

Note: Pages applies env-var changes on the **next deployment**, and the apex can
serve the previous deployment for up to a minute afterwards — so re-check rather
than concluding a new secret didn't take.

Optional, not yet set:

- `GITHUB_TOKEN` + `REPORTS_REPO` — enables `/api/upload-log` filing GitHub
  issues (defaults to `johnchampaign/impulse-ts-reports`; create that repo
  and a PAT with issues:write when the UI ships its report button).
- `PUBLIC_ORIGIN` — only needed if serving behind a custom domain.

## Release

```bash
npm run deploy
```

(= `npm run build && wrangler pages deploy --project-name=impulse-ts`.
`--branch main` is the default here and `main` is the Production branch —
mind the framework's Production-branch gotcha if that ever changes.)

## API smoke (works today, no UI needed)

```bash
curl -s -X POST https://impulse-ts.pages.dev/api/games \
  -H 'Content-Type: application/json' -d '{"numPlayers":2}'
# → {gameId, invites: {P1: url-with-token, P2: ...}}
curl -s "https://impulse-ts.pages.dev/api/games/GAMEID/legal?token=TOKEN"
curl -s -X POST "https://impulse-ts.pages.dev/api/games/GAMEID/submit?token=TOKEN" \
  -H 'Content-Type: application/json' -d '{"action": {...}}'
```

Note: Cloudflare's bot check 403s some non-browser user agents (Python
urllib); curl and browsers are fine.
