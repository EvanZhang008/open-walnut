/**
 * A test's starts never depend on the size of the machine it runs on: this machine's slots when no
 * setting names them (src/core/hosts/placement.ts hostSlots, one per two CPUs, or a default when
 * its numbers cannot be read) are pinned to the most a host gets (MAX_HOST_SLOTS). On a 4-CPU CI runner they were 2, so a suite that kept two mock sessions in a
 * turn had its third start refused "this Mac has no room (all 2 slots taken)" (2026-11-10
 * engine-split and the browser fixture, 2026-11-18 peer-message-language), while a Mac passed it.
 *
 * Still honoured: a test's own `session_limits` (triage-run fills a 2-slot host on purpose), and a
 * test that fakes the machine's numbers with __setHostLoadProberForTesting gets the count its
 * numbers give. Set through a globalThis key read at each placement, so this file imports nothing
 * of the app and the pin holds after vi.resetModules.
 */
;(globalThis as { [k: symbol]: number | undefined })[Symbol.for('open-walnut.localSizedSlots')] = 32
