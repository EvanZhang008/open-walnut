/**
 * The skills index a session's prompt carries, parsed for the Context Inspector. Two forms:
 * the one-line index (src/core/skill-loader.ts formatSessionIndex: a preamble, then an
 * "In <folder>:" line per folder and "- <dir>: <line>" per skill) and the XML index the
 * rollback switch and the loop prompt still use (<available_skills> with <category> and
 * <skill> elements). Pure, so a test reads both.
 */
export interface ParsedSkill {
  name: string;
  /** '' in the one-line form, which names no type. */
  type: string;
  description: string;
  location: string;
}

export interface ParsedSkillsIndex {
  preamble: string;
  categories: Array<{ name: string; skills: ParsedSkill[] }>;
}

export function parseSkillsIndex(content: string, parseXml?: (xml: string) => Document): ParsedSkillsIndex | null {
  // lastIndexOf: the preamble TEXT mentions "<available_skills>"; the real block is the last one.
  const xmlStart = content.lastIndexOf('<available_skills>');
  if (xmlStart !== -1 && parseXml) return parseXmlIndex(content, xmlStart, parseXml);
  return parseLineIndex(content);
}

function parseXmlIndex(content: string, xmlStart: number, parseXml: (xml: string) => Document): ParsedSkillsIndex | null {
  try {
    const doc = parseXml(content.slice(xmlStart));
    if (doc.querySelector('parsererror')) return null;
    const categories = [...doc.querySelectorAll('category')].map((cat) => ({
      name: cat.getAttribute('name') ?? 'general',
      skills: [...cat.querySelectorAll('skill')].map((s): ParsedSkill => ({
        name: s.querySelector('name')?.textContent ?? '',
        type: s.querySelector('type')?.textContent ?? '',
        description: s.querySelector('description')?.textContent ?? '',
        location: s.querySelector('location')?.textContent ?? '',
      })),
    }));
    return { preamble: content.slice(0, xmlStart).trim(), categories };
  } catch {
    return null;
  }
}

const FOLDER_LINE = /^In (.+):$/;
const SKILL_LINE = /^- ([^:\s][^:]*): (.*)$/;

function parseLineIndex(content: string): ParsedSkillsIndex | null {
  const lines = content.split('\n');
  const first = lines.findIndex((l) => FOLDER_LINE.test(l.trim()));
  if (first === -1) return null;
  const categories: ParsedSkillsIndex['categories'] = [];
  let root = '';
  for (const raw of lines.slice(first)) {
    const line = raw.trim();
    const folder = FOLDER_LINE.exec(line);
    if (folder) {
      root = folder[1]!;
      categories.push({ name: root, skills: [] });
      continue;
    }
    const skill = SKILL_LINE.exec(line);
    if (skill && categories.length) {
      const name = skill[1]!.trim();
      categories[categories.length - 1]!.skills.push({ name, type: '', description: skill[2]!.trim(), location: `${root}/${name}/SKILL.md` });
    }
  }
  if (!categories.some((c) => c.skills.length)) return null;
  return { preamble: lines.slice(0, first).join('\n').trim(), categories };
}
