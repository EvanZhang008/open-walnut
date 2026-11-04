/**
 * The words of the cloud companion's Updates row (CompanionUpdatesRow.tsx), one
 * sentence per state of the server's companion build view.
 */
import type { CompanionBuildView } from '@/api/companion-build';
import { timeAgo } from '@/utils/time';

const noPeriod = (text: string) => text.trim().replace(/[.\s]+$/, '');

/** The build last seen and how long ago, while the server has not looked yet or could not ('' if none). */
function lastSeenText(v: CompanionBuildView, now: number): string {
  const seen = v.lastSeen;
  if (!seen) return '';
  const own = v.mine && seen.theirs === v.mine ? ' (this Mac\'s build)' : '';
  return `last seen running ${seen.theirs}${own}, ${timeAgo(new Date(seen.at).toISOString(), { long: true, now })}`;
}

/** The row's sentence for each state. */
export function companionUpdatesSentence(v: CompanionBuildView, now = Date.now()): string {
  const seen = lastSeenText(v, now);
  switch (v.state) {
    case 'off':
      return v.message ?? 'Off: the companion keeps the build it has.';
    case 'no_companion':
      return 'This Mac has no link to the companion to send builds over.';
    case 'checking':
      return seen ? `${seen[0]!.toUpperCase()}${seen.slice(1)}; checking again.` : 'Checking which build the companion runs.';
    case 'current':
      return v.mine ? `Runs this Mac's build (${v.mine}).` : 'Runs this Mac\'s build.';
    case 'updating': {
      const step = v.step === 'installing' ? 'installing'
        : v.step === 'starting' ? 'starting'
        : `uploading ${Math.round((v.progress ?? 0) * 100)}%`;
      const head = `Updating to this Mac's build: ${step}.`;
      return v.message ? `${head} Paused (${noPeriod(v.message)}); it goes on at the next check.` : head;
    }
    case 'failed': {
      const target = v.mine ? `The update to ${v.mine} failed` : 'The update failed';
      const why = v.message ? `: ${noPeriod(v.message)}` : '';
      const keeps = v.theirs ? `It keeps running ${v.theirs}.` : 'It keeps running the build it has.';
      return `${target}${why}. ${keeps}`;
    }
    case 'unmanaged':
      return 'Update it once with the cloud setup script; after that it follows this Mac.';
    case 'box_off':
      return v.message === 'launcher_absent'
        ? 'The companion does not take builds from this Mac until it is updated once with the cloud setup script.'
        : 'The companion does not take builds from this Mac (turned off on the box).';
    case 'refused_credential':
      return 'The companion did not accept this Mac\'s credential; Walnut asks again in 10 minutes.';
    case 'unreachable':
      return seen
        ? `Could not reach the companion just now; ${seen}. Walnut tries again in a few minutes.`
        : 'Could not reach the companion to check its build; Walnut tries again in a few minutes.';
  }
}
