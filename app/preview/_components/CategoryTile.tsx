// Illustrated tile (D4): flat, two-tone, category-coded glyph on a tinted field.
// Built from brand tokens — no photos, no AI imagery — so the grid stays calm and
// unmistakably KIDS FUN. Decorative: the category is also stated in card text.

import type { Category } from '../_data/types';
import type { ReactNode } from 'react';

interface TileStyle {
  field: string;
  glyph: string;
  draw: ReactNode;
}

// Palette pairings follow the Blueprint v0.2 illustration system.
const TILES: Record<Category, TileStyle> = {
  swim: {
    field: '#d8e3e0', // rainy fog
    glyph: '#183b24', // evergreen
    draw: (
      <g fill="none" stroke="#183b24" strokeWidth="2" strokeLinecap="round">
        <path d="M6 26c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" />
        <path d="M6 34c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" />
        <path d="M6 42c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0" />
      </g>
    ),
  },
  skate: {
    field: '#d8e3e0',
    glyph: '#102316', // forest ink
    draw: (
      <g fill="none" stroke="#102316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 14v20h10a4 4 0 0 0 4-4v-4l-8-2-2-10z" />
        <path d="M14 38h22" />
      </g>
    ),
  },
  open_gym: {
    field: '#c9b79e', // sand
    glyph: '#102316',
    draw: (
      <g fill="none" stroke="#102316" strokeWidth="2">
        <circle cx="24" cy="24" r="11" />
        <path d="M24 13v22M13 24h22M16 16l16 16M32 16L16 32" strokeWidth="1.6" />
      </g>
    ),
  },
  storytime: {
    field: '#f7f2e8', // warm paper
    glyph: '#8d7aad', // evening plum
    draw: (
      <g fill="none" stroke="#8d7aad" strokeWidth="2" strokeLinejoin="round">
        <path d="M24 16c-3-2-7-2-10 0v18c3-2 7-2 10 0z" />
        <path d="M24 16c3-2 7-2 10 0v18c-3-2-7-2-10 0z" />
      </g>
    ),
  },
  museum_arts: {
    field: '#d9c7ef', // museum lilac
    glyph: '#5b4780',
    draw: (
      <g fill="none" stroke="#5b4780" strokeWidth="2" strokeLinejoin="round">
        <path d="M14 20l10-6 10 6" />
        <path d="M16 20v14M24 20v14M32 20v14" />
        <path d="M12 34h24" />
      </g>
    ),
  },
  nature: {
    field: '#758a73', // park moss
    glyph: '#f7f2e8', // warm paper
    draw: (
      <g fill="none" stroke="#f7f2e8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 36V18" />
        <path d="M24 26c-4 0-8-2-9-7 5-1 9 1 9 7z" />
        <path d="M24 22c4 0 8-2 9-7-5-1-9 1-9 7z" />
      </g>
    ),
  },
  festival: {
    field: '#c7ecd4', // leaf tint
    glyph: '#102316',
    draw: (
      <g fill="none" stroke="#102316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 14v22" />
        <path d="M18 15h13l-4 5 4 5H18" />
      </g>
    ),
  },
  indoor_play: {
    field: '#c9b79e',
    glyph: '#183b24',
    draw: (
      <g fill="none" stroke="#183b24" strokeWidth="2" strokeLinejoin="round">
        <rect x="14" y="26" width="9" height="9" rx="1.5" />
        <rect x="25" y="26" width="9" height="9" rx="1.5" />
        <rect x="19.5" y="15" width="9" height="9" rx="1.5" />
      </g>
    ),
  },
};

export function CategoryTile({ category, size }: { category: Category; size?: number }) {
  const t = TILES[category];
  const style = size ? { width: size, height: size } : undefined;
  return (
    <svg
      className="kf-tile"
      style={style}
      viewBox="0 0 48 48"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="0" width="48" height="48" rx="12" fill={t.field} />
      {t.draw}
    </svg>
  );
}
