/**
 * Every test run freezes the threads every reader shares (src/core/org/frozen-read.ts): readThreads
 * hands all readers of a node one value per version, so a caller that changes what it read would
 * change it for every other reader in a server. Frozen here, that caller throws in the test that
 * reaches it. One debugging run opts out with WALNUT_THREADS_FREEZE_READS=0. Set in each worker
 * (env from globalSetup does not reliably reach an already-forked one), so anything a test spawns
 * inherits it; this file imports nothing of the app.
 */
process.env.WALNUT_THREADS_FREEZE_READS ??= '1'
