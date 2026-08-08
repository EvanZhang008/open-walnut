# iOS Timeline Rendering Overhaul — UIKit collection view + background layout actor

Structural endpoint of the 0x8BADF00D freeze campaign: replace the SwiftUI `ScrollView + LazyVStack + ForEach` chat timelines (SessionConversationView, ChatView) with ONE timeline engine whose main-thread cost per frame is bounded by construction: `visible cells × O(1) attach`, with all parsing / markdown attribution / height measurement done on a background actor, and main-thread apply batches capped at a ~8ms budget with automatic frame-splitting.

## Why the declarative timeline had to go

Build 36 was watchdog-killed (0x8BADF00D) five times in one day. Every stack was a main-thread SwiftUICore/AttributeGraph full-tree diff with zero Walnut frames on the stack. Four rounds of targeted fixes (render window, tail cap, keyboard-repin breaker, equality-gated writes) each narrowed the window but none could close it, because the structural contract of SwiftUI observation is: *data changed → non-preemptible full-subtree diff on the main thread*. Any single large diff (105–400 variable-height markdown rows) is allowed to run past the 10s scene-update deadline, and iOS kills the app. No mature chat client (Telegram class) renders a live message timeline through a declarative full-tree diff; they all use a UIKit/AppKit list with pre-measured immutable row models.

## Options considered (decided; kept for the record)

| Option | Main-thread bound | Risk | Verdict |
|---|---|---|---|
| SwiftUI + Equatable rows (status quo hardened) | diff still O(rows) on main per invalidation; each row's body re-eval skipped but the graph diff is not | the exact bug class stays structurally possible; 4 rounds of evidence | **No** |
| Texture (AsyncDisplayKit) | good (async layout) | unmaintained dependency, Obj-C interop burden, huge API surface | **No** |
| Full-page WKWebView (web console reuse) | good | loses native text selection/context menus/keyboard behaviors, IPC latency for 8Hz streams, memory | **No** |
| **UICollectionView + background layout actor (TextKit 2 pre-measurement)** | **visible cells × O(1) attach; apply batches budgeted at 8ms** | most engineering effort; height-parity between measurement and cells | **Yes** |

## Architecture

```
SSE deltas / transcript reconciles / optimistic inserts / launch stash
        ▼  (stores unchanged — SessionConversationStore / ChatStore stay the data layer)
TimelineHost (UIViewControllerRepresentable, SwiftUI shell)
  reads the store's observable fields in body → snapshots a TimelineInput
        ▼  submit(input)  — latest-wins coalescing
TimelineLayoutActor (background actor)
  ChatMessage[] → row build (markdown parse → NSAttributedString styling)
  LiveMarkdownWindow semantics (stable head / hot tail / truncation chip)
  TextKit 2 height pre-measurement at the current content width
  → immutable [TimelineRow] (id + content + height)   → TimelineDiff vs last applied
        ▼  MainActor hop
TimelineApplyBudgeter — applies the diff in batches with a ~8ms budget,
  auto frame-splits oversized diffs, every batch goes through MainWork.track
        ▼
TimelineCollectionController (UIKit)
  UICollectionView + TimelineLayout (vertical stack of KNOWN heights — no self-sizing)
  bottom-pin intent (same hysteresis thresholds as ScrollBottomTracking)
  KeyboardRepinMachine unchanged (behavior layer, orthogonal to rendering)
```

### Row model

`TimelineRow` = stable id + `TimelineRowContent` + measured height. One ChatMessage maps to 1..n rows: an assistant markdown message splits per block group (text run / code block / table / image), so heavy sub-blocks get purpose-built cells and exact heights. Stable ids derive from the store's content-derived message ids plus a block index, so re-fetches diff to no-ops.

### Cell strategy (hybrid, deliberate)

- **Text-heavy rows** (assistant markdown text runs, user bubbles, live head/tail, code blocks): pure UIKit cells rendering `NSAttributedString` through UITextView/TextKit — heights pre-measured on the actor with the *same* TextKit 2 configuration, so measurement == rendering.
- **Component rows** (tool chips, notification cards, images, activity shimmer, load-earlier): `UIHostingConfiguration` wrapping the EXISTING SwiftUI components (ToolChip, NotificationCard, AttachmentImageView, ThinkingRow) — behavior fidelity for the interactive bits, cost bounded by visible count. Heights are pre-computed from font metrics/content; a one-shot post-mount correction patches drift > 1pt (bounded: visible cells only).

### Live streaming

LiveMarkdownWindow's head/tail split moves into the actor: per ~8Hz tick only the tail segment re-parses + re-measures (O(2–10KB)); the quantized head re-measures once per tailQuantum. The truncation chip and store-side retention cap semantics are unchanged.

### Pinned-to-bottom

`bottomPinned` intent and `KeyboardRepinMachine` are kept verbatim — they are behavior, not rendering. The controller feeds the same 200pt/40pt hysteresis from `scrollViewDidScroll` (user-driven phases only) and honors `scrollToBottomSignal` + streaming re-assert by setting contentOffset after each applied batch while pinned.

### Forensics

Every main-thread apply batch runs through `MainWork.track(label:count:)` (shim in Timeline/ until the freeze-r4b ledger lands; same signature, aligned at merge). FreezeContext row counts keep being fed per apply.

## Performance gates (WalnutTests, hard asserts, numbers carry n)

| Gate | Fixture | Budget |
|---|---|---|
| First frame | 109-row field-shape + 400-row heavy markdown | worst main batch ≤50ms (sim), open→visible ≤500ms |
| Event storm | 21 ev/s sustained + 500 ev/s microburst | no main batch >50ms, zero watchdog lines |
| Scroll | 400-row round trip | no batch >16ms |
| Background restore | scene-active + cache-invalidated reopen | first-frame gate |
| Budgeter | injected 1000-row diff | auto frame-split, no batch over budget, ledger visible per batch |

## Adoption

Phase 1 (engine, all-new files under `ios-native/Walnut/Timeline/` + tests): zero contact with files other agents are editing. Phase 2 (adoption): surgical swap of the message-list body in SessionConversationView + ChatView for `TimelineHost` — stores, composer, toolbars, sheets untouched.

### Status (2026-08-08)

- Phase 1 **done**: engine + 13 correctness tests (TimelineEngineTests) + 6 perf gates (TimelinePerfGateTests) green; Maestro harness flow (DEBUG `--timeline-harness` page) verified real scroll / streaming follow / tool expand / mid-stream unpin on a simulator.
- Phase 2 **done**: both pages swapped to `SessionTimelineBody` / `ChatTimelineBody`; `ScrollPosition`, `ScrollBottomTracking`'s page wiring and the SwiftUI live-turn leaf rows removed; `KeyboardBottomRepin` retained and now pulses the timeline scroll signal; pull-to-refresh moved to a UIRefreshControl inside the controller (SwiftUI `.refreshable` cannot reach a hosted UICollectionView).

### Measured gate results (sim, M-series; ~3-5x faster than device)

| Gate | Result |
|---|---|
| First frame 109-row field shape | worst batch 13.8ms, total 26ms (gates 50/500) |
| First frame 400-row heavy markdown (1600 rows) | worst batch 15.7ms, total 170ms |
| Storm 1155 events (field 21 ev/s mix, unpaced) | p50 0.27ms, worst batch 18.7ms (gate 50) |
| Microburst 500 events | worst batch 16.1ms, worst diff touched 2 rows (page = 175) |
| Scroll 400-row round trip | best-pass worst step 15.5ms (gate 16) |
| 1000-row reconcile | 14 budgeted batches, worst 16.1ms, all 1600 rows ledger-accounted |
| Cold reopen (caches invalidated) | worst batch <1ms, total 10.5ms |
