/**
 * Ratchet: a helper that can be PROMPTED for must declare the matching
 * hardened-runtime entitlement.
 *
 * This exists because the bug it pins was silent and unfixable from the UI.
 * src/core/helper-build.ts signs with `--options runtime`, and under the hardened
 * runtime tccd will not show a TCC prompt for a binary that does not declare the
 * entitlement for that service. It tells nobody: the request returns denied while
 * the authorization status stays notDetermined, so the permission panel says "not
 * asked yet" forever and no button can change it. The only evidence was in tccd's
 * own log:
 *
 *   Prompting policy for hardened runtime; service: kTCCServiceCalendar requires
 *   entitlement com.apple.security.personal-information.calendars but it is
 *   missing for accessing={identifier=dev.openwalnut.calendar…}
 *
 * The trap is that this only appears once a helper becomes certificate-signed. An
 * ad-hoc binary gets tccd's lax policy and prompts fine, so adding real signing
 * (otherwise a strict improvement, because it makes grants survive rebuilds) took
 * the promptable helpers from working to permanently ungrantable.
 *
 * The pair is DERIVED, not hardcoded: a helper needs a prompt exactly when its
 * embedded Info.plist carries a *UsageDescription key, because that string exists
 * only to caption a system dialog. So any module with a usage description must
 * also name the entitlement for that service.
 *
 * Reading the source text rather than the spec objects is deliberate. The specs
 * are module-private, and exporting them just for a test would invite production
 * code to reach into another module's signing details.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');

/** Usage-description key → the entitlement tccd demands before it will prompt. */
const PROMPT_ENTITLEMENT: Record<string, string> = {
  NSCalendarsFullAccessUsageDescription: 'com.apple.security.personal-information.calendars',
  NSCalendarsUsageDescription: 'com.apple.security.personal-information.calendars',
  NSRemindersFullAccessUsageDescription: 'com.apple.security.personal-information.reminders',
  NSAppleEventsUsageDescription: 'com.apple.security.automation.apple-events',
  NSContactsUsageDescription: 'com.apple.security.personal-information.addressbook',
  NSMicrophoneUsageDescription: 'com.apple.security.device.audio-input',
  NSCameraUsageDescription: 'com.apple.security.device.camera',
  NSLocationUsageDescription: 'com.apple.security.personal-information.location',
};

/** Every module that declares a HelperSpec. A new helper joins this list, and
 *  the first test fails loudly if one of these paths is ever moved. */
const SPEC_FILES = [
  'src/core/calendar/sources/eventkit.ts',
  'src/core/time-tracking/outside-collector.ts',
  'src/core/time-tracking/screentime-reader.ts',
  'src/core/attachment-text.ts',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf-8');
}

describe('promptable helpers declare their hardened-runtime entitlement', () => {
  it('the signer still supports entitlements, and every spec module exists', () => {
    expect(read('src/core/helper-build.ts')).toContain('--entitlements');
    for (const file of SPEC_FILES) {
      expect(fs.existsSync(path.join(REPO, file)), `${file} moved or was removed`).toBe(true);
    }
  });

  for (const file of SPEC_FILES) {
    it(`${file}: a usage description implies its entitlement`, () => {
      const text = read(file);
      for (const [usageKey, entitlement] of Object.entries(PROMPT_ENTITLEMENT)) {
        if (!text.includes(usageKey)) continue;
        expect(
          text.includes(entitlement),
          `${file} embeds ${usageKey}, so this helper gets prompted for, but the spec does not `
          + `declare ${entitlement}. Under the hardened runtime tccd then refuses to show the `
          + 'prompt at all and the permission can never be granted, with nothing reported to the '
          + "caller. Add it to the spec's `entitlements` array.",
        ).toBe(true);
      }
    });
  }

  it('the two helpers that actually broke are covered by name', () => {
    // Belt to the braces above: a refactor that moves a plist out of these files
    // must not make the check silently vacuous.
    expect(read('src/core/calendar/sources/eventkit.ts'))
      .toContain('com.apple.security.personal-information.calendars');
    expect(read('src/core/time-tracking/outside-collector.ts'))
      .toContain('com.apple.security.automation.apple-events');
  });
});
