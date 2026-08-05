// Proves realtime push works end to end against production: subscribe as a
// client would, make a move over HTTP, and assert the "something changed"
// signal actually arrives. Run with: npx vite-node scripts/probe-realtime.ts
//
// Config comes from the deployed server (GET /api/realtime), so this exercises
// the same path the browser uses — including that the server is handing out a
// usable anon key.
import { subscribeSupabaseRealtime } from 'digital-boardgame-framework/client/realtime';

const ORIGIN = 'https://impulse-ts.pages.dev';
const HDRS = { 'content-type': 'application/json', 'user-agent': 'curl/8.5.0' };

const cfg = await (await fetch(`${ORIGIN}/api/realtime`)).json() as
  { enabled?: boolean; supabaseUrl?: string; anonKey?: string };
if (!cfg.enabled || !cfg.supabaseUrl || !cfg.anonKey) {
  throw new Error(`realtime not configured on the server: ${JSON.stringify(cfg)}`);
}
console.log('server reports realtime enabled');

// A game with an AI opponent, so one HTTP move produces server-side activity.
const created = await (await fetch(`${ORIGIN}/api/games`, {
  method: 'POST', headers: HDRS,
  body: JSON.stringify({ numPlayers: 2, ai: { P2: 'greedy' } }),
})).json() as { gameId: string; invites: Record<string, string> };
const gameId = created.gameId;
const token = created.invites['P1']!.split('token=')[1]!;
console.log('game:', gameId);

let signals = 0;
const unsubscribe = subscribeSupabaseRealtime({
  supabaseUrl: cfg.supabaseUrl,
  anonKey: cfg.anonKey,
  gameId,
})(() => { signals++; console.log(`  ← push signal #${signals}`); });

// Give the socket a moment to join the channel before moving.
await new Promise((r) => setTimeout(r, 4000));

const legal = await (await fetch(`${ORIGIN}/api/games/${gameId}/legal?token=${token}`)).json() as unknown[];
await fetch(`${ORIGIN}/api/games/${gameId}/submit?token=${token}`, {
  method: 'POST', headers: HDRS, body: JSON.stringify({ action: legal[0] }),
});
console.log('move submitted — waiting for the push…');

await new Promise((r) => setTimeout(r, 6000));
unsubscribe();

if (signals === 0) {
  console.error('FAIL: no realtime signal arrived (clients would fall back to ~10s polling)');
  process.exit(1);
}
console.log(`PASS: ${signals} signal(s) received — opponents' moves arrive instantly`);
