// SVG sector map: 19 hexes (pointy-top axial layout), gates as edges,
// transports on nodes, cruisers on gate midpoints. In art mode each sector's
// card is drawn as its VASSAL image (face-down sectors use the card back);
// otherwise as the id/type label. Display-only — actions go through the prompt
// panel buttons.
import { card } from '../engine/catalog';
import type { ImpulseState, PlayerColor, Seat } from '../engine/types';
import { cardArtPath, useArt } from './assets';
import { useHoverZoomTarget } from './CardZoom';
import { cardTitle } from './labels';

const S = 52; // hex spacing
const CX = 320;
const CY = 250;
// Sector card art is landscape (355x223); keep the ratio so nothing squashes.
const CARD_W = 66;
const CARD_H = Math.round(CARD_W / 1.592);

const PLAYER_CSS: Record<PlayerColor, string> = {
  Blue: '#4f8fe8', Green: '#4fae62', Purple: '#9e6ae0',
  Red: '#e05555', White: '#e8e5da', Yellow: '#e0c33e',
};

const CARD_CSS: Record<string, string> = {
  Blue: '#4f8fe8', Yellow: '#e0c33e', Red: '#e05555', Green: '#4fae62',
};

function xy(q: number, r: number): { x: number; y: number } {
  return { x: CX + S * Math.sqrt(3) * (q + r / 2), y: CY + S * 1.5 * r };
}

export function MapView({ g }: { g: ImpulseState }) {
  const art = useArt();
  // One overlay for the map: only one sector can be hovered at a time, and the
  // enlarged copy has to render OUTSIDE the <svg> (see useHoverZoomTarget).
  const zoom = useHoverZoomTarget();
  const colorOf = new Map<Seat, string>(g.players.map((p) => [p.seat, PLAYER_CSS[p.color]]));
  const nodePos = new Map(g.map.nodes.map((n) => [n.id, xy(n.q, n.r)]));

  const shipsAt = (key: string) =>
    g.ships.filter((sp) => `${sp.loc.type}:${sp.loc.id}` === key);

  return (
    <>
    <svg viewBox="0 0 640 520" className="map">
      {/* gates */}
      {g.map.gates.map((gt) => {
        const a = nodePos.get(gt.a)!;
        const b = nodePos.get(gt.b)!;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const cruisers = shipsAt(`gate:${gt.id}`);
        return (
          <g key={`g${gt.id}`}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="gate-line" />
            <text x={mx} y={my - 10} className="gate-id">G{gt.id}</text>
            {cruisers.map((sp, i) => (
              <polygon
                key={i}
                points={`${mx - 7 + i * 6},${my + 5} ${mx + i * 6},${my - 7} ${mx + 7 + i * 6},${my + 5}`}
                fill={colorOf.get(sp.owner)}
                stroke="#111"
              />
            ))}
          </g>
        );
      })}
      {/* sectors */}
      {g.map.nodes.map((n) => {
        const { x, y } = nodePos.get(n.id)!;
        const nc = g.nodeCards[n.id];
        const transports = shipsAt(`node:${n.id}`);
        const homeStroke = n.isHome ? colorOf.get(n.owner!) : undefined;
        // Art mode draws the sector's card image; the Sector Core has no card
        // of its own in the module, so it keeps the styled disc in both modes.
        const asArt = art.useArt && nc !== undefined && nc.kind !== 'core';
        const sectorSrc = asArt
          ? art.resolve(cardArtPath(nc.kind === 'faceUp' ? nc.cardId : 0))
          : '';
        const sectorTitle = nc?.kind === 'faceUp' && nc.cardId !== 0
          ? cardTitle(nc.cardId)
          : `N${n.id} — unexplored`;

        let fill = '#1d2742';
        let label = '';
        let sub = '';
        if (nc?.kind === 'core') { fill = '#3d3564'; label = 'CORE'; }
        else if (nc?.kind === 'faceDown') { fill = '#232c49'; label = '▒▒'; }
        else if (nc?.kind === 'faceUp') {
          const c = nc.cardId === 0 ? null : card(nc.cardId);
          fill = '#182138';
          label = c ? `#${nc.cardId}` : '?';
          sub = c ? `${c.actionType} ${c.size}` : '';
        }

        return (
          <g key={`n${n.id}`}>
            {asArt ? (
              <>
                <image
                  href={sectorSrc}
                  x={x - CARD_W / 2}
                  y={y - CARD_H / 2}
                  width={CARD_W}
                  height={CARD_H}
                  preserveAspectRatio="xMidYMid slice"
                  onMouseEnter={(e) => zoom.show(e.currentTarget, sectorSrc, sectorTitle)}
                  onMouseLeave={zoom.hide}
                  style={zoom.enabled ? { cursor: 'zoom-in' } : undefined}
                >
                  <title>{sectorTitle}</title>
                </image>
                <rect
                  x={x - CARD_W / 2} y={y - CARD_H / 2} width={CARD_W} height={CARD_H}
                  fill="none" rx={3}
                  stroke={homeStroke ?? '#3a4a76'} strokeWidth={n.isHome ? 3 : 1}
                />
                <text x={x} y={y + CARD_H / 2 + 9} className="node-sub">N{n.id}</text>
              </>
            ) : (
              <>
                <circle cx={x} cy={y} r={30} fill={fill}
                  stroke={homeStroke ?? (nc?.kind === 'core' ? '#b9a7ff' : '#3a4a76')}
                  strokeWidth={n.isHome || nc?.kind === 'core' ? 3 : 1.5} />
                {nc?.kind === 'faceUp' && nc.cardId !== 0 && (
                  <circle cx={x} cy={y} r={30} fill="none"
                    stroke={CARD_CSS[card(nc.cardId).color]} strokeWidth={2} strokeDasharray="4 3" />
                )}
                <text x={x} y={y - 4} className="node-label">{label}</text>
                <text x={x} y={y + 9} className="node-sub">{sub || `N${n.id}`}</text>
              </>
            )}
            {/* Transports sit on the sector card, as they do on the table. */}
            {transports.map((sp, i) => (
              <circle key={i}
                cx={x - 18 + (i % 5) * 9}
                cy={(asArt ? y + 12 : y + 20) - Math.floor(i / 5) * 9}
                r={4} fill={colorOf.get(sp.owner)} stroke="#111" strokeWidth={1.2} />
            ))}
          </g>
        );
      })}
    </svg>
    {zoom.overlay}
    </>
  );
}
