// Bring-your-own-art: VASSAL module assets (framework docs/vassal-assets.md).
//
// Component art is copyrighted, so this repo ships NONE of it and the deployed
// build contains none either. Instead each player points the app at their own
// copy of the official Impulse VASSAL module (a .vmod is just a zip of images);
// the framework loader extracts it in the browser, caches it in IndexedDB, and
// serves blob URLs. Nothing is uploaded.
//
// Deliberate deviation from the doc's "served-files probe" step: we do NOT
// support a local public/ art folder, so there is no configuration in which a
// build could bake the art in. Local dev loads a .vmod once per browser and the
// IndexedDB cache persists.
//
// The text UI is a first-class alternative, not a fallback: `prefersArt` is a
// persisted player preference and every art-bearing renderer branches on
// `useArt` (art requested AND cached), so the game is fully playable either way.
import {
  createContext, useCallback, useContext, useMemo, useState,
  type ReactNode,
} from 'react';
import { useVmodAssets, type VmodAssetsApi } from 'digital-boardgame-framework/client';
import { CARDS } from '../engine/catalog';

/** Official module page on the VASSAL library (the dialog links players here
 *  to download it). Confirmed by the maintainer; the old /wiki/Module:Impulse
 *  form only 301-redirects. */
export const MODULE_NAME = 'Impulse';
export const MODULE_URL = 'https://vassalengine.org/library/projects/Impulse';

// Logical path → entry name inside the .vmod zip. Card art is `c<Card.Id>.jpg`
// (verified: the 108 ids in data/cards.tsv match the 108 c*.jpg entries
// exactly), the shared back is `back.jpg`, and race cards are `raza<Race.id>`.
export const MANIFEST = {
  files: Object.fromEntries([
    ...CARDS.map((c) => [`cards/c${c.id}.jpg`, `images/c${c.id}.jpg`]),
    ['cards/back.jpg', 'images/back.jpg'],
    ...[1, 2, 3, 4, 5, 6].map((n) => [`races/raza${n}.jpg`, `images/raza${n}.jpg`]),
  ]),
};

export function cardArtPath(cardId: number): string {
  // 0 is the redaction sentinel — hidden cards show the shared card back.
  return cardId === 0 ? 'cards/back.jpg' : `cards/c${cardId}.jpg`;
}

export function raceArtPath(raceId: number): string {
  return `races/raza${raceId}.jpg`;
}

const PREF_KEY = 'impulse-prefers-art';

function readPref(): boolean {
  // ?art=1 / ?art=0 forces a mode for dev + screenshots without touching the
  // stored preference.
  const q = new URLSearchParams(location.search).get('art');
  if (q === '1') return true;
  if (q === '0') return false;
  try {
    return localStorage.getItem(PREF_KEY) !== '0';
  } catch {
    return true; // storage blocked (private mode): art is the nicer default
  }
}

export interface ArtApi {
  /** Render card art right now (the player wants it AND it's cached). */
  useArt: boolean;
  /** The player's preference, independent of whether art is loaded yet. */
  prefersArt: boolean;
  setPrefersArt: (v: boolean) => void;
  /** True when art is wanted but not yet loaded — the setup dialog's cue. */
  needsSetup: boolean;
  /** Resolve a logical path to a blob URL. Only meaningful when useArt. */
  resolve: (path: string) => string;
  vmod: VmodAssetsApi;
}

const ArtCtx = createContext<ArtApi | null>(null);

export function useArt(): ArtApi {
  const ctx = useContext(ArtCtx);
  if (!ctx) throw new Error('useArt outside ArtProvider');
  return ctx;
}

export function ArtProvider({ children }: { children: ReactNode }) {
  const vmod = useVmodAssets(MANIFEST, { dbName: 'impulse-vmod' });
  const [prefersArt, setPrefersArtState] = useState(readPref);

  const setPrefersArt = useCallback((v: boolean) => {
    setPrefersArtState(v);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const api = useMemo<ArtApi>(() => ({
    useArt: prefersArt && vmod.ready,
    prefersArt,
    setPrefersArt,
    needsSetup: prefersArt && !vmod.ready,
    resolve: vmod.resolve,
    vmod,
  }), [prefersArt, setPrefersArt, vmod]);

  // Dev-only test hook: lets an automated check feed a module in without
  // driving a native file picker. Never present in a production build.
  if (import.meta.env.DEV) {
    (window as unknown as { __impulseArt?: ArtApi }).__impulseArt = api;
  }

  return <ArtCtx.Provider value={api}>{children}</ArtCtx.Provider>;
}
