/** A cancellable timeout: Promise.race never cancels its loser on its own. */
export function deadline(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  return { promise, cancel: () => { if (timer) clearTimeout(timer); } };
}
