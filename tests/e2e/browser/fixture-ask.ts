/**
 * What a fixture's Needs you report carries beside its own ask, so the report door takes it as a
 * real worker's would. The door refuses a card too thin to decide on (src/core/org/ask-clarity.ts,
 * bareCardRefusal: under THIN_CARD_MIN of text; Nightly extra tests run 45162939087, where
 * board-kanban-text-source's "<doc>:2 first" was refused). The specs keep their short asks, since
 * they read the ask's own words back; the background goes in ask_more. Plain module: the guard
 * tests/scripts/fixture-ask-card.test.ts judges it with the door's own verdict.
 */
export const FIXTURE_ASK = {
  user_kind: 'user_info',
  user_kind_why: 'Only the user knows which fixture design is current',
  ask_more: 'A browser test fixture: two designs of the same page are on record, and the test asks which one is current.',
} as const
