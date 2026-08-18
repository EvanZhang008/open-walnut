import { describe, expect, it } from 'vitest';
import { parsePmsetBatteryPower } from '../../src/core/qmd-power.js';

describe('QMD power guard', () => {
  it('detects battery power from pmset output', () => {
    expect(parsePmsetBatteryPower(
      "Now drawing from 'Battery Power'\n -InternalBattery-0\t63%; discharging",
    )).toBe(true);
  });

  it('does not classify AC power as battery power', () => {
    expect(parsePmsetBatteryPower(
      "Now drawing from 'AC Power'\n -InternalBattery-0\t63%; charging",
    )).toBe(false);
  });
});
