/** Save a blob as a file the person downloads (the browser's own download, named `name`). */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked later, not at once: WebKit starts the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
