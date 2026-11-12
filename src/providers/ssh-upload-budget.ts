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
 * The pace of a background upload on a connection of its own (lib/upload-pacer.ts).
 * Measured 2026-11-12 on the relay to a dev host, one fresh connection per run:
 * paced at 10 or 20 KB/s, 7 runs of 40 to 90 s all lived; at 30 or 50 KB/s, 2 of 4
 * were ended; at 100 KB/s or more (paced, or with a 64 KB acked window), 14 of 14
 * were ended within seconds, after 32 KB to 5 MB. Over longer stretches 20 KB/s is not
 * enough: the stream lane paced at 20 KB/s was ended 15 times in 20 minutes, after 7 to
 * 476 s, while a 10 KB/s run beside it lived its whole 10 minutes (6 MB).
 */
export const RELAY_UPLOAD_BYTES_PER_SEC = 10 * 1024
/** Room for one stream piece (48 KB as base64) at once; anything more waits its turn. */
export const RELAY_UPLOAD_BURST_BYTES = 96 * 1024
/**
 * Stream purposes that are background work: the copies a host server keeps (task
 * store, search index, sessions...). Paced on the lane, and never put on the session
 * link (DaemonConnection.openStream). A browser's page ('web') is a person's and goes
 * at once.
 */
export const PACED_STREAM_PURPOSES: ReadonlySet<string> = new Set(['replica'])
