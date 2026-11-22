/**
 * The header rule (components/common/HeaderFit.tsx): a header row's buttons never press on its
 * title. 2026-11-21, the user on the Org list ("ui is shit now what the fuck?"): "New router",
 * "Org chart" and the gear squeezed the title "Org" to one clipped letter in a 220 px column.
 *
 * Every header row in web/src (header-fit-scan.ts: a `*-head` / `*-header` / `<header>` element
 * holding a title and a button) is either on the shared rule (`data-fit-header`, set with
 * useHeaderFit) or counted in header-fit-baseline.json, per file. A new row off the rule fails;
 * a fix lowers the count with `HEADER_FIT_RECORD=1` on this file. The page itself is swept at
 * every width by tests/e2e/browser/header-fit-sweep.spec.ts. A row that can never crush its title
 * (a fixed-width box, a row whose text is not a title) is listed with its reason in
 * header-fit-exempt.ts instead.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allHeaderRows, headerRowsIn, offRuleCounts, rowKey } from './header-fit-scan';
import { HEADER_FIT_EXEMPT } from './header-fit-exempt';

const BASELINE = path.join(__dirname, 'header-fit-baseline.json');

describe('header rows: title and buttons never overlap', () => {
  const rows = allHeaderRows();
  const now = offRuleCounts(rows, HEADER_FIT_EXEMPT);
  if (process.env.HEADER_FIT_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number>;

  it('a new header row uses the shared rule (useHeaderFit, data-fit-title, FitButton)', () => {
    const grew = Object.entries(now).filter(([f, n]) => n > (was[f] ?? 0)).map(([f, n]) => {
      const at = rows.filter((r) => r.file === f && !r.onRule).map((r) => `${r.className}:${r.line}`).join(', ');
      return `web/src/${f} has ${n} header row(s) off the rule (was ${was[f] ?? 0}): ${at}`;
    });
    expect(grew, `Put the header on components/common/HeaderFit.tsx:\n${grew.join('\n')}`).toEqual([]);
  });

  it('the baseline follows every fix', () => {
    const fell = Object.entries(was).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `web/src/${f}: ${now[f] ?? 0} (baseline ${n})`);
    expect(fell, `Fewer than recorded: good. Lower the baseline with\nHEADER_FIT_RECORD=1 bun --bun vitest run tests/web/header-fit-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
  });

  it('every exemption names a row still off the rule, with its reason', () => {
    const off = new Set(rows.filter((r) => !r.onRule).map(rowKey));
    const stale = Object.keys(HEADER_FIT_EXEMPT).filter((k) => !off.has(k));
    expect(stale, 'These exempt rows are gone or on the rule now: drop them from header-fit-exempt.ts').toEqual([]);
    const thin = Object.entries(HEADER_FIT_EXEMPT).filter(([, why]) => why.trim().length < 40).map(([k]) => k);
    expect(thin, 'Say why the row can never crush its title').toEqual([]);
  });

  it('the headers the user named are on the rule', () => {
    const on = (file: string, cls: string) => rows.find((r) => r.file === file && r.className === cls)?.onRule;
    expect(on('components/org/OrgChannelList.tsx', 'org-list-head')).toBe(true);
  });

  it('finds each shape of a header row', () => {
    const one = (src: string) => headerRowsIn('x.tsx', src);
    expect(one('<div className="a-head"><h2>T</h2><button>x</button></div>')).toHaveLength(1);
    expect(one('<header className="b"><span className="b-title">T</span><SettingsButton /></header>')).toHaveLength(1);
    expect(one('<div className="a-head" data-fit-header=""><h2>T</h2><button onClick={() => go()}>x</button></div>')[0].onRule).toBe(true);
    expect(one('<div className="a-head"><h2>Title only</h2></div>')).toHaveLength(0);
    expect(one('<div className="a-head"><button>x</button><button>y</button></div>')).toHaveLength(0);
    // Nested elements of the same tag close at the right place.
    expect(one('<div className="a-head"><div><h2>T</h2></div></div><div><button /></div>')).toHaveLength(0);
  });
});
