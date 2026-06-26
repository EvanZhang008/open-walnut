/**
 * Match a CWD path to a registered repository.
 *
 * Scans ~/.open-walnut/repositories/*.yaml and matches the CWD against
 * each repo's host paths. Uses longest-prefix matching.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORIES_DIR } from '../constants.js';

export interface RepoMatch {
  name: string;
  slug: string;
  description?: string;
  tech_stack?: string;
  overview?: string;
  architecture?: string;
  architecture_notes?: string;
  common_commands?: string;
}

/**
 * Find a repository whose host path matches the given CWD.
 * Optionally filter by host label (e.g. 'local', 'cloud-desktop').
 *
 * Returns the best match (longest prefix) or undefined.
 */
export function findRepoByPath(cwd: string, host?: string): RepoMatch | undefined {
  if (!cwd || !fs.existsSync(REPOSITORIES_DIR)) return undefined;

  const normalizedCwd = normalizePath(cwd);
  let bestMatch: RepoMatch | undefined;
  let bestLength = 0;

  try {
    const files = fs.readdirSync(REPOSITORIES_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(REPOSITORIES_DIR, f), 'utf-8');
        const parsed = parseRepoYaml(content);
        if (!parsed) continue;

        const slug = f.replace(/\.ya?ml$/, '');

        // Check each host's path
        for (const [hostLabel, hostInfo] of Object.entries(parsed.hosts)) {
          if (host && hostLabel !== host) continue;
          if (!hostInfo.path) continue;

          const hostPath = normalizePath(hostInfo.path);
          if (normalizedCwd.startsWith(hostPath) && hostPath.length > bestLength) {
            bestLength = hostPath.length;
            bestMatch = {
              name: parsed.name || slug,
              slug,
              description: parsed.description,
              tech_stack: parsed.tech_stack,
              overview: parsed.overview,
              architecture: parsed.architecture,
              architecture_notes: parsed.architecture_notes,
              common_commands: parsed.common_commands,
            };
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // repositories/ doesn't exist
  }

  return bestMatch;
}

function normalizePath(p: string): string {
  // Ensure trailing slash for prefix matching (so /foo doesn't match /foobar)
  const resolved = path.resolve(p);
  return resolved.endsWith('/') ? resolved : resolved + '/';
}

interface ParsedRepo {
  name?: string;
  description?: string;
  tech_stack?: string;
  overview?: string;
  architecture?: string;
  architecture_notes?: string;
  common_commands?: string;
  hosts: Record<string, { path?: string }>;
}

/**
 * Lightweight YAML parser for repo files — extracts key fields without a full YAML dependency.
 */
function parseRepoYaml(content: string): ParsedRepo | undefined {
  const lines = content.split('\n');
  const result: ParsedRepo = { hosts: {} };

  let currentSection: string | null = null;
  let currentHost: string | null = null;
  let multilineKey: string | null = null;
  let multilineValue: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Flush multiline value when we hit a non-indented line
    if (multilineKey && trimmed && !line.startsWith(' ') && !line.startsWith('\t')) {
      (result as unknown as Record<string, unknown>)[multilineKey] = multilineValue.join('\n').trim();
      multilineKey = null;
      multilineValue = [];
    }

    // Collect multiline value
    if (multilineKey) {
      multilineValue.push(trimmed);
      continue;
    }

    // Top-level keys
    if (trimmed.startsWith('name:')) {
      result.name = extractValue(trimmed, 'name:');
      currentSection = null;
      currentHost = null;
    } else if (trimmed.startsWith('description:')) {
      const val = extractValue(trimmed, 'description:');
      if (val === '|' || val === '>') {
        multilineKey = 'description';
        multilineValue = [];
      } else {
        result.description = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (trimmed.startsWith('tech_stack:')) {
      const val = extractValue(trimmed, 'tech_stack:');
      if (val.startsWith('[')) {
        // Inline array: [TypeScript, React]
        result.tech_stack = val.replace(/[\[\]]/g, '').trim();
      } else {
        result.tech_stack = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (trimmed === 'hosts:') {
      currentSection = 'hosts';
      currentHost = null;
    } else if (trimmed.startsWith('overview:')) {
      const val = extractValue(trimmed, 'overview:');
      if (val === '|' || val === '>') {
        multilineKey = 'overview';
        multilineValue = [];
      } else {
        result.overview = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (trimmed.startsWith('architecture:') && !trimmed.startsWith('architecture_notes:')) {
      const val = extractValue(trimmed, 'architecture:');
      if (val === '|' || val === '>') {
        multilineKey = 'architecture';
        multilineValue = [];
      } else {
        result.architecture = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (trimmed.startsWith('architecture_notes:')) {
      const val = extractValue(trimmed, 'architecture_notes:');
      if (val === '|' || val === '>') {
        multilineKey = 'architecture_notes';
        multilineValue = [];
      } else {
        result.architecture_notes = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (trimmed.startsWith('common_commands:')) {
      const val = extractValue(trimmed, 'common_commands:');
      if (val === '|' || val === '>') {
        multilineKey = 'common_commands';
        multilineValue = [];
      } else {
        result.common_commands = val;
      }
      currentSection = null;
      currentHost = null;
    } else if (currentSection === 'hosts') {
      // Host entry: "  local:" or "  cloud-desktop:"
      const hostMatch = trimmed.match(/^  (\S+):$/);
      if (hostMatch) {
        currentHost = hostMatch[1];
        result.hosts[currentHost] = {};
      } else if (currentHost) {
        // Host property: "    path: /some/path"
        const pathMatch = trimmed.match(/^\s+path:\s*(.+)/);
        if (pathMatch) {
          result.hosts[currentHost].path = pathMatch[1].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  }

  // Flush final multiline value
  if (multilineKey) {
    (result as unknown as Record<string, unknown>)[multilineKey] = multilineValue.join('\n').trim();
  }

  // Must have at least one host to be useful
  if (Object.keys(result.hosts).length === 0) return undefined;

  return result;
}

function extractValue(line: string, prefix: string): string {
  return line.slice(prefix.length).trim().replace(/^["']|["']$/g, '');
}
