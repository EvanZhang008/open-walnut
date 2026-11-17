import { describe, expect, it } from 'vitest';
import { lowEndDevice } from '../../web/src/utils/glass-capability';

describe('lowEndDevice', () => {
  it('marks two cores or 2 GB as low end, and nothing when the browser does not say', () => {
    expect(lowEndDevice({ hardwareConcurrency: 2 })).toBe(true);
    expect(lowEndDevice({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe(true);
    expect(lowEndDevice({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(false);
    expect(lowEndDevice({ hardwareConcurrency: 4 })).toBe(false);
    expect(lowEndDevice({})).toBe(false);
    expect(lowEndDevice({ hardwareConcurrency: 0 })).toBe(false);
  });
});
