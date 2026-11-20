/**
 * The Org page's avatars (2026-11-20, the user picked "6" of ten round-blob versions): one fat,
 * slightly tilted blob with a two-dot face, dressed with two small features of its character
 * (a crown and a cape, a sailor cap and an anchor, an antenna and robot ears ...). Drawn here as
 * SVG text, so the browser, the server's PNG route for the phone and the tests draw the same
 * picture. Browser-safe: no Node imports.
 *
 * The style follows DiceBear's "Moods" (CC0 1.0, https://www.dicebear.com/licenses/): a blob with a
 * simple face. No shape of it is copied; every path below is our own.
 */

const INK = '#1e293b';

/** A body colour and its background tint. */
export const AVATAR_COLORS: ReadonlyArray<{ body: string; bg: string }> = [
  { body: '#fb923c', bg: '#ffedd5' }, { body: '#60a5fa', bg: '#dbeafe' }, { body: '#a78bfa', bg: '#ede9fe' },
  { body: '#f472b6', bg: '#fce7f3' }, { body: '#4ade80', bg: '#dcfce7' }, { body: '#facc15', bg: '#fef9c3' },
  { body: '#2dd4bf', bg: '#ccfbf1' }, { body: '#f87171', bg: '#fee2e2' }, { body: '#818cf8', bg: '#e0e7ff' },
  { body: '#a3e635', bg: '#ecfccb' }, { body: '#38bdf8', bg: '#e0f2fe' }, { body: '#c8915a', bg: '#f5e6d3' },
  { body: '#e879f9', bg: '#fae8ff' }, { body: '#94a3b8', bg: '#f1f5f9' },
];

type Mouth = 'smile' | 'open' | 'cat' | 'flat' | 'o';

/** The blob's measures (version 6 of the ten). */
const B = { cx: 50, cy: 60, rx: 38.25, ry: 28.25, top: 31.75, bot: 88.25, fy: 56.6 };
const K = 1.12;
const n = (v: number) => (Math.round(v * 10) / 10).toString();
const at = (s: string, x: number, y: number, k = K) => `<g transform="translate(${n(x)} ${n(y)}) scale(${k})">${s}</g>`;
const EYE_GAP = 8 + B.rx * 0.12;

interface Layers { back: string[]; belly: string[]; top: string[] }
interface Character {
  id: string;
  label: string;
  /** The colour it wears when it is free (AVATAR_COLORS index). */
  color: number;
  mouth: Mouth;
  draw: (clip: string) => Partial<Layers>;
}

const { cx, top: t, bot, rx, cy, fy } = B;
const lensR = 7;

export const AVATAR_CHARACTERS: readonly Character[] = [
  {
    id: 'ceo', label: 'Crown', color: 0, mouth: 'open', draw: () => ({
      back: [`<path d="M${n(cx - rx - 2)} ${cy}q-4 ${n(B.ry)} 8 ${n(B.ry + 6)}h${n(2 * rx - 12)}q12-6 8-${n(B.ry + 6)}z" fill="#dc2626"/>`],
      belly: [at('<path d="M-4-3h8l-1.5 4 3.5 11-6 5-6-5 3.5-11z" fill="#1e3a8a"/>', cx, cy + B.ry * 0.45)],
      top: [at('<path d="M-13 2v-14l6.5 6.5L0-15l6.5 9.5L13-12V2z" fill="#fbbf24"/><circle cy="-4" r="2.6" fill="#ef4444"/>', cx, t + 2)],
    }),
  },
  {
    id: 'walnut', label: 'Sprout', color: 11, mouth: 'smile', draw: () => ({
      belly: [
        `<path d="M${cx} ${n(t + 1)}v${n(B.ry * 0.55)}" stroke="#e8c39e" stroke-width="3" stroke-linecap="round"/>`,
        `<path d="M${n(cx - rx * 0.62)} ${cy - 8}q-4 10 1 20M${n(cx + rx * 0.62)} ${cy - 8}q4 10-1 20" stroke="#a36f3f" stroke-width="2.6" fill="none" stroke-linecap="round"/>`,
      ],
      top: [at('<path d="M0 1q0-7 4-10" stroke="#16a34a" stroke-width="2.6" stroke-linecap="round" fill="none"/><ellipse cx="8" cy="-10" rx="6.5" ry="3.6" transform="rotate(-28 8 -10)" fill="#4ade80"/><ellipse cx="-5" cy="-7" rx="5" ry="3" transform="rotate(30 -5 -7)" fill="#22c55e"/>', cx, t + 1)],
    }),
  },
  {
    id: 'sailor', label: 'Sailor', color: 1, mouth: 'smile', draw: (clip) => ({
      belly: [
        `<path d="M${n(cx - rx - 2)} ${n(bot - 7)}q6-5 12 0t12 0 12 0 12 0 12 0 12 0 12 0V${n(bot + 4)}H${n(cx - rx - 2)}z" fill="#fff" opacity=".85" clip-path="url(#${clip})"/>`,
        at('<circle cy="-7" r="3" fill="none" stroke="#1e3a8a" stroke-width="2.2"/><path d="M0-4v13M-6 0h12M-8 4q8 9 16 0" stroke="#1e3a8a" stroke-width="2.4" fill="none" stroke-linecap="round"/>', cx + rx * 0.5, cy + 7, K * 0.9),
      ],
      top: [at('<path d="M-13 3a13 11 0 0 1 26 0z" fill="#fff"/><rect x="-16" y="1" width="32" height="5" rx="2.5" fill="#1e3a8a"/><circle cy="-9" r="2.6" fill="#1e3a8a"/>', cx, t + 1)],
    }),
  },
  {
    id: 'robot', label: 'Robot', color: 2, mouth: 'smile', draw: () => ({
      back: [`<rect x="${n(cx - rx - 5)}" y="${n(fy - 7)}" width="8" height="15" rx="3" fill="#7c3aed"/><rect x="${n(cx + rx - 3)}" y="${n(fy - 7)}" width="8" height="15" rx="3" fill="#7c3aed"/>`],
      belly: [at('<rect x="-11" y="-5" width="22" height="10" rx="4" fill="#ede9fe"/><circle cx="-5" r="2" fill="#f472b6"/><circle r="2" fill="#facc15"/><circle cx="5" r="2" fill="#4ade80"/>', cx, cy + B.ry * 0.55)],
      top: [at(`<path d="M0 1v-11" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><circle cy="-12" r="4" fill="#facc15"/>`, cx, t + 1)],
    }),
  },
  {
    id: 'house', label: 'House', color: 3, mouth: 'cat', draw: () => ({
      belly: [at('<path d="M0 7c-9-6-9-13-4.6-13 2 0 3.8 1.5 4.6 3 .8-1.5 2.6-3 4.6-3 4.4 0 4.4 7-4.6 13z" fill="#fff" opacity=".85"/>', cx + rx * 0.5, cy + 9)],
      top: [at('<path d="M-22 6L0-14 22 6z" fill="#be185d"/><rect x="9" y="-14" width="6" height="12" fill="#9d174d"/>', cx, t + 5)],
    }),
  },
  {
    id: 'mailbox', label: 'Mailbox', color: 4, mouth: 'smile', draw: () => ({
      back: [`<path d="M${n(cx + rx - 4)} ${cy}v-26" stroke="#7f1d1d" stroke-width="3"/><path d="M${n(cx + rx - 4)} ${cy - 26}h12v8h-12z" fill="#ef4444"/>`],
      belly: [at('<rect x="-12" y="-2" width="24" height="4.5" rx="2.2" fill="#14532d"/>', cx, cy + B.ry * 0.5)],
      top: [at('<rect x="-11" y="-14" width="22" height="15" rx="2.5" fill="#fff"/><path d="M-10-13l10 7 10-7" stroke="#16a34a" stroke-width="2" fill="none" stroke-linejoin="round"/>', cx - rx * 0.45, t + 3)],
    }),
  },
  {
    id: 'party', label: 'Party', color: 5, mouth: 'open', draw: () => ({
      belly: [[-0.55, 0.2, '#f472b6'], [0.5, 0.35, '#60a5fa'], [-0.2, 0.6, '#4ade80'], [0.25, 0.05, '#fb923c']]
        .map(([dx, dy, c]) => `<circle cx="${n(cx + rx * (dx as number))}" cy="${n(cy + B.ry * (dy as number) + 6)}" r="2.6" fill="${c}"/>`),
      top: [
        at('<path d="M0-9l2.6 5.6 6 .7-4.5 4.1 1.2 6L0 4.4-5.3 7.4l1.2-6-4.5-4.1 6-.7z" fill="#fff"/>', cx + rx * 0.62, cy + 8),
        at('<path d="M-7 3l7-18 7 18z" fill="#f472b6"/><circle cy="-16" r="3" fill="#60a5fa"/><path d="M-5-2h10M-3-8h6" stroke="#fff" stroke-width="1.6"/>', cx, t + 1),
      ],
    }),
  },
  {
    id: 'pigeon', label: 'Pigeon', color: 6, mouth: 'smile', draw: () => ({
      back: [`<ellipse cx="${n(cx - rx + 1)}" cy="${cy + 4}" rx="9" ry="13" transform="rotate(25 ${n(cx - rx + 1)} ${cy + 4})" fill="#99f6e4"/><ellipse cx="${n(cx + rx - 1)}" cy="${cy + 4}" rx="9" ry="13" transform="rotate(-25 ${n(cx + rx - 1)} ${cy + 4})" fill="#99f6e4"/>`],
      top: [
        at('<path d="M-14 3a14 10 0 0 1 28 0z" fill="#1e3a8a"/><rect x="-16" y="1" width="32" height="5" rx="2.5" fill="#172554"/><circle cy="-3" r="2.4" fill="#facc15"/>', cx, t + 1),
        at('<path d="M-2-4l26-9-11 22-4-8z" fill="#0f766e"/><path d="M9 1l15-14" stroke="#ccfbf1" stroke-width="1.6"/>', cx + rx * 0.35, t + 2, K * 0.9),
      ],
    }),
  },
  {
    id: 'clock', label: 'Alarm clock', color: 7, mouth: 'o', draw: () => ({
      back: [-1, 1].map((s) => `<circle cx="${n(cx + s * rx * 0.62)}" cy="${n(t + 3)}" r="${n(7 * K)}" fill="#fbbf24"/>`),
      belly: [at(`<circle r="10.5" fill="#fff"/><path d="M0-6.5v6.5l4.5 3" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" fill="none"/>`, cx, cy + B.ry * 0.5)],
    }),
  },
  {
    id: 'owl', label: 'Owl', color: 8, mouth: 'flat', draw: () => ({
      back: [`<path d="M${n(cx - rx * 0.62)} ${n(t + 8)}l-4-14 13 8zM${n(cx + rx * 0.62)} ${n(t + 8)}l4-14-13 8z" fill="#4f46e5"/>`],
      belly: [
        at('<path d="M-8 0l4 4 4-4 4 4 4-4M-6 7l3 3 3-3 3 3 3-3" stroke="#e0e7ff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', cx, cy + B.ry * 0.5),
        at('<path d="M-3 0h6l-3 4z" fill="#f59e0b"/>', cx, fy + 6, 1),
        `<circle cx="${n(cx - EYE_GAP)}" cy="${n(fy)}" r="${lensR}" fill="#fff" opacity=".55" stroke="${INK}" stroke-width="2.2"/><circle cx="${n(cx + EYE_GAP)}" cy="${n(fy)}" r="${lensR}" fill="#fff" opacity=".55" stroke="${INK}" stroke-width="2.2"/><path d="M${n(cx - EYE_GAP + lensR)} ${n(fy)}H${n(cx + EYE_GAP - lensR)}" stroke="${INK}" stroke-width="2.2"/>`,
      ],
    }),
  },
  {
    id: 'headset', label: 'Headset', color: 9, mouth: 'smile', draw: () => {
      const w = rx + 2;
      return {
        top: [
          `<path d="M${n(cx - w + 3)} ${n(fy + 2)}a${n(w - 3)} ${n(w - 3)} 0 0 1 ${n(2 * w - 6)} 0" stroke="${INK}" stroke-width="3.6" fill="none"/>`,
          `<rect x="${n(cx - w - 1)}" y="${n(fy - 4)}" width="10" height="15" rx="3.5" fill="${INK}"/><rect x="${n(cx + w - 9)}" y="${n(fy - 4)}" width="10" height="15" rx="3.5" fill="${INK}"/>`,
          `<path d="M${n(cx + w - 3)} ${n(fy + 8)}q0 10-12 12" stroke="${INK}" stroke-width="2.4" fill="none"/><circle cx="${n(cx + w - 16)}" cy="${n(fy + 20)}" r="3" fill="${INK}"/>`,
        ],
      };
    },
  },
  {
    id: 'detective', label: 'Detective', color: 10, mouth: 'flat', draw: () => ({
      top: [
        at('<path d="M-10-7h20v5a2.5 2.5 0 0 0 0 5v5h-20v-5a2.5 2.5 0 0 0 0-5z" fill="#fff"/><path d="M-4 0h8" stroke="#0369a1" stroke-width="2" stroke-dasharray="2 2"/>', cx + rx * 0.55, cy + 10),
        at('<circle r="7" fill="#e0f2fe" stroke="#0c4a6e" stroke-width="2.6"/><path d="M5 5l6 6" stroke="#0c4a6e" stroke-width="3.2" stroke-linecap="round"/>', cx - rx * 0.55, cy + 10),
        at('<path d="M-12 2a12 9 0 0 1 24 0z" fill="#0c4a6e"/><rect x="-1" y="-9" width="14" height="4" rx="2" fill="#0c4a6e" transform="rotate(8)"/>', cx, t + 1),
      ],
    }),
  },
  {
    id: 'scholar', label: 'Scholar', color: 12, mouth: 'smile', draw: () => ({
      belly: [at('<path d="M-12-6h11v14h-11zM1-6h11v14H1z" fill="#fff"/><path d="M0-6v14" stroke="#86198f" stroke-width="1.6"/>', cx, cy + B.ry * 0.5, 1)],
      top: [at('<path d="M-17-2L0-9l17 7L0 5z" fill="#3b0764"/><path d="M-9 1v6q9 5 18 0V1" fill="#581c87"/><path d="M14-1v9" stroke="#facc15" stroke-width="1.8"/>', cx, t + 1)],
    }),
  },
  {
    id: 'painter', label: 'Painter', color: 13, mouth: 'smile', draw: () => ({
      belly: [at('<path d="M-3 9l10-14 3 2-10 14z" fill="#92400e"/><path d="M7-5l3-5 3 7z" fill="#ef4444"/>', cx + rx * 0.5, cy + 6)],
      top: [at('<ellipse rx="16" ry="5.5" fill="#dc2626"/><circle cy="-6" r="2.2" fill="#dc2626"/>', cx - 4, t + 2)],
    }),
  },
  {
    id: 'guard', label: 'Guard', color: 1, mouth: 'flat', draw: () => ({
      belly: [at('<path d="M0-9l8 3v5c0 6-4 9-8 11-4-2-8-5-8-11v-5z" fill="#fff"/><path d="M-3 0l2.5 2.5L4-2" stroke="#1d4ed8" stroke-width="2" fill="none" stroke-linecap="round"/>', cx + rx * 0.52, cy + 8, 1)],
      top: [at('<path d="M-15 3a15 13 0 0 1 30 0z" fill="#334155"/><rect x="-17" y="1" width="34" height="4.5" rx="2" fill="#1e293b"/><rect x="-2" y="-11" width="4" height="9" rx="2" fill="#facc15"/>', cx, t + 1)],
    }),
  },
  {
    id: 'chef', label: 'Chef', color: 7, mouth: 'open', draw: () => ({
      belly: [at('<circle r="6" fill="#fff"/><circle r="3" fill="#facc15"/>', cx - rx * 0.5, cy + 9, 1)],
      top: [at('<circle cx="-7" cy="-8" r="6.5" fill="#fff"/><circle cx="0" cy="-11" r="7" fill="#fff"/><circle cx="7" cy="-8" r="6.5" fill="#fff"/><rect x="-11" y="-6" width="22" height="9" rx="2" fill="#fff"/><path d="M-11 0h22" stroke="#e2e8f0" stroke-width="1.6"/>', cx, t + 2)],
    }),
  },
];

const BY_ID = new Map(AVATAR_CHARACTERS.map((c) => [c.id, c]));

export function avatarCharacter(id: string): Character | undefined { return BY_ID.get(id); }

function blobPath(): string {
  const kt = 0.6, kb = 0.78, { ry } = B;
  return `M${cx} ${n(cy - ry)}`
    + `C${n(cx + rx * kt)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * kt)} ${n(cx + rx)} ${n(cy + ry * 0.05)}`
    + `C${n(cx + rx)} ${n(cy + ry * kb)} ${n(cx + rx * kb)} ${n(cy + ry)} ${cx} ${n(cy + ry)}`
    + `C${n(cx - rx * kb)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * kb)} ${n(cx - rx)} ${n(cy + ry * 0.05)}`
    + `C${n(cx - rx)} ${n(cy - ry * kt)} ${n(cx - rx * kt)} ${n(cy - ry)} ${cx} ${n(cy - ry)}Z`;
}
const BLOB = blobPath();

function face(mouth: Mouth): string {
  const ex1 = cx - EYE_GAP, ex2 = cx + EYE_GAP, y = fy + 9;
  const eyes = `<ellipse cx="${n(ex1)}" cy="${n(fy)}" rx="3.3" ry="4.3" fill="${INK}"/><ellipse cx="${n(ex2)}" cy="${n(fy)}" rx="3.3" ry="4.3" fill="${INK}"/>`;
  const blush = `<ellipse cx="${n(ex1 - 6)}" cy="${n(fy + 8)}" rx="4.4" ry="2.6" fill="#fff" opacity=".45"/><ellipse cx="${n(ex2 + 6)}" cy="${n(fy + 8)}" rx="4.4" ry="2.6" fill="#fff" opacity=".45"/>`;
  const m: Record<Mouth, string> = {
    smile: `<path d="M${cx - 7} ${n(y - 1)}q7 7 14 0" stroke="${INK}" stroke-width="3" stroke-linecap="round" fill="none"/>`,
    open: `<path d="M${cx - 6} ${n(y - 1)}h12q-1 8-6 8t-6-8z" fill="${INK}"/>`,
    cat: `<path d="M${cx - 7} ${n(y)}q3.5 4 7 0q3.5 4 7 0" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" fill="none"/>`,
    flat: `<path d="M${cx - 4} ${n(y + 1)}h8" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
    o: `<ellipse cx="${cx}" cy="${n(y + 1.5)}" rx="3" ry="3.6" fill="${INK}"/>`,
  };
  return eyes + blush + m[mouth];
}

/** A preset is "<character>:<colour index>", e.g. "sailor:1". */
export function presetId(character: string, color: number): string { return `${character}:${color}`; }

export function parsePreset(id: string): { character: Character; color: number } | null {
  const m = /^([a-z]+):(\d{1,2})$/.exec(id);
  const character = m ? BY_ID.get(m[1]!) : undefined;
  const color = m ? Number(m[2]) : -1;
  return character && color >= 0 && color < AVATAR_COLORS.length ? { character, color } : null;
}

/**
 * The SVG of a preset. `uid` keeps clip ids apart when several are inlined in one page (the app
 * shows them as <img>, where ids never clash; the default covers that).
 */
export function presetSvg(id: string, uid = 'a'): string | null {
  const p = parsePreset(id);
  if (!p) return null;
  const { body, bg } = AVATAR_COLORS[p.color]!;
  const clip = `oa-${uid}`, bodyClip = `oab-${uid}`;
  const l = p.character.draw(bodyClip);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">',
    `<defs><clipPath id="${clip}"><rect width="100" height="100" rx="22"/></clipPath><clipPath id="${bodyClip}"><path d="${BLOB}"/></clipPath></defs>`,
    `<g clip-path="url(#${clip})"><rect width="100" height="100" fill="${bg}"/><g transform="rotate(-4 50 60)">`,
    ...(l.back ?? []),
    `<path d="${BLOB}" transform="translate(2.5 3)" fill="${INK}" opacity=".12"/>`,
    `<path d="${BLOB}" fill="${body}"/>`,
    `<path d="M${n(cx - rx * 0.55)} ${n(t + B.ry * 0.35)}q${n(rx * 0.25)}-${n(B.ry * 0.3)} ${n(rx * 0.6)}-${n(B.ry * 0.32)}" stroke="#fff" stroke-width="3" opacity=".3" fill="none" stroke-linecap="round"/>`,
    ...(l.belly ?? []),
    face(p.character.mouth),
    ...(l.top ?? []),
    '</g></g></svg>',
  ].join('');
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
