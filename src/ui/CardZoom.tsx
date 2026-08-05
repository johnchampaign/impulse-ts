// Hover-to-enlarge for card art, ported from the Tyrants of the Underdark
// board (../Tyrants of the Underdark/src/App.tsx, the `Card` component).
//
// Properties worth keeping from that implementation:
//  - the in-flow image never changes size, so hovering can't reflow the layout;
//    the enlargement is a separate overlay copy
//  - the overlay is `position: fixed`, so it escapes any ancestor with
//    `overflow: auto` (our hand strip, impulse track and log panes all scroll)
//  - `transform-origin` is SOLVED so the scaled box stays inside the viewport —
//    a card at the right-hand edge grows leftwards instead of off-screen
//  - `pointer-events: none` on the overlay, or it would steal its own hover and
//    flicker
//  - hover is only wired on devices that actually hover (`(hover: hover)`);
//    Tyrants hit a bug where a tap on a touch screen left a card stuck enlarged
//
// Deviation: Tyrants uses a flat 2.5x. Our art appears at wildly different
// sizes (128px hand cards, 74px chips, ~60px map sectors), and a flat multiple
// leaves the small ones unreadable, so the scale targets the art's native width
// instead — every zoom lands around 340px regardless of source size.
import { useRef, useState, type ReactNode } from 'react';

const HOVER_CAPABLE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

/** Roughly the art's native width (355px) — a comfortable reading size. */
const TARGET_WIDTH = 340;
const MIN_SCALE = 1.8;
const MAX_SCALE = 5;

interface Zoomed {
  src: string;
  alt: string;
  rect: { top: number; left: number; width: number; height: number };
  origin: string;
  scale: number;
}

function measure(el: Element, src: string, alt: string): Zoomed {
  const r = el.getBoundingClientRect();
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, TARGET_WIDTH / r.width));
  const k = scale - 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Scaling by `scale` about origin fraction ox gives
  //   left  = r.left + r.width * ox * (1 - scale)
  //   right = left + r.width * scale
  // Solve left >= 0 and right <= vw for ox, then clamp the preferred centre
  // (0.5) into that window. Same for the vertical axis.
  const oxMin = Math.max(0, (r.left + r.width * scale - vw) / (r.width * k));
  const oxMax = Math.min(1, r.left / (r.width * k));
  const oyMin = Math.max(0, (r.top + r.height * scale - vh) / (r.height * k));
  const oyMax = Math.min(1, r.top / (r.height * k));
  // An empty window means the zoom can't fit on that axis at all — centre it
  // and accept the overflow rather than snapping to a corner.
  const ox = oxMin > oxMax ? 0.5 : Math.min(oxMax, Math.max(oxMin, 0.5));
  const oy = oyMin > oyMax ? 0.5 : Math.min(oyMax, Math.max(oyMin, 0.5));
  return {
    src,
    alt,
    rect: { top: r.top, left: r.left, width: r.width, height: r.height },
    origin: `${(ox * 100).toFixed(1)}% ${(oy * 100).toFixed(1)}%`,
    scale,
  };
}

function Overlay({ z }: { z: Zoomed }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: z.rect.top,
        left: z.rect.left,
        width: z.rect.width,
        height: z.rect.height,
        transform: `scale(${z.scale})`,
        transformOrigin: z.origin,
        zIndex: 1000,
        pointerEvents: 'none',
        borderRadius: 6,
        boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
      }}
    >
      <img
        src={z.src}
        alt={z.alt}
        draggable={false}
        style={{ width: '100%', height: '100%', display: 'block', borderRadius: 6 }}
      />
    </div>
  );
}

export interface HoverZoom {
  /** Attach to the element being hovered (works for <img> and SVG <image>). */
  ref: (el: Element | null) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  /** Render as a sibling — position:fixed, so it needs no special parent. */
  overlay: ReactNode;
}

/**
 * Hover-zoom for ONE image. Pass `src: null` to disable (text mode, or art not
 * loaded): the handlers come back undefined so no listeners are attached.
 */
export function useHoverZoom(src: string | null, alt: string): HoverZoom {
  const el = useRef<Element | null>(null);
  const [z, setZ] = useState<Zoomed | null>(null);
  const active = HOVER_CAPABLE && src !== null;
  return {
    ref: (node) => { el.current = node; },
    onMouseEnter: active ? () => { if (el.current) setZ(measure(el.current, src, alt)); } : undefined,
    onMouseLeave: active ? () => setZ(null) : undefined,
    overlay: z ? <Overlay z={z} /> : null,
  };
}

export interface HoverZoomTarget {
  /** Call from onMouseEnter with the hovered element and its art. */
  show: (el: Element, src: string, alt: string) => void;
  hide: () => void;
  enabled: boolean;
  /** Render ONCE, outside any SVG (the overlay is HTML in screen pixels). */
  overlay: ReactNode;
}

/**
 * Hover-zoom shared by MANY elements — for SVG children, whose overlay cannot
 * live inside the `<svg>` (an HTML overlay there needs a `foreignObject`, and a
 * zero-sized one clips it away). Only one element can be hovered at a time, so a
 * single overlay is enough.
 */
export function useHoverZoomTarget(): HoverZoomTarget {
  const [z, setZ] = useState<Zoomed | null>(null);
  return {
    enabled: HOVER_CAPABLE,
    show: (el, src, alt) => { if (HOVER_CAPABLE) setZ(measure(el, src, alt)); },
    hide: () => setZ(null),
    overlay: z ? <Overlay z={z} /> : null,
  };
}
