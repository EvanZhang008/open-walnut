/**
 * Why a wake was not sent, as the browser reads it too (no server imports here). A queued member
 * still reads the message: when its running turn ends.
 */
export const QUEUED_WHY = 'its turn is still running: it reads this when that turn ends';
