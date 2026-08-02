/**
 * Whether this browser will render a PDF inline (iframe/embed) instead of
 * handing it to the download flow.
 *
 * Firefox set to "Use macOS Preview (default)" / "Save File", or Chrome with
 * "Download PDFs" (incl. the AlwaysOpenPdfExternally enterprise policy),
 * treats EVERY inline PDF as a download — so an <iframe src=…pdf> per
 * `![[embed]]` turns "open a note" into a download + external-app launch per
 * embedded PDF (user-reported: 3 PDFs in one note popped 3 Preview windows
 * and littered ~/Downloads on every open).
 *
 * navigator.pdfViewerEnabled is the standard signal for exactly this
 * (Firefox 99+ / Chrome 94+ / Safari 16.4+); older browsers fall back to the
 * application/pdf mime registration.
 */
export function browserCanInlinePdf(): boolean {
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
  if (typeof nav.pdfViewerEnabled === 'boolean') return nav.pdfViewerEnabled;
  return !!navigator.mimeTypes?.namedItem?.('application/pdf');
}
