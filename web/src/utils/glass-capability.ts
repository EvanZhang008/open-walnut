/**
 * Marks a low-end device so the see-through glass material (overlay-glass.css,
 * `wn-glass`) paints solid there: a 30px backdrop blur redraws everything under an
 * overlay on every frame, which a two-core or 2 GB machine feels as lag while the
 * popover moves. Read once at boot; the CSS does the rest.
 */
export function lowEndDevice(nav: { hardwareConcurrency?: number; deviceMemory?: number }): boolean {
  const cores = nav.hardwareConcurrency;
  const memory = nav.deviceMemory;
  return (typeof cores === 'number' && cores > 0 && cores <= 2) || (typeof memory === 'number' && memory > 0 && memory <= 2);
}

export function installGlassCapability(): void {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return;
  if (lowEndDevice(navigator as Navigator & { deviceMemory?: number })) document.documentElement.dataset.glass = 'solid';
}
