export function costIncrement(
  cumulativeTotal: number | undefined,
  watermark: number,
): { delta: number; watermark: number } {
  if (cumulativeTotal === undefined || !Number.isFinite(cumulativeTotal) || cumulativeTotal < 0) {
    return { delta: 0, watermark };
  }
  const delta = cumulativeTotal - watermark;
  return delta > 0 ? { delta, watermark: cumulativeTotal } : { delta: 0, watermark };
}

export class CostWatermark {
  private watermark = 0;
  reset(restoredTotal = 0): void { this.watermark = restoredTotal; }
  get value(): number { return this.watermark; }
  seed(value: unknown): boolean {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
    this.watermark = value;
    return true;
  }
  bill(cumulativeTotal: number | undefined): number {
    const result = costIncrement(cumulativeTotal, this.watermark);
    this.watermark = result.watermark;
    return result.delta;
  }
}
