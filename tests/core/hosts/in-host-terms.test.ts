/**
 * inHostTerms turns a host's key into its name in a sentence a person reads. A label that holds
 * the key ("New big clouddev" for the host clouddev) came out doubled when the sentence already
 * named the host ("Can't reach New big New big clouddev right now", the @ panel, 2026-11-23).
 * The class: turning a sentence into host terms twice must read the same as once.
 */
import { describe, it, expect } from 'vitest';
import { inHostTerms } from '../../../src/core/hosts/host-display-name';

const CASES: Array<{ host: string; label?: string }> = [
  { host: 'clouddev', label: 'New big clouddev' },
  { host: 'clouddev', label: 'clouddev box' },
  { host: 'devbox', label: 'Dev box' },
  { host: 'olddev', label: 'Old small dev' },
  { host: 'spare' },
];

describe('inHostTerms', () => {
  it('names a host once when its label holds its key', () => {
    expect(inHostTerms("Can't reach New big clouddev right now.", 'clouddev', 'New big clouddev'))
      .toBe("Can't reach New big clouddev right now.");
    expect(inHostTerms("Can't reach clouddev right now.", 'clouddev', 'New big clouddev'))
      .toBe("Can't reach New big clouddev right now.");
  });

  it('reads the same applied twice as once, for every kind of label', () => {
    for (const { host, label } of CASES) {
      for (const text of [`Can't reach ${host} right now.`, `ssh ${host}: timed out; ${host} is asleep`, `/srv/${host}/x on ${host}.example.test`]) {
        const once = inHostTerms(text, host, label);
        expect(inHostTerms(once, host, label), `${host} / ${label}: ${text}`).toBe(once);
      }
    }
  });

  it('still leaves a path and a hostname alone', () => {
    expect(inHostTerms('/srv/clouddev/x on clouddev.example.test', 'clouddev', 'New big clouddev'))
      .toBe('/srv/clouddev/x on clouddev.example.test');
  });
});
