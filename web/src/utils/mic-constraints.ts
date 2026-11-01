/**
 * What the dictation mic asks the browser for.
 *
 * Echo cancellation is OFF on purpose. In WebKit (the Mac app, Safari) it makes
 * the capture run through Apple's voice processing unit, which builds an
 * aggregate audio device out of the input and the output device. With Bluetooth
 * headphones as the input (2026-11-01: AirPods as the Mac's default input) that
 * build fails and is retried while the headphones switch profile: the Mac app's
 * GPU process logged "Unable to build a valid aggregate after 10 tries" at the
 * start of each recording that came up seconds late, so the first words were
 * never captured and the level read silence while the user talked. Dictation
 * plays nothing back while it records, so there is no echo to cancel; without
 * it WebKit opens the plain input unit, and no browser ducks the user's music.
 * Noise suppression and gain control are left at the browser's default (Chrome
 * keeps both; WebKit's came with the voice processing unit, so it hands over
 * the raw mic, which the speech model takes as it is).
 */
export const DICTATION_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 16000 },
  echoCancellation: false,
};
