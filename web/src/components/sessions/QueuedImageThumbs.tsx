/**
 * A reloaded queue row's pictures, as its waiting bubble shows them.
 *
 * A row read back from `session:get-queue` has no picture bytes in the tab (a
 * fresh send keeps its own base64 ones), only the files the server saved: its
 * `images` name each one with a URL the server serves (/api/v1/media, the same
 * one the phone reads). They show as thumbnails, never as the header text the
 * CLI is given (src/lib/attachment-headers.ts).
 */
export function QueuedImageThumbs({ urls }: { urls?: readonly string[] }) {
  if (!urls || urls.length === 0) return null;
  // Right-aligned: these thumbnails belong to the user's own (right-bubble) message.
  return (
    <div className="chat-image-previews" style={{ padding: '0 0 8px', justifyContent: 'flex-end' }} data-queued-images="">
      {urls.map((src, i) => (
        <div key={`${i}-${src}`} className="chat-image-preview">
          <img src={src} alt="attached image" loading="lazy" data-lightbox-src={src} />
        </div>
      ))}
    </div>
  );
}
