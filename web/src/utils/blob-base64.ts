/**
 * A Blob's bytes as base64 (no `data:` prefix), the way Walnut's speech to text routes take audio.
 * FileReader, not btoa over a string, so a long recording never overflows the stack.
 */
export function blobToBase64(blob: Blob, what = 'audio'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`could not read the ${what}`));
    reader.readAsDataURL(blob);
  });
}
