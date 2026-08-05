// Optional realtime push. Without it `useGame` polls (~10s); with it, the
// opponent's move appears immediately. The broadcast is signal-only ({turn}) —
// state always comes back through the server's redacted view, never the wire.
//
// The client needs the Supabase project's PUBLIC anon key. That key is designed
// to ship in browsers (the schema's RLS denies anon on every table; only the
// server's service-role key can read or write), but it isn't in this repo — so
// the SERVER hands it to us from its own env at runtime (GET /api/realtime).
// Consequences: nothing project-specific is hardcoded or committed here, and
// turning realtime on is one Pages secret (SUPABASE_ANON_KEY) with no code
// change or client rebuild.
//
// Until that secret exists the endpoint reports disabled and useGame falls back
// to polling — fully playable, just up to ~10s later.
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
