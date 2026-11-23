/**
 * Which avatar each node of the org wears (the CEO, the VPs, the routers, the leaders and their
 * tasks), with no two the same. Browser-safe, so the Org page and the server's PNG route for the
 * phone pick the same one.
 *
 *  1. A picture the user (or an agent) set on the task (Task.org_avatar) wins.
 *  2. Otherwise the default: a character that fits what the node is called (mail -> pigeon,
 *     clock -> alarm clock, watch -> owl ...), in its own colour, or the next free colour when
 *     that pair is taken; a name that fits nothing gets the least used character.
 *
 * Defaults are handed out in two rounds, oldest node first in each (the CEO before everyone):
 * first the nodes that stay (the CEO, the VPs and the routers that are open), then the leaders,
 * which come and go with their open subtasks. A finished VP holds nothing (a real org has many
 * finished ones, merged or retired, and they would take the fitting pairs from the live ones).
 * So a leader that appears or ends never moves a VP's or a router's avatar, and a new node never
 * moves one that was there before it; a rename can change a default, never a chosen one.
 * Once every character and colour pair is taken (224 of them) a pair is used twice.
 */
import { AVATAR_CHARACTERS, AVATAR_COLORS, parsePreset, presetId, presetSvg, svgDataUri } from './avatar-art.js';

/** What a task stores: a preset, or a picture of its own (SVG text or a PNG/JPEG/WebP data URL). */
export interface OrgAvatarValue {
  preset?: string;
  svg?: string;
  image?: string;
  at?: string;
  by?: string;
}

export interface AvatarNode {
  id: string;
  /** The name it shows as (the VP's name, the task's title). */
  name: string;
  main?: boolean;
  /** ISO time it was made; older first. */
  created?: string;
  avatar?: OrgAvatarValue | null;
  /** A leader (it leads while it has open subtasks): handed its default after every lasting node. */
  leader?: boolean;
}

/** What a node shows: an image source for <img>, and the preset it is when it is one. */
export interface AvatarPick { src: string; preset?: string; custom: boolean }

/** Name words that point at a character, tried in order; the first that matches wins. */
const FITS: ReadonlyArray<[RegExp, string]> = [
  [/\b(cron|clock|schedul\w*|timer|daily|weekly|reminder)\b/, 'clock'],
  [/\b(watch\w*|monitor\w*|pipeline\w*|alarm\w*|uptime)\b/, 'owl'],
  [/\b(router|mail|email|inbox mail|post)\b/, 'pigeon'],
  [/\binbox\b/, 'mailbox'],
  [/\b(triage|ticket\w*|bug\w*|issue\w*|incident\w*|sev\d?|support)\b/, 'detective'],
  [/\b(teammate\w*|meeting\w*|call\w*|chat|slack|interview\w*)\b/, 'headset'],
  [/\b(personal|home|family|life|health|private)\b/, 'house'],
  [/(\bai\b|\bbots?\b|\bchatbot\w*|\bagent\w*|\bllm\b|\bgpt\b|\bmodel\w*|\brobot\w*)/, 'robot'],
  [/\b(ship|boat|sea|port|dock\w*|ocean|sail\w*|marine|deploy\w*)\b/, 'sailor'],
  [/\b(walnut|nut|garden|grow\w*|plant\w*)\b/, 'walnut'],
  [/\b(doc\w*|learn\w*|study|research\w*|read\w*|note\w*|paper\w*|course\w*)\b/, 'scholar'],
  [/\b(design\w*|ui|ux|art|draw\w*|icon\w*|avatar\w*|style\w*)\b/, 'painter'],
  [/\b(secur\w*|auth\w*|password\w*|credential\w*|guard\w*|safe\w*|privacy)\b/, 'guard'],
  [/\b(cook\w*|food|recipe\w*|routine\w*|habit\w*|meal\w*)\b/, 'chef'],
  [/\b(others?|misc\w*|everything|random)\b/, 'party'],
];

/** The character a name points at, or undefined. */
export function fittingCharacter(name: string, main = false): string | undefined {
  if (main) return 'ceo';
  // "TeamAI", "OpsAI": a capital AI at the end of a word (never the "ai" of Shanghai or Thai).
  if (/AI(?![a-z])/.test(name)) return 'robot';
  const s = name.toLowerCase().replace(/[-_.:]+/g, ' ');
  return FITS.find(([re]) => re.test(s))?.[1];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** A stored picture: a PNG, JPEG or WebP data URL (its bytes are checked where it is stored). */
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** The <img> source of a stored value, or null when it holds nothing usable. */
export function customSrc(v: OrgAvatarValue | null | undefined): AvatarPick | null {
  if (!v) return null;
  if (v.preset) {
    const svg = presetSvg(v.preset);
    return svg ? { src: svgDataUri(svg), preset: v.preset, custom: true } : null;
  }
  if (v.svg && /^\s*<svg[\s>]/i.test(v.svg)) return { src: svgDataUri(v.svg), custom: true };
  if (v.image && IMAGE_DATA_URL.test(v.image)) return { src: v.image, custom: true };
  return null;
}

/** Every node's avatar, by id. */
export function assignAvatars(nodes: readonly AvatarNode[]): Map<string, AvatarPick> {
  const out = new Map<string, AvatarPick>();
  const taken = new Set<string>();
  const uses = new Map<string, number>();
  const use = (preset: string) => {
    taken.add(preset);
    const c = preset.split(':')[0]!;
    uses.set(c, (uses.get(c) ?? 0) + 1);
  };
  // Chosen ones first: a default never takes a pair someone picked.
  for (const node of nodes) {
    const own = customSrc(node.avatar);
    if (own) { out.set(node.id, own); if (own.preset) use(own.preset); }
  }
  const order = nodes.filter((x) => !out.has(x.id)).slice().sort((a, b) =>
    Number(!!a.leader) - Number(!!b.leader) || Number(!!b.main) - Number(!!a.main) || (a.created ?? '').localeCompare(b.created ?? '') || a.id.localeCompare(b.id));
  const total = AVATAR_CHARACTERS.length * AVATAR_COLORS.length;
  for (const node of order) {
    const fit = fittingCharacter(node.name, node.main);
    const h = hash(node.id);
    const chars = fit ? [fit] : [];
    // Then every character, least used first (ties by the node's own hash, so it is stable).
    const rest = AVATAR_CHARACTERS.map((c) => c.id).filter((c) => c !== fit)
      .sort((a, b) => (uses.get(a) ?? 0) - (uses.get(b) ?? 0) || ((hash(a) ^ h) >>> 0) - ((hash(b) ^ h) >>> 0));
    chars.push(...rest);
    let pick: string | undefined;
    for (const c of chars) {
      const home = AVATAR_CHARACTERS.find((x) => x.id === c)!.color;
      for (let i = 0; i < AVATAR_COLORS.length && !pick; i++) {
        const id = presetId(c, (home + i) % AVATAR_COLORS.length);
        if (!taken.has(id) || taken.size >= total) pick = id;
      }
      // A fitting character in another colour beats another character only while it is free.
      if (pick) break;
    }
    pick ??= presetId(fit ?? 'party', h % AVATAR_COLORS.length);
    use(pick);
    out.set(node.id, { src: svgDataUri(presetSvg(pick)!), preset: pick, custom: false });
  }
  return out;
}

/** Every preset, character by character in its own colour first: the picker's grid. */
export function allPresets(): string[] {
  const own = AVATAR_CHARACTERS.map((c) => presetId(c.id, c.color));
  const others: string[] = [];
  for (const c of AVATAR_CHARACTERS) {
    for (let i = 1; i < AVATAR_COLORS.length; i++) others.push(presetId(c.id, (c.color + i) % AVATAR_COLORS.length));
  }
  return [...own, ...others];
}

/** The task fields the avatars read. */
export interface AvatarTask {
  id: string;
  title: string;
  project?: string;
  org_role?: string;
  org_name?: string;
  phase?: string;
  created_at?: string;
  parent_task_id?: string;
  self_router?: { name?: string } | null;
  org_avatar?: OrgAvatarValue | null;
  /** Made a Director by hand ('yes') even with no team yet (Task.director). */
  director?: string | null;
}

/** The name a node's default is picked by: a VP by its name (or its project), a router by its own. */
export function avatarName(t: AvatarTask): string {
  if (t.org_role === 'main') return 'CEO';
  if (t.org_role === 'lead') return t.org_name?.trim() || t.project || t.title;
  if (t.org_role === 'router') return t.org_name?.trim() || t.title;
  return t.self_router?.name?.trim() || t.title;
}

const open = (t: AvatarTask) => t.phase !== 'COMPLETE';

/** A node that stays: the CEO, a VP, a router (a task that routes by itself too). */
const lasting = (t: AvatarTask) => t.org_role === 'main' || t.org_role === 'lead' || t.org_role === 'router' || !!t.self_router;

/**
 * The org's own nodes, the only ones that wear an avatar (2026-11-23, the user: "只有 leader、
 * director、VP 和 CEO 需要 icon，其他的 task 是不需要 icon 的"): the CEO, the VPs, the routers, the
 * leaders (an open task with an open task under it) and a task made a Director by hand. They never
 * share one. Any other task wears none.
 */
export function orgAvatarNodes(tasks: readonly AvatarTask[]): AvatarNode[] {
  const parents = new Set(tasks.filter((t) => open(t) && t.parent_task_id).map((t) => t.parent_task_id!));
  return tasks.filter((t) => open(t) && (lasting(t) || parents.has(t.id) || t.director === 'yes'))
    .map((t) => ({ id: t.id, name: avatarName(t), main: t.org_role === 'main', created: t.created_at, avatar: t.org_avatar ?? null, leader: !lasting(t) }));
}

/**
 * Who wears what: the org's nodes all differ (`wears` says whether a task is one). `of` still
 * answers for any task (a picture an editor previews, a name with no task yet), avoiding the
 * nodes' pairs, but only a node is drawn.
 */
export function orgAvatars(tasks: readonly AvatarTask[]): { of: (t: AvatarTask) => AvatarPick; wears: (taskId: string) => boolean } {
  const nodes = assignAvatars(orgAvatarNodes(tasks));
  const taken = new Set([...nodes.values()].map((p) => p.preset).filter(Boolean) as string[]);
  return {
    wears: (taskId) => nodes.has(taskId),
    of(t) {
      const known = nodes.get(t.id);
      if (known) return known;
      const own = customSrc(t.org_avatar);
      if (own) return own;
      const fit = fittingCharacter(avatarName(t));
      const h = hash(t.id);
      const c = fit ?? AVATAR_CHARACTERS[h % AVATAR_CHARACTERS.length]!.id;
      let pick = presetId(c, h % AVATAR_COLORS.length);
      for (let i = 0; i < AVATAR_COLORS.length && taken.has(pick); i++) pick = presetId(c, (h + i + 1) % AVATAR_COLORS.length);
      return { src: svgDataUri(presetSvg(pick)!), preset: pick, custom: false };
    },
  };
}

export { parsePreset };
