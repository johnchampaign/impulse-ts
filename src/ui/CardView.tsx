// Card renderers. Each one has an art branch (VASSAL image) and a text branch
// (the original CSS card) so the two UIs are interchangeable per player.
// VASSAL card art is landscape (355x223 ≈ 1.59:1) — the art sizes below keep
// that ratio so nothing is squashed.
//
// In art mode every image hover-zooms (src/ui/CardZoom.tsx), which is how you
// read a card: the in-flow art can stay small because the enlargement is an
// overlay. Text mode needs no zoom — those cards already show their rules text.
import { card } from '../engine/catalog';
import { cardArtPath, raceArtPath, useArt } from './assets';
import { useHoverZoom } from './CardZoom';
import { cardLabel, cardTitle } from './labels';

export type CardSize = 'sm' | 'md';

const ART_W: Record<CardSize, number> = { sm: 74, md: 128 };

/** A single card. `id === 0` is a redacted card (renders the shared back). */
export function CardFace({ id, size = 'md' }: { id: number; size?: CardSize }) {
  const art = useArt();
  const src = art.useArt ? art.resolve(cardArtPath(id)) : null;
  const label = id === 0 ? 'face-down card' : cardLabel(id);
  const zoom = useHoverZoom(src, label);

  if (!src) {
    return (
      <span className={`tcard tcard-${size}`} title={cardTitle(id)}>
        <span className={`band band-${id === 0 ? 'hidden' : card(id).color}`} />
        <span className="tcard-label">{cardLabel(id)}</span>
        {size === 'md' && id !== 0 && <span className="etext">{card(id).effectText}</span>}
      </span>
    );
  }
  const w = ART_W[size];
  return (
    <>
      <img
        ref={zoom.ref}
        onMouseEnter={zoom.onMouseEnter}
        onMouseLeave={zoom.onMouseLeave}
        className={`acard acard-${size}`}
        src={src}
        alt={label}
        title={cardTitle(id)}
        width={w}
        height={Math.round(w / 1.592)}
        draggable={false}
      />
      {zoom.overlay}
    </>
  );
}

/** Inline card reference used in prose-ish rows (minerals, plan, techs). */
export function CardChip({ id }: { id: number }) {
  const art = useArt();
  if (!art.useArt) {
    return <span className="chip" title={cardTitle(id)}>{cardLabel(id)}</span>;
  }
  return <CardFace id={id} size="sm" />;
}

/** The player's race card (art, hover-zoomable) or its name in text mode. */
export function RaceBadge({ raceId, name, text }: { raceId: number; name: string; text: string }) {
  const art = useArt();
  const src = art.useArt ? art.resolve(raceArtPath(raceId)) : null;
  const zoom = useHoverZoom(src, name);
  if (!src) return <span className="race">{name}</span>;
  return (
    <>
      <img
        ref={zoom.ref}
        onMouseEnter={zoom.onMouseEnter}
        onMouseLeave={zoom.onMouseLeave}
        className="race-art"
        src={src}
        alt={name}
        title={`${name} — ${text}`}
        width={96}
        height={72}
        draggable={false}
      />
      {zoom.overlay}
    </>
  );
}
