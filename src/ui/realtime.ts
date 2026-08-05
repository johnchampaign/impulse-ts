// Optional realtime push. Without it `useGame` polls (~10s); with it, the
// opponent's move appears immediately. The broadcast is signal-only ({turn}) —
// state always comes back through the server's redacted view, never the wire.
//
// The client needs the Supabase project's PUBLIC anon key. That key is designed
// to ship in browsers (the schema's RLS denies anon on every table; only the
// server's service-role key can read or write), but it isn't committed here — the
// SERVER hands it over from its own env at runtime (GET /api/realtime). So
// nothing project-specific lives in this repo, and the feature is controlled by
// one Pages secret (SUPABASE_ANON_KEY) rather than a rebuild.
//
// Enabled in production. If the secret is ever missing the endpoint reports
// disabled and useGame falls back to polling — fully playable, just up to ~10s
// later. `scripts/probe-realtime.ts` verifies the live path.
import { subscribeSupabaseRealtime } from 'digital-boardgame-framework/client/realtime';
import { withDeadline } from 'digital-boardgame-framework/client';

export interface RealtimeConfig {
  supabaseUrl: string;
  anonKey: string;
}

/** Ask the server whether realtime is available. Never throws. */
export async function fetchRealtimeConfig(): Promise<RealtimeConfig | null> {
  try {
    return await withDeadline(async (signal) => {
      const r = await fetch('/api/realtime', { signal });
      if (!r.ok) return null;
      const cfg = (await r.json()) as Partial<RealtimeConfig>;
      return cfg.supabaseUrl && cfg.anonKey
        ? { supabaseUrl: cfg.supabaseUrl, anonKey: cfg.anonKey }
        : null;
    }, 10_000, 'Checking for live updates');
  } catch {
    return null;
  }
}

/** A `subscribe` fn for useGame, or undefined when realtime isn't configured. */
export function realtimeSubscribe(cfg: RealtimeConfig | null, gameId: string) {
  if (!cfg) return undefined;
  return subscribeSupabaseRealtime({ ...cfg, gameId });
}
