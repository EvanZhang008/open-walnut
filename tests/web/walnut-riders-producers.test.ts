/**
 * The rider list (history-walnut-riders.ts RIDER_NOTICE_OUTCOMES) is closed, so
 * it must name every note the queue actually puts in front of a message. On
 * 2026-10-29 the status push joined the queue's notes without joining the list,
 * and a person's words behind it were drawn inside the notice's card, on the web
 * and on the phone. This pins the three together: the notes the queue prepends,
 * the outcome each producer writes, and the list on both surfaces.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RIDER_NOTICE_OUTCOMES, splitLeadingRiders } from '@open-walnut/history-walnut-riders';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Each note the queue prepends: where it is built and the outcome it carries. */
const PRODUCERS: Record<string, { file: string; outcome: string | null }> = {
  place: { file: 'src/core/sessions/place-notice.ts', outcome: 'moved' },
  restart: { file: 'src/core/sessions/restart-notice.ts', outcome: 'restarted' },
  digest: { file: 'src/core/org/org-store.ts', outcome: 'org-update' },
  statusNote: { file: 'src/core/sessions/status-push.ts', outcome: 'status' },
  appState: { file: 'src/core/sessions/app-state.ts', outcome: null },
  waitNote: { file: 'src/core/task-wait-resume.ts', outcome: 'waiting' },
  retiredNote: { file: 'src/core/org/retired-lead.ts', outcome: 'handed-over' },
};

describe('the rider list names every note Walnut puts in front of a message', () => {
  it('the queue prepends exactly the notes this test knows', () => {
    const src = read('src/core/session-message-queue.ts');
    const line = src.match(/const notes = \[([^\]]*)\]/);
    expect(line, 'sendMessageToSession composes its notes as `const notes = [...]`').toBeTruthy();
    const names = line![1].split(',').map((s) => s.trim().replace(/\?\.text$/, '')).filter(Boolean);
    // A new note here also needs its outcome in RIDER_NOTICE_OUTCOMES
    // (src/lib/history-walnut-riders.ts) and TimelineInboundMessage.riderOutcomes (iOS).
    expect(names.sort()).toEqual(Object.keys(PRODUCERS).sort());
  });

  it('each producer writes the outcome the list holds', () => {
    for (const [name, { file, outcome }] of Object.entries(PRODUCERS)) {
      const src = read(file);
      if (outcome === null) {
        expect(src, `${name} builds an app-state envelope`).toMatch(/kind: 'app-state'/);
        continue;
      }
      expect(src.includes(`'${outcome}'`), `${name} (${file}) writes outcome ${outcome}`).toBe(true);
      expect(RIDER_NOTICE_OUTCOMES, name).toContain(outcome);
    }
    // The changed default instructions go first at the queue's drain (instruction-notice.ts).
    expect(read('src/core/sessions/instruction-notice.ts')).toContain("const OUTCOME = 'task-routing-policy'");
    expect(RIDER_NOTICE_OUTCOMES).toContain('task-routing-policy');
  });

  it('iOS keeps the same list', () => {
    const swift = read('ios-native/Walnut/Timeline/TimelineInboundMessage.swift');
    const set = swift.match(/static let riderOutcomes: Set<String> = \[([^\]]*)\]/);
    expect(set, 'TimelineInboundMessage.riderOutcomes').toBeTruthy();
    const ios = [...set![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ios.sort()).toEqual([...RIDER_NOTICE_OUTCOMES].sort());
  });

  it('every outcome on the list splits off a person\'s words', () => {
    for (const outcome of RIDER_NOTICE_OUTCOMES) {
      const note = `<walnut-message kind="notification" from="Walnut" outcome="${outcome}">\nA note.\n</walnut-message>`;
      expect(splitLeadingRiders(`${note}\n\nThe words.`)?.body, outcome).toBe('The words.');
    }
  });
});
