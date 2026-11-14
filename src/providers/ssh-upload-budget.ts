/**
 * What may ride a host's shared SSH master, and what goes on a connection of its own.
 *
 * Some relays between this machine and a host end an SSH connection that carries data
 * up fast (2026-11-10: 3 to 24 MB; 2026-11-12: within seconds at 100 KB/s or more,
 * rarely at 20 KB/s; downloads of GB pass). A cut ends only that connection: an idle
 * one beside it lives on. The master carries the session link, so an upload on it
 * took every session on the host down with it. So every upload runs on a connection
 * of its own, which a cut costs only itself, a background one paced below the rate the
 * relay ends, and the master carries commands only: a remote script rides stdin, and
 * one over MASTER_STDIN_MAX_BYTES counts as an upload.
 *
 * tests/providers/ssh-master-upload-guard.test.ts fails on a call that sends stdin data
 * over the master without this check.
 */
export const MASTER_STDIN_MAX_BYTES = 64 * 1024

/** Whether a command whose stdin carries `bytes` may ride the shared master. */
export function rideMaster(bytes: number): boolean {
  return bytes <= MASTER_STDIN_MAX_BYTES
}

/**
 * The pace of an upload on a connection of its own is learned per host and channel, with no
 * setting (lib/adaptive-pace.ts, providers/upload-pace.ts): a host starts unpaced, and only a
 * connection ended while it carried an upload paces the next one. Most hosts are plain SSH and
 * never are; these are the measurements that set the rules, all on one relay on the SSH path
 * to a dev host, one fresh connection per run (2026-11-12):
 *
 *   - paced at 10 or 20 KB/s, 7 runs of 40 to 90 s all lived; at 30 or 50 KB/s, 2 of 4 were
 *     ended; at 100 KB/s or more (paced, or with a 64 KB acked window), 14 of 14 were ended
 *     within seconds, after 32 KB to 5 MB.
 *   - the stream lane paced at 20 KB/s with a 96 KB burst was ended 15 times in 20 minutes,
 *     after 7 to 476 s, while a 10 KB/s run beside it lived its whole 10 minutes (6 MB).
 *   - the bulk channel smooth at 20 KB/s lived a 10-minute, 12 MB run; what ended it was the
 *     burst at each redial when it went at full speed (ended within 1 to 4 s, eleven times).
 *
 * So the burst after a cut is small (1.5 s of the pace), and each cut paces at a third of the
 * rate it came at: from 1 MB/s four cuts reach a pace under 20 KB/s, from 100 KB/s two.
 */
/**
 * Stream purposes that are background work: the copies a host server keeps (task
 * store, search index, sessions...). Paced on the lane, and never put on the session
 * link (DaemonConnection.openStream). A browser's page ('web') is a person's and goes
 * at once.
 */
export const PACED_STREAM_PURPOSES: ReadonlySet<string> = new Set(['replica'])

/** The lowest pace a cut sets on the stream lane: its frames are small (64 KB), so it may go slow. */
export const LANE_PACE_FLOOR_BYTES_PER_SEC = 4 * 1024

/**
 * The most one upload command carries. A daemon closes a client it heard no whole frame from for
 * 120 to 135 s (its keepalive, daemon-standalone.ts CLIENT_KEEPALIVE_MISSED), and its pings wait
 * behind a frame still going up: 1 MB is 1.37 MB as base64, about 70 s at 20 KB/s.
 */
export const MAX_UPLOAD_FRAME_BYTES = 1024 * 1024
/** The longest one upload frame may take to go up: under the daemon's 120 s keepalive, with room. */
export const UPLOAD_FRAME_MAX_SECS = 100
/**
 * The lowest pace a cut sets on the bulk channel: one MAX_UPLOAD_FRAME_BYTES frame as base64
 * goes up within UPLOAD_FRAME_MAX_SECS (about 14 KB/s). Slower, the daemon would close the client
 * while a frame is still going up, a cut of its own that a slower pace only makes worse.
 */
export const BULK_PACE_FLOOR_BYTES_PER_SEC = Math.ceil(MAX_UPLOAD_FRAME_BYTES * 4 / 3 / UPLOAD_FRAME_MAX_SECS)
