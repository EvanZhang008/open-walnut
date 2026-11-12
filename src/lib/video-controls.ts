/** Persistent video controls, shared by the console and its HTML documents.
 * Native WebKit controls float over the picture and can clip the timeline out of
 * a short viewport. Keep the timeline in document flow, not in that shadow UI.
 * Self-contained so sandboxed documents can run the same implementation.
 */
export function installVideoControls(target?: Window): void {
  const w = target || window;
  const doc = w.document;
  // The phone's native media controls include seeking; iOS does not expose a
  // writable volume. Keep those controls rather than offering an inert slider.
  if (/iP(hone|ad|od)/.test(w.navigator?.userAgent || '') ||
      ((w.navigator?.maxTouchPoints || 0) > 1 && /Mac/.test(w.navigator?.platform || ''))) return;
  if (!doc?.documentElement || doc.documentElement.hasAttribute('data-walnut-video-controls')) return;
  doc.documentElement.setAttribute('data-walnut-video-controls', '');
  const style = doc.createElement('style');
  style.textContent = `
    .wn-video-controls { box-sizing:border-box; width:100%; max-width:100%; padding:8px 12px; background:#181a20; color:#f4f4f5; font:12px/1.4 system-ui,sans-serif; }
    .wn-video-timeline,.wn-video-actions { display:flex; align-items:center; gap:10px; min-width:0; }
    .wn-video-timeline { margin-bottom:6px; }
    .wn-video-controls input[type=range] { appearance:auto; -webkit-appearance:auto; min-width:0; height:24px; padding:0; margin:0; background:none; border:none; accent-color:#8eb9ff; cursor:pointer; }
    .wn-video-seek { flex:1; width:0; }
    .wn-video-time { white-space:nowrap; font-variant-numeric:tabular-nums; }
    .wn-video-controls button { font:inherit; border:1px solid #535862; border-radius:5px; background:#242831; color:#f4f4f5; padding:4px 8px; cursor:pointer; }
    .wn-video-controls button:focus-visible,.wn-video-controls input:focus-visible { outline:2px solid #8eb9ff; outline-offset:2px; }
    .wn-video-controls :disabled { opacity:.5; cursor:default; }
    .wn-video-volume { width:72px; }
    .wn-video-fullscreen { margin-left:auto; }
    .wn-video-error { margin-top:6px; }
    .wn-video-controls [hidden] { display:none !important; }
  `;
  (doc.head || doc.documentElement).appendChild(style);
  const time = (value: number) => {
    const secs = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const h = Math.floor(secs / 3600);
    const m = Math.floor(secs / 60) % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(secs % 60).padStart(2, '0');
  };
  const bars = new WeakMap<HTMLVideoElement, HTMLElement>();
  const enhance = (video: HTMLVideoElement) => {
    const existing = bars.get(video);
    if (existing) {
      if (video.nextElementSibling !== existing) video.insertAdjacentElement('afterend', existing);
      return;
    }
    // A background clip or an author's custom player is not a native-control
    // player. Do not add controls or change that document's intended layout.
    if (!video.controls) return;
    video.setAttribute('data-walnut-video', '');
    const filePlayer = !!video.closest('.fv-media-preview');
    // Keep native caption/picture-in-picture controls in authored documents.
    video.controls = !filePlayer;
    video.playsInline = true;
    const bar = doc.createElement('div');
    bar.className = 'wn-video-controls';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Video controls');
    bar.innerHTML = `<div class="wn-video-timeline"><span class="wn-video-time">0:00 / --:--</span><input class="wn-video-seek" type="range" min="0" max="1" step="any" value="0" aria-label="Video position" disabled></div><div class="wn-video-actions"><button type="button" class="wn-video-play" aria-label="Play video">Play</button><button type="button" class="wn-video-mute" aria-label="Mute video">Mute</button><input class="wn-video-volume" type="range" min="0" max="1" step="0.01" aria-label="Video volume"><button type="button" class="wn-video-fullscreen" aria-label="Full screen video">Full screen</button></div><div class="wn-video-error" role="status" hidden></div>`;
    bars.set(video, bar);
    // React owns the file player's element. Authored frames get one layout item
    // so a timeline does not take the next cell of a grid or flex row.
    if (!filePlayer) {
      const wrapper = doc.createElement('span');
      wrapper.style.cssText = 'display:inline-flex;flex-direction:column;max-width:100%;vertical-align:top';
      video.parentNode?.insertBefore(wrapper, video);
      wrapper.appendChild(video);
      bar.querySelector<HTMLElement>('.wn-video-actions')!.hidden = true;
    }
    video.insertAdjacentElement('afterend', bar);
    const seek = bar.querySelector<HTMLInputElement>('.wn-video-seek')!;
    const stamp = bar.querySelector<HTMLElement>('.wn-video-time')!;
    const play = bar.querySelector<HTMLButtonElement>('.wn-video-play')!;
    const mute = bar.querySelector<HTMLButtonElement>('.wn-video-mute')!;
    const volume = bar.querySelector<HTMLInputElement>('.wn-video-volume')!;
    const full = bar.querySelector<HTMLButtonElement>('.wn-video-fullscreen')!;
    const error = bar.querySelector<HTMLElement>('.wn-video-error')!;
    let failed = false;
    let pendingSeek: number | null = null;
    let seekFrame: number | null = null;
    // True while the pointer holds the thumb. The media's own timeupdate and
    // seeked events then never write the slider back: a slow seek finishing
    // mid-drag used to pull the thumb from under the pointer and end the drag.
    let scrubbing = false;
    // A stream (Infinity) still gives its seekable range. Ask for it only once
    // metadata is in: Linux WebKit asked before then keeps a duration of 0 and
    // nothing seekable for good (measured with its own native controls too).
    const length = () => Number.isFinite(video.duration) || video.readyState < 1 ? video.duration
      : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video.duration;
    const sync = () => {
      const duration = length();
      const ready = !failed && video.readyState > 0 && Number.isFinite(duration) && duration > 0;
      seek.disabled = !ready;
      seek.max = String(ready ? duration : 1);
      const shown = scrubbing && ready ? Number(seek.value) : pendingSeek ?? video.currentTime;
      if (!scrubbing || !ready) seek.value = String(ready ? Math.min(duration, Math.max(0, shown)) : 0);
      stamp.textContent = time(shown) + ' / ' + (ready ? time(duration) : duration === Infinity ? 'Live' : '--:--');
      seek.setAttribute('aria-valuetext', stamp.textContent);
      play.textContent = video.paused ? 'Play' : 'Pause';
      play.setAttribute('aria-label', video.paused ? 'Play video' : 'Pause video');
      mute.textContent = video.muted ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-label', video.muted ? 'Unmute video' : 'Mute video');
      volume.value = String(video.muted ? 0 : video.volume);
    };
    const flushSeek = () => {
      seekFrame = null;
      if (pendingSeek == null) return;
      const at = pendingSeek;
      pendingSeek = null;
      // Exact currentTime changes once per paint. Repeated input in one frame
      // replaces the pending target, never queues old decoder/range requests.
      video.currentTime = at;
      sync();
    };
    seek.addEventListener('input', () => {
      if (seek.disabled) return;
      pendingSeek = Math.min(length(), Math.max(0, Number(seek.value)));
      sync();
      if (seekFrame == null) seekFrame = w.requestAnimationFrame(flushSeek);
    });
    seek.addEventListener('pointerdown', () => { if (!seek.disabled) scrubbing = true; });
    const endScrub = () => {
      if (!scrubbing) return;
      scrubbing = false;
      if (seekFrame != null) w.cancelAnimationFrame(seekFrame);
      flushSeek();
      sync();
    };
    // On the document: a drag may end outside the slider.
    doc.addEventListener('pointerup', endScrub, true);
    doc.addEventListener('pointercancel', endScrub, true);
    seek.addEventListener('change', () => {
      if (seekFrame != null) w.cancelAnimationFrame(seekFrame);
      flushSeek();
    });
    seek.addEventListener('keydown', (e) => {
      if (seek.disabled) return;
      if (pendingSeek != null) {
        if (seekFrame != null) w.cancelAnimationFrame(seekFrame);
        flushSeek();
      }
      const jumps: Record<string, number> = { ArrowLeft: -3, ArrowRight: 10, PageDown: -length() / 10, PageUp: length() / 10 };
      if (!(e.key in jumps) && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      e.stopPropagation();
      video.currentTime = e.key === 'Home' ? 0 : e.key === 'End' ? length()
        : Math.min(length(), Math.max(0, video.currentTime + jumps[e.key]));
      sync();
    });
    play.addEventListener('click', () => {
      if (!video.paused) { video.pause(); return; }
      const refused = () => {
        error.hidden = false;
        error.textContent = 'Playback could not start. Try Play again or open it in another player.';
      };
      try { void video.play().catch(refused); } catch { refused(); }
    });
    mute.addEventListener('click', () => { video.muted = !video.muted; sync(); });
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = video.volume === 0; sync(); });
    type FullscreenVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };
    const fsVideo = video as FullscreenVideo;
    full.hidden = !doc.fullscreenEnabled && !fsVideo.webkitSupportsFullscreen;
    full.addEventListener('click', () => {
      try {
        if (doc.fullscreenEnabled && video.requestFullscreen) void video.requestFullscreen().catch(() => { video.controls = !filePlayer; });
        else fsVideo.webkitEnterFullscreen?.();
      } catch { video.controls = !filePlayer; }
    });
    video.addEventListener('fullscreenchange', () => { video.controls = !filePlayer || doc.fullscreenElement === video; });
    video.addEventListener('webkitbeginfullscreen', () => { video.controls = true; });
    video.addEventListener('webkitendfullscreen', () => { video.controls = !filePlayer; });
    video.addEventListener('fullscreenerror', () => { video.controls = !filePlayer; });
    const resetSeek = () => {
      scrubbing = false;
      if (seekFrame != null) w.cancelAnimationFrame(seekFrame);
      seekFrame = null;
      pendingSeek = null;
    };
    video.addEventListener('emptied', resetSeek);
    video.addEventListener('loadstart', () => { resetSeek(); failed = false; error.hidden = true; sync(); });
    video.addEventListener('loadedmetadata', () => { failed = false; error.hidden = true; sync(); });
    video.addEventListener('playing', () => { failed = false; error.hidden = true; sync(); });
    video.addEventListener('error', () => {
      resetSeek();
      failed = true;
      error.hidden = false;
      error.textContent = 'This video could not load. Reopen it or try another player.';
      sync();
    }, true);
    for (const name of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'play', 'pause', 'ended', 'emptied', 'volumechange']) video.addEventListener(name, sync);
    sync();
  };
  const scan = (root: ParentNode) => { root.querySelectorAll<HTMLVideoElement>('video').forEach(enhance); };
  scan(doc);
  // Observe additions, not our own control attributes or time updates. The media's
  // loadstart/emptied events reset the timeline when the same element changes src.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        const removed = element.tagName === 'VIDEO' ? [element as HTMLVideoElement] : Array.from(element.querySelectorAll<HTMLVideoElement>('video'));
        for (const video of removed) if (!video.isConnected) bars.get(video)?.remove();
      }
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (!element.isConnected) continue;
        if (element.tagName === 'VIDEO') enhance(element as HTMLVideoElement);
        else scan(element);
      }
    }
  }).observe(doc.documentElement, { childList: true, subtree: true });
}

export const VIDEO_CONTROLS_JS = `(${installVideoControls.toString()})();`;
