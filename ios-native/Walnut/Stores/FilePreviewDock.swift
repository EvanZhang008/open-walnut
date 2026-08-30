import Foundation
import Observation
import SwiftUI
import UIKit

/// Remembered scroll positions for the in-app HTML preview, keyed by
/// `FilePreviewTarget.id` ("<host>\u{1}<path>") so the same report on two exec
/// hosts keeps two positions.
///
/// A pure value type on purpose. The eviction rule is the only thing between
/// "reopen lands where I left off" and a dictionary that grows by one entry per
/// report an agent ever wrote, and that rule has to be provable without a store,
/// a web view, or a running app — see `FilePreviewDockTests`.
struct FilePreviewOffsetTable: Equatable {
    struct Entry: Equatable {
        let key: String
        var offset: CGFloat
    }

    /// Two dozen files is far more reading history than one sitting uses, and the
    /// whole table is a few hundred bytes. The bound exists so a long-lived app
    /// process can't accumulate an entry per generated report.
    static let capacity = 24

    /// Newest RECORD first. Eviction drops the oldest record, not the least
    /// recently read: a read is a pure lookup (it happens while a SwiftUI view is
    /// being built, where mutating anything is a re-entrant-update trap), so
    /// recency can only be tracked on writes. In practice every reopen is
    /// followed by a collapse, and that collapse records again and moves the
    /// entry back to the front.
    private(set) var entries: [Entry] = []

    var count: Int { entries.count }
    var keysNewestFirst: [String] { entries.map(\.key) }

    func offset(for key: String) -> CGFloat? {
        entries.first(where: { $0.key == key })?.offset
    }

    /// Negative offsets are real: a rubber-band overscroll at the top of a
    /// document reports one, and restoring INTO the bounce zone leaves the page
    /// looking broken. Clamp at write time so no reader has to remember to.
    mutating func record(_ key: String, offset: CGFloat) {
        entries.removeAll { $0.key == key }
        entries.insert(Entry(key: key, offset: max(0, offset)), at: 0)
        if entries.count > Self.capacity {
            entries.removeLast(entries.count - Self.capacity)
        }
    }
}

/// WHICH SURFACE a composer belongs to, and which surface the user is looking at.
///
/// ## Why presence alone was not enough (the 2026-08-30 P1)
///
/// `ComposerPresence` fixed "one slot, last writer wins" by keeping an entry per
/// composer. It did not fix WHO the clearance is for, and with a set the clearance
/// became a max over EVERY registered composer — which is only the right answer while
/// every registered composer is on the same screen. Two things make that false in this
/// app, and both were measured with a preview docked (`file.dock.bar`
/// [12,575][390,620] IDENTICAL on Settings, Notes, Inbox and the Tasks search results,
/// stranded ~171pt above the tab bar, floating mid-content over a row):
///
///  1. **A composer's draft key is not stable.** The chat composer's key is
///     `"chat:\(activeID ?? "new-\(agentID)")"`, and `ChatStore.activeID` starts nil
///     and is filled by hydration (and cleared again by `switchAgent`). The view is
///     never re-identified, so no `onAppear`/`onDisappear` pair runs: the composer
///     simply starts reporting under a NEW key while the OLD key stays registered
///     forever, because the only retraction the view can ever send names the key it
///     holds NOW. Presence then never empties, `.noComposer` is unreachable, and every
///     surface inherits the tallest thing any composer ever measured.
///  2. **A `TabView` keeps the tabs it is not showing mounted**, so the chat
///     composer's `onAppear` (publisher #2) can re-register it while the user is on a
///     session page or on Settings, and there is nothing in a mounted view that can
///     tell "my tab is in front" apart from "my view exists".
///
/// So the clearance cannot be derived from the set of composers that EXIST. It is
/// derived from the composers registered for the surface that is ON SCREEN, and the
/// app publishes which surface that is: `MainTabView` owns the tab selection (the
/// BASE), and a screen pushed on top of a tab (a session conversation) takes a CLAIM.
/// That is the same two-layer shape `AttentionContext` already uses for time tracking,
/// for the same reason: the tab is knowable only where the selection lives, and
/// appear/disappear is the less reliable of the two signals.
///
/// `unattached` is the DEFAULT for a composer that has not declared a surface, and it
/// counts on EVERY surface. That direction is deliberate: this app's clearance bugs
/// have one asymmetry, stated in `ComposerClearance` — floating the seat too high is
/// cosmetic, sitting too low ate a draft. A composer nobody has told us about is
/// therefore assumed to be in front of the user rather than ignored. Every product
/// composer on a surface the bar can be seen over declares its surface; the one that
/// does not (`NewSessionChatView`, `draft:new-session`) lives in a full-height sheet
/// that covers the bar outright.
struct ComposerSurfaceID: Hashable, Sendable {
    /// Stable identity string. Also what the logs and the per-surface height memory
    /// key on, so it must be cheap and collision-free — hence a namespaced prefix.
    let raw: String

    /// No declared surface: counts on every surface (see the type's doc).
    static let unattached = ComposerSurfaceID(raw: "")

    /// A tab of `MainTabView`. Identity ONLY — nothing here knows or cares whether a
    /// tab hosts a composer, which is why there is no per-tab list to keep in sync.
    static func tab(_ name: String) -> ComposerSurfaceID { ComposerSurfaceID(raw: "tab:\(name)") }

    /// The Chat tab, named once so the tab table and the chat composer cannot drift.
    static let chatTab = ComposerSurfaceID.tab("chat")

    /// One session conversation page. Keyed by session id so a forked session pushed
    /// on top of its parent is a different surface.
    static func session(_ id: String) -> ComposerSurfaceID { ComposerSurfaceID(raw: "session:\(id)") }
}

/// What the file-preview dock bar knows about the composer beneath it, and the
/// ONLY thing it is allowed to place itself from.
///
/// THREE cases, not an optional height. Collapsing two of them into `nil` was the
/// first half of the 2026-08-29 P1: background the app on a session conversation
/// page and come back, and the published height went unknown while the composer was
/// still on screen. `nil` was read as "this surface has no composer", the bar took
/// tab-bar-only clearance, and it painted straight across `chat.plus` / the model
/// pill / `chat.mic` / `chat.send` (measured [12,746][390,791], 3 runs out of 3).
/// The cost was not cosmetic: a tap aimed at SEND landed on `file.dock.close`, so
/// the docked report was thrown away AND the draft did not send.
///
/// So "I don't know the height" has its own case and can never resolve to "there is
/// no composer". `nil` must never mean "paint over the composer".
///
/// That fix was necessary and NOT sufficient — the store was still a single-slot
/// channel, and the real path went through PRESENCE rather than through the height.
/// See `ComposerPresence` for the trail that proves it. Nor was PRESENCE sufficient:
/// which of several registered composers the seat is actually sitting over is a third
/// question, and getting it wrong stranded the bar 171pt up on four tabs
/// (`ComposerSurfaceID`).
enum ComposerClearance: Equatable {
    /// The surface ON SCREEN has no composer (Settings, Notes, Inbox, Tasks). The seat
    /// sits directly on the tab bar; floating it above a composer that is not there is
    /// the other half of the original defect.
    ///
    /// NOT "nobody has reported lately" and NOT "no composer exists" — those two
    /// readings are the two shipped bugs, one per direction. See
    /// `FilePreviewDock.composerClearance`.
    case noComposer

    /// A composer is on screen and this is its measured height.
    case measured(CGFloat)

    /// A composer IS on screen and its height is not known (a first layout pass, a
    /// zero-height report from a backgrounding snapshot). The bar HIDES rather than
    /// guess: a hidden seat costs one tap to get back, because the file, the scroll
    /// position and the seat all survive in the store, while a seat placed from a
    /// guess can cover the send button.
    case unknownHeight
}

/// Every composer surface currently ON SCREEN, newest registration first.
///
/// ## Why presence is a SET and not a slot (the P1's real path, measured)
///
/// The first fix for "the bar paints across the composer after a background/return"
/// made the height three-state and stopped believing a retraction that arrives while
/// the app is backgrounded. It shipped, and the defect came straight back, because
/// the channel underneath was still ONE slot with last-writer-wins semantics — and
/// the writer that wins is not always the composer you can see.
///
/// Instrumented trail from the real app (session conversation page, Home, return;
/// `AppLog` subsystem `preview`, 2026-08-29). A `TabView` retains the tabs it is not
/// showing, so the Chat tab's composer is MOUNTED the whole time the user is on a
/// session page, and SwiftUI runs its `onAppear`/`onDisappear` again around each
/// scene-phase transition:
///
///     resume (app is .active again)
///     appear   chat:new-general      → claims the slot (wasKey: session:cb18…)
///     report   chat:new-general 114
///     disappear chat:new-general     → retraction BELIEVED (app is .active, key matches)
///                                    → composerKey = nil
///     phase    session:cb18… active  → re-asserts, slot = session again   (good)
///     appear   chat:new-general      → claims the slot AGAIN (wasKey: session:cb18…)
///     disappear chat:new-general     → retraction BELIEVED → composerKey = nil
///     (nothing follows)
///
/// Terminal state: no composer, while the session composer was on screen the entire
/// time and had never retracted. The bar then read `.noComposer`, took tab-bar-only
/// clearance (measured: bar bottom == composer bottom == 791) and covered mic/send.
/// Neither of the earlier guards could help: the retraction was honest about ITS
/// composer, arrived while the app really was active, and named the key that really
/// did own the slot. An INVISIBLE composer's goodbye erased a VISIBLE composer's
/// presence, and that is only possible when the two share one slot.
///
/// So presence is per-composer now: a retraction removes exactly its own entry, and
/// `.noComposer` requires the set to be EMPTY. The invariant the bar needs, restated
/// so it does not depend on ordering luck: while ANY composer is registered, the
/// clearance is strictly more than the tab bar.
///
/// The clearance takes the TALLEST registered composer's height, not the newest.
/// With two composers registered mid-churn, the newest report can be the retained
/// one's (an empty 92pt chat composer) while the visible one is a 300pt session
/// composer carrying banners and a permission card, and 92pt of clearance lands
/// INSIDE that composer's control row — the original defect with extra steps. Being
/// too tall floats the seat above a phantom composer, which is cosmetic; being too
/// short ate a draft.
///
/// Bounded like every other table here: the keys are draft keys, so a long-lived
/// process would otherwise accumulate one per session page ever visited.
///
/// Every entry also carries the SURFACE it was registered for (`ComposerSurfaceID`),
/// which is what turned "the tallest composer that exists" into "the tallest composer
/// on the screen the user is looking at". Without it the set was strictly worse than
/// the slot it replaced for the composer-less tabs: a slot at least got emptied
/// sometimes, while a set that can only ever be added to by an unstable draft key
/// never does (the 2026-08-30 P1 — see `ComposerSurfaceID`).
struct ComposerPresence: Equatable {
    static let capacity = 8

    struct Entry: Equatable {
        let key: String
        let surface: ComposerSurfaceID
    }

    /// Newest registration first. Order carries no authority over the clearance (that
    /// is a max within one surface); it only decides which key answers `composerKey`,
    /// and bounds eviction.
    private(set) var entriesNewestFirst: [Entry] = []

    var isEmpty: Bool { entriesNewestFirst.isEmpty }
    var count: Int { entriesNewestFirst.count }
    var newest: String? { entriesNewestFirst.first?.key }
    var keysNewestFirst: [String] { entriesNewestFirst.map(\.key) }

    func contains(_ key: String) -> Bool { entriesNewestFirst.contains { $0.key == key } }

    func surface(for key: String) -> ComposerSurfaceID? {
        entriesNewestFirst.first { $0.key == key }?.surface
    }

    /// The composers registered FOR `surface`, newest first. An `.unattached` entry
    /// counts on every surface (see `ComposerSurfaceID`); everything else answers only
    /// for its own.
    ///
    /// Asking for `.unattached` means "nobody has published a surface yet" — a DEBUG
    /// harness root, a unit test, or the update cycle before `MainTabView.onAppear` runs
    /// (SwiftUI runs a child's `onAppear` BEFORE its parent's, so the chat composer can
    /// report before the tab it is in has been named). Every composer counts then, which
    /// is the pre-surface behaviour and errs the way this file always errs: a seat that
    /// floats above a composer nobody can see is cosmetic, a seat on the send button ate
    /// a draft.
    func keys(onSurface surface: ComposerSurfaceID) -> [String] {
        guard surface != .unattached else { return keysNewestFirst }
        return entriesNewestFirst
            .filter { $0.surface == .unattached || $0.surface == surface }
            .map(\.key)
    }

    /// "This composer is on screen, on this surface." Idempotent, and moves an
    /// already-present key to the front so eviction drops the composer nobody has heard
    /// from in longest. A key that comes back naming a DIFFERENT surface is re-pointed
    /// rather than duplicated: one composer is on one screen.
    mutating func register(_ key: String, surface: ComposerSurfaceID = .unattached) {
        // Already the newest entry, naming the same surface: nothing to reorder.
        if let front = entriesNewestFirst.first, front.key == key, front.surface == surface {
            return
        }
        entriesNewestFirst.removeAll { $0.key == key }
        entriesNewestFirst.insert(Entry(key: key, surface: surface), at: 0)
        if entriesNewestFirst.count > Self.capacity {
            entriesNewestFirst.removeLast(entriesNewestFirst.count - Self.capacity)
        }
    }

    /// "This composer left the screen." Removes ONE entry and never the set.
    mutating func retract(_ key: String) {
        entriesNewestFirst.removeAll { $0.key == key }
    }
}

/// Last MEASURED height per composer key, so a composer whose height goes unknown
/// can be cleared with the number it really had a moment ago instead of with "no
/// composer at all".
///
/// Bounded for the same reason `FilePreviewOffsetTable` is: the keys are draft keys
/// ("chat", "session:<id>"), so an unbounded map grows by one entry per session
/// page ever visited in a long-lived app process. Eight is more chat surfaces than
/// one sitting touches, and every entry is a String plus a CGFloat.
///
/// The dock keeps TWO of these, with two different keys and two different jobs: one
/// per DRAFT KEY (what did this composer measure) and one per SURFACE
/// (`ComposerSurfaceID.raw` — has this screen ever had a composer at all, and how tall
/// was it). See `composerClearance`.
struct ComposerHeightMemory: Equatable {
    static let capacity = 8

    private(set) var keysNewestFirst: [String] = []
    private var heights: [String: CGFloat] = [:]

    var count: Int { keysNewestFirst.count }

    func height(for key: String) -> CGFloat? { heights[key] }

    /// Only real measurements are remembered. A zero is a layout artefact, and
    /// remembering it would turn the fallback into the very thing it exists to
    /// prevent (a composer cleared by 0pt).
    mutating func record(_ key: String, height: CGFloat) {
        guard height > 0 else { return }
        keysNewestFirst.removeAll { $0 == key }
        keysNewestFirst.insert(key, at: 0)
        heights[key] = height
        while keysNewestFirst.count > Self.capacity, let evicted = keysNewestFirst.popLast() {
            heights.removeValue(forKey: evicted)
        }
    }
}

/// The in-app HTML preview's "seat": one collapsed preview, its remembered
/// scroll positions, and the ONE live `WKWebView` that makes coming back to it
/// land exactly where the user left off.
///
/// ## The problem this exists to solve
///
/// A SwiftUI `.sheet` DESTROYS its content view on dismiss, and
/// `UIViewRepresentable.makeUIView` runs again on re-present, so dismissing the
/// preview used to throw the document away: reopening reloaded it from the top.
/// The reported flow is "scroll a long report down, leave to ask the AI
/// something, come back" — which the old shape could not serve at all.
///
/// ## Retention strategy: keep the instance alive, EXACTLY ONE of them
///
/// The store holds the live web view (`live`) rather than re-creating it and
/// re-applying an offset, because re-applying races the document's own layout: a
/// report whose content height changes after `didFinish` (images resolving, a
/// JS-drawn chart) lands somewhere else, and "somewhere else" reads as a bug. A
/// retained web view already holds the position; nothing has to be guessed.
///
/// The cost is a real renderer process, which is exactly the class of thing this
/// app has been killed for in the field (the 0x8BADF00D jetsam rounds around
/// builds 27-29). So the retention is bounded on every axis:
///  - EXACTLY ONE. A second file previewed while one is docked replaces it.
///  - Dropped on the dock bar's explicit close, the only real "throw it away".
///  - Dropped on a memory warning, and dropped when the app backgrounds
///    (`LifecycleSuspendable`) — a suspended renderer's dirty pages still count
///    against the footprint the OS kills for.
///  - NEVER dropped while the preview is on screen: blanking a document the user
///    is reading, to save memory, is a worse bug than the memory.
/// Every drop keeps the OFFSET in the table, so the next open still restores,
/// approximately (see `HTMLPreviewLoader.applyPendingRestore`).
///
/// The ephemeral `WKWebsiteDataStore` stays ephemeral. Nothing here persists web
/// content; the only thing remembered is a scroll offset, in memory.
///
/// ## Who presents the sheet
///
/// Not this store. Each surface keeps its own local presentation state (the two
/// timeline bodies, plus `MainTabView` for the dock bar's reopen) and the SHEET
/// itself reports its lifetime here (`present` on appear, `collapse` on
/// disappear). Centralising presentation was considered and rejected: a preview
/// opened from a session page that is itself inside `TaskDetailSheet` has to be
/// presented by a view INSIDE that sheet, and asking an ancestor that is already
/// presenting to present again is the "already presenting" failure mode.
///
/// ## Two fields, two different questions
///
/// `docked` answers "which file owns the seat" and survives a collapse; it is
/// cleared ONLY by the explicit close. `presented` answers "is the full preview
/// on screen right now". The dock bar shows when there is a seat and nothing is
/// on screen (`dockBarVisible`). Keeping the seat while presented is deliberate:
/// if a presentation somehow fails, the user still has the bar to get back.
@Observable
@MainActor
final class FilePreviewDock {
    /// The file that owns the seat, or nil when there is none.
    private(set) var docked: FilePreviewTarget?

    /// The file whose full preview is on screen, or nil.
    private(set) var presented: FilePreviewTarget?

    /// The dock bar's whole existence condition.
    var dockBarVisible: Bool { docked != nil && presented == nil }

    /// The last positive height ANY registered composer reported, or nil while none
    /// is registered.
    ///
    /// Its job is narrow and it is easy to misread, so: this is a DIAGNOSTIC (and the
    /// value the tests read to prove a keyed report landed), not the number the bar
    /// places itself from, and no longer the thing that makes the bar re-render either.
    /// The clearance is a per-surface max over two non-observed height memories, and what
    /// guarantees a reader sees a change is that every report — positive, zero or a
    /// retraction — calls a MUTATING method on the observed `composers` set, and a
    /// mutation through an `@Observable` property publishes whether or not the value
    /// moved. The earlier version of this comment argued the same guarantee
    /// arithmetically ("any report that could raise the max is larger than this value");
    /// that argument was true of ONE global max and stopped being true when the max
    /// became per-surface, which is exactly the kind of drift to keep out of this file.
    ///
    /// READ THE CLEARANCE, never this on its own: nil here means "nobody has measured
    /// anything", and the first half of the P1 was a reader that treated it as "no
    /// composer".
    ///
    /// This replaced `tabBar + 32 + 6 + 8 + gap` arithmetic inside the bar
    /// (2026-08-29 review). Measured with those constants, `file.dock.bar`
    /// [12,694][390,739] fully CONTAINED `chat.composer` [28,714][374,736] — the
    /// seat sat ON the text field — because the sum only ever counted the composer's
    /// BOTTOM CONTROL ROW and the composer is a stack: notices, a voice-retry row, a
    /// thumbnail strip, a field that grows to six lines, and then that row. The same
    /// number was also wrong in the other direction on a tab with no composer at
    /// all, where the bar floated 46pt above the tab bar for no reason.
    ///
    /// One published measurement replaces both errors, and it is a measurement
    /// rather than a bigger sum because the composer's height is genuinely dynamic:
    /// no constant can be right for a draft that grew to six lines AND for an empty
    /// one.
    ///
    /// ## Why this one IS observed, unlike `offsets` and `live` beside it
    ///
    /// The first cut made it `@ObservationIgnored`, reasoning by analogy with the
    /// P0-2 freeze rule ("never publish from a geometry callback"). That was
    /// cargo-culted and it did not work: the dock bar then never re-rendered when the
    /// height changed, so switching to Notes or Settings left the seat floating where
    /// the chat composer used to be (measured: the bar stayed at [12,626][390,670] on
    /// all three tabs).
    ///
    /// The P0-2 rule is narrower than "never publish". The hazard is a CYCLE:
    /// publishing from inside the subtree being measured re-invalidates that subtree,
    /// which re-measures, which publishes again. Here the writer (a composer inside a
    /// tab) and the only reader (`FilePreviewDockOverlay`, an overlay on the
    /// `TabView`) are DISJOINT subtrees, and the bar's own layout cannot change the
    /// composer's height, so there is no edge back. Two further bounds keep the cost
    /// flat: the value is quantised to whole points so an animating keyboard
    /// publishes a handful of times rather than every frame, an unchanged value is
    /// dropped, and the reader is a leaf whose body is one bar (the reason
    /// `FilePreviewDockOverlay` exists as its own view at all).
    private(set) var composerHeight: CGFloat?

    /// Which composers are on screen, and ON WHICH SURFACE — see `ComposerPresence` for
    /// the trail that proves why this cannot be one slot, and `ComposerSurfaceID` for why
    /// a set of them still could not answer "what is under the seat".
    ///
    /// Observed (not `@ObservationIgnored` like the height's neighbours) because
    /// `composerClearance` is derived from it and the bar has to re-render when a
    /// composer appears or leaves. It is also the invalidation carrier for the two height
    /// memories, which are not observed: every report mutates this.
    private(set) var composers = ComposerPresence()

    /// The composer that registered most recently, for the composers' own "am I still
    /// the one the store knows about" re-assert guard. NOT the thing the clearance is
    /// derived from: see `ComposerPresence` on why the clearance is a max, and
    /// `activeComposerSurface` for what it is a max OVER.
    var composerKey: String? { composers.newest }

    // MARK: - Which surface is on screen (the 2026-08-30 P1)

    /// A screen pushed on top of a tab, holding the composer surface while it is there.
    ///
    /// `base` is the tab that was selected when the claim was made, and it is the whole
    /// reason a tab switch needs no cooperation from anybody's `onDisappear`: a claim
    /// only answers while its own tab is selected. Switch away and it goes dormant
    /// (that tab's own surface answers instead); switch back and it revives, even if
    /// SwiftUI never re-ran the pushed page's `onAppear`.
    struct SurfaceClaim: Equatable {
        let token: UUID
        let surface: ComposerSurfaceID
        let base: ComposerSurfaceID
    }

    /// More pushed screens than one sitting stacks. Bounded because a claim that leaks
    /// (its page destroyed while its tab was not selected, so the release never came)
    /// would otherwise be an entry per visit for the life of the process. A leaked
    /// claim below the top is harmless: `activeComposerSurface` reads the LAST matching
    /// one.
    static let surfaceClaimCapacity = 8

    /// The selected tab, published by `MainTabView` (the only place that knows tab
    /// identity). Observed: the clearance is derived from it, so the bar has to
    /// re-render when the user changes tabs — that is symptom P2 of the P1 (the seat
    /// kept the height of a composer on another tab).
    private(set) var composerSurfaceBase: ComposerSurfaceID = .unattached

    /// Claims by pushed screens, oldest first. Observed for the same reason.
    private(set) var composerSurfaceClaims: [SurfaceClaim] = []

    /// The surface the user is actually looking at: the topmost claim made under the
    /// selected tab, or the tab itself.
    var activeComposerSurface: ComposerSurfaceID {
        composerSurfaceClaims.last(where: { $0.base == composerSurfaceBase })?.surface
            ?? composerSurfaceBase
    }

    /// Is this composer's surface the one on screen? `.unattached` says yes from either
    /// side: a composer that has not declared one, and a store nobody has published a
    /// surface to yet (harness / test / the first update cycle). See `ComposerSurfaceID`.
    func isActiveComposerSurface(_ surface: ComposerSurfaceID) -> Bool {
        let active = activeComposerSurface
        return surface == .unattached || active == .unattached || surface == active
    }

    /// "This tab is selected." Idempotent; the ONLY writer is `MainTabView`.
    ///
    /// Read from the tab SELECTION rather than from five tabs' `onAppear`, for the
    /// reason `AttentionContext.setBase` already records: a `TabView` keeps the tabs it
    /// is not showing mounted, so appear/disappear is the less reliable signal, and the
    /// selection is one place instead of five.
    func setComposerSurfaceBase(_ surface: ComposerSurfaceID) {
        guard composerSurfaceBase != surface else { return }
        composerSurfaceBase = surface
    }

    /// A pushed screen takes the surface. Keep the token; release with it.
    func claimComposerSurface(_ surface: ComposerSurfaceID) -> UUID {
        let token = UUID()
        composerSurfaceClaims.append(
            SurfaceClaim(token: token, surface: surface, base: composerSurfaceBase)
        )
        if composerSurfaceClaims.count > Self.surfaceClaimCapacity {
            composerSurfaceClaims.removeFirst(composerSurfaceClaims.count - Self.surfaceClaimCapacity)
        }
        return token
    }

    /// Give the surface back. Returns whether the claim was actually dropped, so the
    /// caller can KEEP its token when it wasn't and never claim twice for one screen.
    ///
    /// Two refusals, and both are the same lesson the retraction guard learned: a
    /// SwiftUI "I disappeared" is not proof that a screen is gone.
    ///  - While the app is backgrounded, the snapshot re-lays-out the hierarchy and
    ///    fires `onDisappear` for screens that are still on screen, with no matching
    ///    `onAppear` on the way back (measured 3/3, 2026-08-29). Believing it here would
    ///    drop a session page's claim, hand the surface back to the tab underneath, and
    ///    put the seat on the composer — the exact D1 coverage bug.
    ///  - While the base has MOVED ON, the disappear that just arrived is the tab
    ///    switch, not a pop (nobody can pop a page on a tab they are not looking at).
    ///    Keeping the claim dormant is what makes returning to that tab correct without
    ///    depending on the pushed page's `onAppear` running again.
    @discardableResult
    func releaseComposerSurface(_ token: UUID) -> Bool {
        guard let index = composerSurfaceClaims.lastIndex(where: { $0.token == token }) else {
            return false
        }
        guard appInForeground else {
            AppLog.info("preview", "composer surface release ignored while backgrounded", [
                "surface": composerSurfaceClaims[index].surface.raw,
            ])
            return false
        }
        guard composerSurfaceClaims[index].base == composerSurfaceBase else { return false }
        composerSurfaceClaims.remove(at: index)
        return true
    }

    /// What the bar may place itself from. See `ComposerClearance` for the coverage
    /// incident, `ComposerPresence` for why an on-screen composer can never be erased
    /// by an invisible one's goodbye, and `ComposerSurfaceID` for why the answer is
    /// scoped to ONE surface.
    ///
    /// Four questions in order, and the order is the whole rule:
    ///  1. What is on screen? `activeComposerSurface` — never "what exists".
    ///  2. How tall is the TALLEST composer registered there? A max, so no clearance
    ///     can land inside a composer that is on screen (two composers can legitimately
    ///     overlap on one surface while SwiftUI runs an incoming `onAppear` before an
    ///     outgoing `onDisappear`).
    ///  3. If nothing there has a usable height, has this surface EVER measured one?
    ///     Then it has one now: a screen does not lose its composer while it stays on
    ///     screen, so the honest answer is that height rather than "no composer".
    ///     This is what makes "a chat surface never gets tab-bar-only clearance" a
    ///     property of the surface instead of a bet on callback ordering.
    ///  4. Is the surface a CLAIM? Claiming is a screen saying "the composer surface is
    ///     mine" (`View.composerSurface(_:)`), so a claimed surface has a composer even
    ///     on its very first paint, before its first geometry callback has run. The seat
    ///     HIDES for those frames rather than being placed from a tab's composer behind
    ///     the page or dropped onto the tab bar.
    /// Only a plain tab surface that has never had a composer reaches `.noComposer`,
    /// which is exactly what Settings / Notes / Inbox / Tasks are.
    ///
    /// Reads the two height memories (not observed) alongside observed fields, which is
    /// safe because they are only ever written from `reportComposer`, and every accepted
    /// report also mutates the observed `composers` set: a reader registered on that can
    /// never miss a change to a memory.
    var composerClearance: ComposerClearance {
        let claim = composerSurfaceClaims.last(where: { $0.base == composerSurfaceBase })
        let surface = claim?.surface ?? composerSurfaceBase
        let keys = composers.keys(onSurface: surface)
        var tallest: CGFloat = 0
        for key in keys {
            if let height = composerHeights.height(for: key), height > tallest {
                tallest = height
            }
        }
        if tallest > 0 {
            unknownClearanceLogged = nil
            return .measured(tallest)
        }
        if let remembered = surfaceComposerHeights.height(for: surface.raw), remembered > 0 {
            unknownClearanceLogged = nil
            return .measured(remembered)
        }
        // A composer is here (registered, or promised by the claim) and nothing has ever
        // measured this surface: a first layout pass, a backgrounding snapshot's zero,
        // the first frame of a pushed page. The bar hides rather than guess.
        if !keys.isEmpty || claim != nil {
            noteUnknownClearance(surface: surface, registered: keys.count, claimed: claim != nil)
            return .unknownHeight
        }
        unknownClearanceLogged = nil
        return .noComposer
    }

    /// Surface the hide-while-unknown leg was last logged for, so a body-pass storm
    /// cannot flood the log with the same line. Cleared whenever the clearance is
    /// something else, so a RECURRENCE is logged again.
    @ObservationIgnored private var unknownClearanceLogged: String?

    /// The one thing this leg was missing: a trace.
    ///
    /// `.unknownHeight` HIDES the seat, and a field report of "the seat vanished on
    /// Notes" (once, unreproducible) had nothing in the log to distinguish this from a
    /// closed preview or a keyboard that never announced its dismissal — the whole leg
    /// was silent. One line, naming the surface that was on screen and which of the two
    /// reasons put us here (a registered composer with no usable height, or a claim that
    /// has not had its first geometry callback yet), makes the next report diagnosable.
    /// No behavior change: the caller returns exactly what it returned before.
    private func noteUnknownClearance(
        surface: ComposerSurfaceID, registered: Int, claimed: Bool
    ) {
        guard unknownClearanceLogged != surface.raw else { return }
        unknownClearanceLogged = surface.raw
        AppLog.info("dock", "seat hidden: composer height unknown on this surface", [
            "surface": surface.raw,
            "registeredComposers": String(registered),
            "claimed": claimed ? "true" : "false",
            "hasSeat": dockBarVisible ? "true" : "false",
        ])
    }

    /// The composer reports its own height (and its disappearance).
    ///
    /// Keyed by the composer's draft key so a stale report cannot win: leaving a
    /// session page runs the new page's `onAppear` before the old one's
    /// `onDisappear` in some transitions, and an unkeyed "I'm gone" would then erase
    /// the height of the composer that is actually on screen.
    ///
    /// Three distinct reports arrive here, and the first version of the P1 fix was
    /// caused by two of them being handled as one:
    ///  - a positive height: a real measurement. Presence + height + memory.
    ///  - `nil`: the composer LEFT the screen (its `onDisappear`). ITS presence goes,
    ///    and only its own.
    ///  - a zero/negative height: the composer is still there but was laid out at no
    ///    height. This happens during the backgrounding snapshot and on a first
    ///    layout pass. It records PRESENCE ONLY; the old code stored the 0 and the
    ///    bar read it as "no composer" and painted across the whole control row.
    ///
    /// Reports from a composer the user cannot see are EXPECTED, not a caller bug: a
    /// `TabView` keeps the tabs it is not showing mounted, and their composers report
    /// on every scene-phase transition. That is exactly why presence is a set — see
    /// `ComposerPresence` — and why every report names its SURFACE, so an invisible
    /// composer's report lands on the screen it belongs to instead of on the one the
    /// user is looking at (`ComposerSurfaceID`).
    func reportComposer(key: String, surface: ComposerSurfaceID = .unattached, height: CGFloat?) {
        guard let height else {
            retractComposer(key: key)
            return
        }
        // Whole points: a keyboard animation walks the height through many
        // fractional values, and each distinct one would invalidate the reader.
        let rounded = height.rounded()
        // Observed, and EVERY report goes through it (a mutating call on an observed
        // property publishes), which is what guarantees the bar re-renders when the
        // clearance — a per-surface max over two NON-observed height memories — could
        // have changed.
        composers.register(key, surface: surface)
        guard rounded > 0 else { return }
        if composerHeight != rounded { composerHeight = rounded }
        composerHeights.record(key, height: rounded)
        // Per-surface memory: "this screen has a composer, and this tall". Deliberately
        // NOT recorded for `.unattached`, which is every surface at once and would let
        // one screen's composer answer for another's (see `composerClearance` step 3).
        if surface != .unattached {
            surfaceComposerHeights.record(surface.raw, height: rounded)
        }
    }

    /// "My composer left the screen." Trusted only while the app is in the
    /// FOREGROUND.
    ///
    /// Backgrounding tears down / re-lays-out enough of the hierarchy to fire a
    /// composer's `onDisappear` without a matching `onAppear` on the way back
    /// (measured 3/3 on a session conversation page, 2026-08-29), and a retraction
    /// believed at that moment is indistinguishable from "he switched to Settings": the
    /// bar then dropped onto the tab bar and painted over the composer that was still
    /// right there.
    ///
    /// Ignoring it errs the other way: if the composer really did go away while the
    /// app was backgrounded, the seat keeps clearing a phantom composer until the
    /// next real report, i.e. it floats a little high. Floating high is cosmetic;
    /// covering the send button ate a draft.
    ///
    /// A believed retraction is no longer what drops the seat onto the tab bar, and that
    /// is the point of the surface work: leaving for Settings is answered by the SURFACE
    /// changing (`setComposerSurfaceBase`), so this only ever removes one composer from
    /// one screen's list. A surface that has measured a composer keeps clearing it (see
    /// `composerClearance` step 3) — a screen does not lose its input bar while it is
    /// still on screen, whatever its callbacks say.
    private func retractComposer(key: String) {
        guard composers.contains(key) else { return }
        guard appInForeground else {
            AppLog.info("preview", "composer retraction ignored while backgrounded", ["key": key])
            return
        }
        composers.retract(key)
        // The last composer left: drop the trigger value too, so a later surface with
        // no composer of its own cannot be cleared by a stale number. The remembered
        // heights survive (they are per key, and the next visit re-registers).
        if composers.isEmpty { composerHeight = nil }
    }

    /// Last real height per composer key: the fallback that makes an unknown height
    /// recoverable instead of fatal. Not observed; see `composerClearance`.
    @ObservationIgnored private(set) var composerHeights = ComposerHeightMemory()

    /// Last real height per SURFACE (`ComposerSurfaceID.raw`). Two jobs the per-key
    /// memory cannot do: it survives the composer's draft key changing under it (the
    /// chat key follows `ChatStore.activeID`, which hydration and `switchAgent` both
    /// move), and it turns "this screen has a composer" into a fact about the SCREEN
    /// rather than about whichever callback last fired. Not observed; see
    /// `composerClearance`.
    @ObservationIgnored private(set) var surfaceComposerHeights = ComposerHeightMemory()

    /// False from `.background` until the next foreground (`LifecycleSuspendable`).
    /// The only things it gates are whether a composer's retraction and a pushed screen's
    /// surface release are believed — the two "I disappeared" signals a backgrounding
    /// snapshot forges.
    @ObservationIgnored private var appInForeground = true

    /// Remembered positions. NOT observed: written from collapse/close, read
    /// from `loader(for:)` which runs while a SwiftUI view is being built, where
    /// invalidating would be a re-entrant update.
    @ObservationIgnored private(set) var offsets = FilePreviewOffsetTable()

    /// The ONE retained web view, or nil. Not observed for the same reason.
    @ObservationIgnored private(set) var live: HTMLPreviewLoader?

    /// Kept so `deinit` can unregister. Block-based observers do NOT
    /// auto-unregister when their target dies (audit GEO-4, learned in
    /// WysiwygEditor where one observer leaked per note ever opened), and while
    /// the app has exactly one dock for its whole life, the test suite builds a
    /// fresh one per case.
    ///
    /// `nonisolated(unsafe)` for the same reason `VoiceRecorder.noteTokens` is:
    /// written on the MainActor in `init`, read from a nonisolated `deinit`.
    @ObservationIgnored nonisolated(unsafe) private var memoryObserver: NSObjectProtocol?

    init() {
        LifecycleHub.shared.register(self)
        // Memory pressure often precedes a jetsam kill by seconds, and a
        // collapsed preview is the most expendable thing the app holds at that
        // moment: the seat and the offset both survive, only the renderer goes.
        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.releaseRetained(reason: "memory-warning") }
        }
    }

    deinit {
        if let memoryObserver {
            NotificationCenter.default.removeObserver(memoryObserver)
        }
    }

    // MARK: - Transitions (pure rules — FilePreviewDockTests drives these)

    /// This target's full preview is now on screen. Called from the sheet's
    /// `onAppear`, so it covers every route in (a timeline link tap, the dock
    /// bar) without each one remembering to announce itself.
    ///
    /// Enforces the single-seat rule: a DIFFERENT file takes the seat over. The
    /// outgoing file's position is banked first — it costs one table entry and it
    /// is the difference between "reopen remembers" and "reopen forgets" for the
    /// report he was reading a minute ago.
    ///
    /// The eviction is ALSO done by `loader(for:)`, and that duplication is
    /// deliberate. SwiftUI runs a child's `onAppear` before its parent's, so the
    /// preview body can ask for its loader before the sheet announces the
    /// presentation; whichever call arrives first has to bank the outgoing offset,
    /// or a file swap silently forgets where the previous report was.
    func present(_ target: FilePreviewTarget) {
        replaceLive(unless: target, reason: "different-file")
        if let docked, docked != target {
            AppLog.info("preview", "docked preview replaced", [
                "was": docked.path, "now": target.path,
            ])
        }
        docked = target
        presented = target
    }

    /// The full preview left the screen = COLLAPSE into the seat, never
    /// "forget". Called from the sheet's `onDisappear`, which is what makes the
    /// swipe-down dismissal work: a swipe never runs the Done button's action.
    ///
    /// `offset` is injectable so the rule can be driven with no web view; in the
    /// app it is read straight off the retained scroll view, so no view-side code
    /// has to catch a lifecycle event in time to capture it.
    func collapse(_ target: FilePreviewTarget, offset: CGFloat? = nil) {
        // A stale dismissal (file B opened while A's sheet animates away) must
        // not clear the presented flag for whatever is on screen now.
        guard presented == target else { return }
        let captured = offset ?? liveOffset(for: target)
        if let captured {
            offsets.record(target.id, offset: captured)
        }
        presented = nil
        docked = target
        if let live, live.target == target {
            // Nothing is bound to the loader now — drop the view-hierarchy link
            // so a dead container isn't kept alive by the retained web view.
            live.unbind()
            // Arm the captured offset while it is UNBOUND, which is the only
            // moment `arm` accepts one. Re-presenting re-parents the web view,
            // and re-parenting clamps `contentOffset` against a frame that is
            // momentarily zero — so even the retained path needs the remembered
            // value to put back, and arming it here makes that independent of
            // whatever order SwiftUI runs the appear callbacks in.
            live.arm(offsets.offset(for: target.id))
        }
    }

    /// Dock bar tap. Returns the target for the caller to present, nil when there
    /// is no seat. The sheet's own `onAppear` does the `present` bookkeeping.
    func reopen() -> FilePreviewTarget? {
        docked
    }

    /// The dock bar's `x` — the ONLY thing that really throws the preview away.
    /// The remembered offset deliberately OUTLIVES it: "reopening remembers where
    /// I was" is half of what was asked for, and one entry in a bounded table is
    /// far too cheap to justify forgetting.
    func closeDocked() {
        captureLiveOffset()
        docked = nil
        presented = nil
        dropLive(reason: "closed")
    }

    func rememberedOffset(for target: FilePreviewTarget) -> CGFloat? {
        offsets.offset(for: target.id)
    }

    /// Drop the retained web view, keeping the seat and the offset. A preview
    /// that is ON SCREEN is never dropped.
    func releaseRetained(reason: String) {
        guard presented == nil, live != nil else { return }
        captureLiveOffset()
        dropLive(reason: reason)
    }

    // MARK: - Live web view (production path)

    /// Create-or-reuse the retained loader for `target`.
    ///
    /// Called from the preview's `onAppear`, so it may run before the sheet's own
    /// `present(_:)` — hence the same bank-then-evict rule as `present`.
    func loader(for target: FilePreviewTarget, url: URL, token: String?) -> HTMLPreviewLoader {
        if let live, live.target == target {
            live.arm(offsets.offset(for: target.id))
            return live
        }
        replaceLive(unless: target, reason: "target-changed")
        let loader = HTMLPreviewLoader(target: target, url: url, token: token)
        loader.arm(offsets.offset(for: target.id))
        live = loader
        return loader
    }

    // MARK: - Internals

    /// Bank + drop the retained loader when it holds a file other than `target`.
    private func replaceLive(unless target: FilePreviewTarget, reason: String) {
        guard let live, live.target != target else { return }
        captureLiveOffset()
        dropLive(reason: reason)
    }

    /// The live loader's position, but only when it holds this target.
    private func liveOffset(for target: FilePreviewTarget) -> CGFloat? {
        guard let live, live.target == target else { return nil }
        return live.capturedOffset
    }

    private func captureLiveOffset() {
        guard let live, let offset = live.capturedOffset else { return }
        offsets.record(live.target.id, offset: offset)
    }

    private func dropLive(reason: String) {
        guard let loader = live else { return }
        live = nil
        loader.teardown()
        AppLog.info("preview", "retained web view dropped", [
            "reason": reason,
            "path": loader.target.path,
        ])
    }
}

extension FilePreviewDock: LifecycleSuspendable {
    /// `.background` is the app's only suspend trigger (see RootView), which is
    /// exactly the moment a retained renderer stops earning its memory.
    ///
    /// It is also the moment the composer channel stops telling the truth: the
    /// backgrounding snapshot re-lays-out the hierarchy, which fires composer
    /// `onDisappear`s and zero-height geometry reports for composers that are still
    /// on screen. So the channel stops believing RETRACTIONS here (see
    /// `retractComposer`) and stops believing a pushed screen's surface RELEASE
    /// (`releaseComposerSurface`) — same forged signal, one level up;
    /// positive heights are still accepted, because the composer's
    /// own foreground re-assert races this store's `resumeForForeground` (two
    /// `onChange(of: scenePhase)` observers, no defined order) and dropping it would
    /// reintroduce the P1 it exists to fix.
    func suspendForBackground() {
        appInForeground = false
        releaseRetained(reason: "background")
    }

    /// The renderer is not resumed (the next open re-creates the web view and
    /// re-applies the remembered offset). What IS resumed is trust in the composer
    /// channel.
    func resumeForForeground() {
        appInForeground = true
    }
}

extension View {
    /// "While this screen is on top, it OWNS the composer surface."
    ///
    /// For a screen pushed on top of a tab (a session conversation page). The tab
    /// itself does not use this — `MainTabView` publishes the selected tab instead,
    /// because a `TabView` keeps its off-screen tabs mounted and their appear/disappear
    /// callbacks describe mounting, not visibility (that asymmetry is the whole P1; see
    /// `ComposerSurfaceID`).
    ///
    /// Only for a screen that HAS a composer: the claim is read as a promise of one
    /// (`FilePreviewDock.composerClearance`, step 4), so the seat hides on a claimed
    /// surface that has not measured anything yet rather than dropping onto the tab bar.
    /// A composer-less pushed screen should not claim — its tab already answers for it.
    ///
    /// Released by TOKEN, so SwiftUI running an incoming screen's `onAppear` before the
    /// outgoing screen's `onDisappear` removes the departing claim and not the one that
    /// just arrived — the same rule `AttentionContext` follows.
    func composerSurface(_ surface: ComposerSurfaceID) -> some View {
        modifier(ComposerSurfaceClaimModifier(surface: surface))
    }
}

private struct ComposerSurfaceClaimModifier: ViewModifier {
    let surface: ComposerSurfaceID

    /// Optional so the DEBUG harness roots and the test hosts (which mount a real
    /// session page with no dock injected) still build.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?
    @Environment(\.scenePhase) private var scenePhase

    @State private var token: UUID?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard token == nil, let dock else { return }
                token = dock.claimComposerSurface(surface)
            }
            // A disappear is believed only while the app is ACTIVE, exactly like the
            // composer's own retraction: backgrounding fires it for screens that never
            // left, and handing the surface back to the tab underneath at that moment
            // would drop the seat onto the composer that is still there. The token is
            // kept when the store refuses the release (a tab switch), so the claim goes
            // dormant with an owner rather than leaking and being claimed twice.
            .onDisappear {
                guard scenePhase == .active, let held = token, let dock else { return }
                if dock.releaseComposerSurface(held) { token = nil }
            }
    }
}
