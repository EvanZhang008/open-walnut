/**
 * Where a daemon update stages on the host: one private dir under /tmp per try (its
 * executable, the detached runner's script and record), and one per payload for its
 * upload chunks (daemon-service-update.ts chunkDirCommand), which outlives a dropped link.
 */
export const STAGING_PREFIX = '/tmp/open-walnut-update.'

/** A staging dir's path, as every command that touches one checks it first. */
export const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/

/** Makes one try's private staging dir; prints its path. */
export const MKTEMP_STAGING = `umask 077; mktemp -d ${STAGING_PREFIX}XXXXXXXXXX`
