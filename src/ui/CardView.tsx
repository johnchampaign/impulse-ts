// Card renderers. Each one has an art branch (VASSAL image) and a text branch
// (the original CSS card) so the two UIs are interchangeable per player.
// VASSAL card art is landscape (355x223 ≈ 1.59:1) — the art sizes below keep
// that ratio so nothing is squashed.
//
// In art mode every image hover-zooms (src/ui/CardZoom.tsx), which is how you
// read a card: the in-flow art can stay small because the enlargement is an
// overlay. Text mode needs no zoom — those cards already show their rules text.
import { useEffect, useState, type ReactNode } from 'react';
import { card } from '../engine/catalog';
import { cardArtPath, raceArtPath, useArt } from './assets';
import { useHoverZoom } from './CardZoom';
import { cardEffectText, cardHeading, cardLabel, cardTitle } from './labels';

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

/** Inline card reference used in prose-ish rows (minerals, plan, techs).
 *  Passive — a tap opens the detail sheet rather than playing anything, so
 *  unlike the hand it is safe to make this tappable. */
export function CardChip({ id }: { id: number }) {
  const art = useArt();
  const src = art.useArt ? art.resolve(cardArtPath(id)) : null;
  const inner = art.useArt
    ? <CardFace id={id} size="sm" />
    : <span className="chip" title={cardTitle(id)}>{cardLabel(id)}</span>;
  if (id === 0) return inner; // nothing to reveal about a face-down card
  return (
    <Detailable title={cardHeading(id)} text={cardEffectText(id)} src={src}>
      {inner}
    </Detailable>
  );
}

/** The player's race card (art, hover-zoomable) or its name in text mode.
 *  Tappable: the race card carries the faction's unique tech text, which was
 *  otherwise reachable only by hovering. */
export function RaceBadge({ raceId, name, text }: { raceId: number; name: string; text: string }) {
  const art = useArt();
  const src = art.useArt ? art.resolve(raceArtPath(raceId)) : null;
  const zoom = useHoverZoom(src, name);
  const inner = src ? (
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
  ) : <span className="race">{name}</span>;
  return (
    <Detailable title={name} text={text} src={src}>
      {inner}
    </Detailable>
  );
}

/** Modal card/tech detail: art (when available) plus the full rules text.
 *
 *  Why this exists: every detail surface in this UI used to be either a
 *  `title=` attribute or CardZoom's hover overlay, and BOTH are dead on a
 *  touch screen — `title` needs a mouse cursor to rest, and CardZoom
 *  deliberately gates itself behind `(hover: hover)` so a tap can't leave a
 *  card stuck enlarged. The result was that on a phone a faction tech showed
 *  its name and nothing else, with no way to read what it does. A tap-opened
 *  sheet is the affordance that works on every device.
 */
function DetailSheet(
  { title, text, src, onClose }:
  { title: string; text: string; src: string | null; onClose: () => void },
) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog card-detail" onClick={(e) => e.stopPropagation()}>
        {src && <img className="card-detail-art" src={src} alt={title} draggable={false} />}
        <h3>{title}</h3>
        <p className="card-detail-text">{text}</p>
        <div className="dialog-buttons">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Wraps a passive display element (tech slot, mineral, plan card, race badge)
 *  so tapping it opens the detail sheet. NOT for the hand, where a tap already
 *  plays the card. */
export function Detailable(
  { title, text, src, className, children }:
  {
    title: string; text: string; src: string | null;
    className?: string; children: ReactNode;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span
        className={`detailable${className ? ` ${className}` : ''}`}
        role="button"
        tabIndex={0}
        aria-label={`${title} — show details`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
        }}
      >
        {children}
      </span>
      {open && <DetailSheet title={title} text={text} src={src} onClose={() => setOpen(false)} />}
    </>
  );
}
