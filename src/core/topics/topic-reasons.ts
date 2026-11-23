/**
 * Why a wake was not sent, as the browser reads it too (no server imports here). A queued member
 * still reads the message: when its running turn ends.
 */
export const QUEUED_WHY = 'its turn is still running: it reads this when that turn ends';

/** A fold held for a member whose session ended with none going on: the member reads it with its next wake. */
export const FOLD_GONE_WHY = 'held for its next message, but its session ended with none going on: it reads this with its next wake';
