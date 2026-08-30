import XCTest
import UIKit
@testable import Walnut

/// The collapsed HTML preview's seat (T81).
///
/// The reported flow: read a long generated report on the phone, scroll down,
/// leave to ask the AI something, come back. Dismissing the preview used to
/// DESTROY it, so coming back started at the top of the document.
///
/// What is pinned here is the whole rule set, driven against the REAL
/// `FilePreviewDock` with no web view, no network, and no running app. That is
/// possible because the store's transitions take the scroll offset as an
/// argument (`collapse(_:offset:)`) instead of reaching into a scroll view: in
/// the app the offset comes off the retained `WKWebView`, in a test it is a
/// number. The retained-renderer half (a real `WKWebView` keeping its position
/// across a re-parent) is verified on the simulator, since a renderer process
/// can't be asserted from XCTest.
@MainActor
final class FilePreviewDockTests: XCTestCase {

    private let report = FilePreviewTarget(path: "/tmp/reports/weekly.html", host: nil)
    private let other = FilePreviewTarget(path: "/tmp/reports/costs.html", host: nil)

    // MARK: - Collapse records, never forgets

    func testCollapseRecordsTheOffsetAndKeepsTheSeat() {
        let dock = FilePreviewDock()
        dock.present(report)
        XCTAssertEqual(dock.presented, report)
        XCTAssertFalse(dock.dockBarVisible, "no seat is shown while the preview is on screen")

        dock.collapse(report, offset: 1840)

        XCTAssertNil(dock.presented, "collapse takes the preview off screen")
        XCTAssertEqual(dock.docked, report, "collapse moves it into the seat, it does not forget it")
        XCTAssertTrue(dock.dockBarVisible)
        XCTAssertEqual(dock.rememberedOffset(for: report), 1840)
    }

    /// A swipe-down dismissal never runs the Done button's action, which is why
    /// the whole collapse contract hangs off the sheet's `onDisappear` and not
    /// off a button. Both gestures therefore reach the store through the exact
    /// same call, and this is the assertion that the collapse rule doesn't care
    /// which one it was.
    func testSwipeDismissAndDoneCollapseThroughTheSamePath() {
        let viaDone = FilePreviewDock()
        viaDone.present(report)
        viaDone.collapse(report, offset: 700)

        let viaSwipe = FilePreviewDock()
        viaSwipe.present(report)
        viaSwipe.collapse(report, offset: 700)

        XCTAssertEqual(viaDone.docked, viaSwipe.docked)
        XCTAssertEqual(viaDone.rememberedOffset(for: report), viaSwipe.rememberedOffset(for: report))
    }

    func testReopenReturnsTheSeatedTargetAtItsRememberedPosition() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 512)

        let reopened = dock.reopen()

        XCTAssertEqual(reopened, report)
        XCTAssertEqual(dock.rememberedOffset(for: report), 512, "the position is what makes reopening worth anything")
    }

    func testReopeningThenCollapsingAgainUpdatesTheRememberedPosition() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 300)
        // Back in, read further down, collapse again.
        dock.present(report)
        dock.collapse(report, offset: 2600)

        XCTAssertEqual(dock.rememberedOffset(for: report), 2600)
        XCTAssertEqual(dock.offsets.count, 1, "the same file must not accumulate entries")
    }

    /// A collapse with no offset (the preview never finished loading, so there
    /// is nothing honest to record) must still take the seat, and must not wipe
    /// a position banked on an earlier read of the same report.
    func testCollapseWithNoOffsetKeepsThePreviousPosition() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 990)

        dock.present(report)
        dock.collapse(report, offset: nil)

        XCTAssertEqual(dock.docked, report)
        XCTAssertEqual(dock.rememberedOffset(for: report), 990,
            "an unloaded preview reports offset 0 — recording that would erase a real position")
    }

    /// Sheet dismissals animate. File B can be presented while A's sheet is
    /// still on its way out, so A's late `onDisappear` arrives AFTER B claimed
    /// the screen — and must not report that nothing is presented.
    func testStaleCollapseDoesNotClearTheFileThatIsNowOnScreen() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.present(other)

        dock.collapse(report, offset: 400)

        XCTAssertEqual(dock.presented, other, "the late dismissal of the previous file must be ignored")
        XCTAssertEqual(dock.docked, other)
        XCTAssertNil(dock.rememberedOffset(for: report),
            "a stale collapse records nothing either — its offset belongs to a view that is gone")
    }

    // MARK: - Close is the only real throw-it-away

    func testCloseForgetsTheSeatButKeepsTheOffsetTableEntry() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 1300)

        dock.closeDocked()

        XCTAssertNil(dock.docked, "the x is the only thing that really throws the preview away")
        XCTAssertNil(dock.presented)
        XCTAssertFalse(dock.dockBarVisible)
        XCTAssertNil(dock.reopen())
        // "Reopening remembers where I was" is half of the ask, and one entry in
        // a bounded table is far too cheap to justify forgetting.
        XCTAssertEqual(dock.rememberedOffset(for: report), 1300)
    }

    func testOpeningAgainAfterACloseStillLandsAtTheRememberedPosition() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 2048)
        dock.closeDocked()

        // A fresh link tap on the same file, much later.
        dock.present(report)

        XCTAssertEqual(dock.rememberedOffset(for: report), 2048)
    }

    // MARK: - Exactly one seat

    func testASecondFileReplacesTheSeatRatherThanStackingOnIt() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 900)

        dock.present(other)
        dock.collapse(other, offset: 120)

        XCTAssertEqual(dock.docked, other, "there is one seat, not a stack of them")
        // Both positions survive: the seat is single, the offset table is not.
        XCTAssertEqual(dock.rememberedOffset(for: other), 120)
        XCTAssertEqual(dock.rememberedOffset(for: report), 900,
            "the evicted report must still reopen where he left it")
    }

    func testDockBarShowsOnlyWhenThereIsASeatAndNothingIsOnScreen() {
        let dock = FilePreviewDock()
        XCTAssertFalse(dock.dockBarVisible, "no preview has ever been opened")

        dock.present(report)
        XCTAssertFalse(dock.dockBarVisible, "the full preview is on screen — the bar would be redundant")

        dock.collapse(report, offset: 10)
        XCTAssertTrue(dock.dockBarVisible)

        dock.present(report)
        XCTAssertFalse(dock.dockBarVisible, "reopening hides the bar again")

        dock.collapse(report, offset: 10)
        dock.closeDocked()
        XCTAssertFalse(dock.dockBarVisible)
    }

    /// The seat is deliberately kept while the preview is presented, so a
    /// presentation that somehow fails still leaves the user a way back.
    func testTheSeatIsHeldWhileThePreviewIsPresented() {
        let dock = FilePreviewDock()
        dock.present(report)
        XCTAssertEqual(dock.docked, report)
    }

    // MARK: - Keying: host is part of the identity

    func testSamePathOnTwoHostsKeepsTwoIndependentPositions() {
        let onMac = FilePreviewTarget(path: "/tmp/out/report.html", host: nil)
        let onBox = FilePreviewTarget(path: "/tmp/out/report.html", host: "devbox")
        XCTAssertNotEqual(onMac.id, onBox.id, "same path, different disks, different documents")

        let dock = FilePreviewDock()
        dock.present(onMac)
        dock.collapse(onMac, offset: 100)
        dock.present(onBox)
        dock.collapse(onBox, offset: 5000)

        XCTAssertEqual(dock.rememberedOffset(for: onMac), 100)
        XCTAssertEqual(dock.rememberedOffset(for: onBox), 5000)
    }

    func testEmptyHostAndNilHostAreTheSameDocument() {
        // The API treats "" and nil identically ("the primary box"), so the two
        // must not key to two table entries for one file.
        let nilHost = FilePreviewTarget(path: "/tmp/a.html", host: nil)
        let emptyHost = FilePreviewTarget(path: "/tmp/a.html", host: "")
        XCTAssertEqual(nilHost.id, emptyHost.id)
    }

    func testDisplayNameIsTheFileNameNotTheWholePath() {
        XCTAssertEqual(
            FilePreviewTarget(path: "/tmp/a very/deep/path/weekly-report.html", host: nil).displayName,
            "weekly-report.html"
        )
    }

    // MARK: - The offset table is bounded

    func testOffsetTableStopsGrowingAtCapacity() {
        var table = FilePreviewOffsetTable()
        for i in 0..<(FilePreviewOffsetTable.capacity * 3) {
            table.record("file-\(i)", offset: CGFloat(i))
        }
        XCTAssertEqual(table.count, FilePreviewOffsetTable.capacity,
            "one entry per report an agent ever wrote is a leak, not a feature")
    }

    func testOffsetTableEvictsTheOldestRecordFirst() {
        var table = FilePreviewOffsetTable()
        for i in 0..<FilePreviewOffsetTable.capacity {
            table.record("file-\(i)", offset: CGFloat(i))
        }
        table.record("newcomer", offset: 42)

        XCTAssertEqual(table.offset(for: "newcomer"), 42)
        XCTAssertNil(table.offset(for: "file-0"), "the oldest record is the one that goes")
        XCTAssertEqual(table.offset(for: "file-1"), 1)
        XCTAssertEqual(table.count, FilePreviewOffsetTable.capacity)
    }

    func testRecordingAFileAgainMovesItToTheFrontInsteadOfDuplicating() {
        var table = FilePreviewOffsetTable()
        table.record("a", offset: 1)
        table.record("b", offset: 2)
        table.record("a", offset: 3)

        XCTAssertEqual(table.count, 2)
        XCTAssertEqual(table.offset(for: "a"), 3, "the newer read wins")
        XCTAssertEqual(table.keysNewestFirst.first, "a", "re-reading rescues an entry from eviction")
    }

    /// A rubber-band overscroll at the top of a document reports a NEGATIVE
    /// offset, and restoring into the bounce zone leaves the page looking
    /// broken. Clamped at write time so no reader has to remember to.
    func testNegativeOverscrollIsClampedAtWriteTime() {
        var table = FilePreviewOffsetTable()
        table.record("a", offset: -140)
        XCTAssertEqual(table.offset(for: "a"), 0)

        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: -88)
        XCTAssertEqual(dock.rememberedOffset(for: report), 0)
    }

    func testUnknownFileHasNoRememberedPosition() {
        let dock = FilePreviewDock()
        XCTAssertNil(dock.rememberedOffset(for: report))
        XCTAssertNil(dock.reopen())
    }

    // MARK: - Retention is bounded on every axis

    /// Dropping the renderer must never cost the seat or the position: the next
    /// open re-creates the web view and re-applies the remembered offset.
    func testReleasingTheRetainedRendererKeepsTheSeatAndThePosition() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 1500)

        dock.releaseRetained(reason: "background")

        XCTAssertEqual(dock.docked, report)
        XCTAssertTrue(dock.dockBarVisible)
        XCTAssertEqual(dock.rememberedOffset(for: report), 1500)
    }

    /// Blanking a document the user is currently reading, to save memory, is a
    /// worse bug than the memory.
    func testAPresentedPreviewIsNeverDroppedForMemory() {
        let dock = FilePreviewDock()
        dock.present(report)

        dock.releaseRetained(reason: "memory-warning")

        XCTAssertEqual(dock.presented, report, "the on-screen preview must survive memory pressure")
    }

    /// `.background` is the app's only suspend trigger (see RootView), and a
    /// suspended renderer's dirty pages still count against the footprint the OS
    /// kills for.
    func testBackgroundingReleasesTheRendererButNotTheSeat() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 640)

        dock.suspendForBackground()
        dock.resumeForForeground()

        XCTAssertEqual(dock.docked, report)
        XCTAssertEqual(dock.rememberedOffset(for: report), 640)
    }

    // MARK: - The P1: a chat surface must NEVER get tab-bar-only clearance
    //
    // Background the app on a session conversation page and return: the published
    // height went unknown while the composer was still on screen, `nil` was read as
    // "no composer", and the bar painted straight across
    // `chat.plus`/pill/`chat.mic`/`chat.send` (measured [12,746][390,791], 3 runs out
    // of 3). A tap aimed at SEND hit `file.dock.close`: the docked report was thrown
    // away and the draft did not send.
    //
    // The tests below used to BLESS that nil state ("a zero height is the
    // no-composer case"), which is why they were green through the whole defect. What
    // is pinned now is the invariant: while a composer surface is on screen, the
    // clearance is strictly more than the tab bar, whatever is known about its height.

    /// The invariant, swept over every state that means "a composer is on screen".
    func testAComposerSurfaceNeverGetsTabBarOnlyClearance() {
        let onScreen: [ComposerClearance] = [
            .measured(60), .measured(96), .measured(132), .measured(240),
            .measured(0), .measured(-4), .unknownHeight,
        ]
        for composer in onScreen {
            XCTAssertGreaterThan(
                FilePreviewDockBar.bottomClearance(composer: composer),
                FilePreviewDockBar.tabBarHeight,
                "\(composer) means a composer is on screen, so the seat cannot sit on the tab bar"
            )
        }
    }

    /// A zero-height report is what a composer produces for one layout pass, and what
    /// the backgrounding snapshot produces for a composer that is still on screen. It
    /// is PRESENCE without a measurement, never "there is no composer".
    func testAZeroHeightReportIsPresenceWithAnUnknownHeight() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "session:sess-9", height: 0)

        XCTAssertEqual(dock.composerClearance, .unknownHeight,
            "the composer is there; its height is what is missing")
        XCTAssertGreaterThan(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                             FilePreviewDockBar.tabBarHeight)
        XCTAssertFalse(
            FilePreviewDockBar.isVisible(hasSeat: true, keyboardUp: false,
                                         composer: dock.composerClearance),
            "with nothing honest to place the bar from it HIDES, and the seat is one tap away in the store"
        )
    }

    /// The fail-safe that makes the unknown state rare: the height this surface last
    /// really had is a far better answer than "no composer".
    func testAnUnknownHeightFallsBackToWhatThisComposerLastMeasured() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "session:sess-9", height: 150)
        dock.reportComposer(key: "session:sess-9", height: 0)

        XCTAssertEqual(dock.composerClearance, .measured(150))
        XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                       FilePreviewDockBar.tabBarHeight + 150 + FilePreviewDockBar.gap)
        XCTAssertTrue(FilePreviewDockBar.isVisible(hasSeat: true, keyboardUp: false,
                                                   composer: dock.composerClearance),
            "a remembered height is a real height, so there is no reason to hide the seat")
    }

    /// The fallback is PER KEY. A composer that has GONE says nothing about the one
    /// that replaced it, so inheriting its height would be a guess dressed as a
    /// measurement.
    func testADepartedComposersHeightIsNotInheritedByANewSurface() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat", height: 96)
        dock.reportComposer(key: "chat", height: nil)
        // Push a session page whose composer has not been measured yet.
        dock.reportComposer(key: "session:sess-9", height: 0)

        XCTAssertEqual(dock.composerClearance, .unknownHeight)
    }

    /// …but while BOTH are registered, the clearance is the taller one, and that is not
    /// inheritance — it is the only number that cannot land inside a composer that is
    /// on screen. SwiftUI runs the incoming view's `onAppear` before the outgoing
    /// view's `onDisappear`, so this overlap is the ordinary navigation shape, and a
    /// `TabView` keeps the tabs it is not showing mounted, so it can also last as long
    /// as the visit does.
    func testTheClearanceClearsTheTallestComposerThatIsStillOnScreen() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat", height: 96)
        // A session page with banners and a permission card above its composer.
        dock.reportComposer(key: "session:sess-9", height: 300)

        XCTAssertEqual(dock.composerClearance, .measured(300),
            "96pt of clearance would sit INSIDE the 300pt composer's control row")

        // And a zero-height report from the taller one (a backgrounding snapshot) does
        // not demote the answer to the shorter composer's height.
        dock.reportComposer(key: "session:sess-9", height: 0)
        XCTAssertEqual(dock.composerClearance, .measured(300))
    }

    /// THE P1's REAL PATH, replayed exactly as the instrumented app produced it
    /// (2026-08-29). The earlier fix (three-state clearance + ignore retractions while
    /// backgrounded) shipped and the defect came back, because the store was still ONE
    /// slot: the retained Chat tab's composer re-ran its `onAppear`/`onDisappear` around
    /// the foreground transition, claimed the slot, and then its own honest goodbye —
    /// arriving while the app really was `.active`, naming the key that really did own
    /// the slot — cleared the presence of the SESSION composer, which had never left.
    ///
    /// Terminal state was `.noComposer`, i.e. tab-bar-only clearance, i.e.
    /// `file.dock.close` under the send button. What is pinned here is that an
    /// invisible composer's goodbye can no longer speak for a visible one.
    func testARetainedTabsComposerCannotRetractTheVisibleComposersPresence() {
        let dock = FilePreviewDock()
        let session = "session:cb18d315"
        let retainedChat = "chat:new-general"

        // On the session page, with the Chat tab still mounted behind it.
        dock.reportComposer(key: retainedChat, height: 114)
        dock.reportComposer(key: session, height: 114)

        dock.suspendForBackground()
        dock.resumeForForeground()

        // The measured churn, twice — SwiftUI ran this pair twice in the real trail.
        for _ in 0..<2 {
            dock.reportComposer(key: retainedChat, height: 114)   // onAppear
            dock.reportComposer(key: retainedChat, height: nil)   // onDisappear
            XCTAssertEqual(dock.composerKey, session,
                "the composer that never left still owns the channel")
            XCTAssertEqual(dock.composerClearance, .measured(114))
        }

        XCTAssertNotEqual(dock.composerClearance, ComposerClearance.noComposer)
        XCTAssertGreaterThan(
            FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
            FilePreviewDockBar.tabBarHeight,
            "this is the exact state that measured bar bottom == composer bottom == 791"
        )
    }

    /// Presence is a set, so it needs the same bound as every other table here: the
    /// keys are draft keys, and a long-lived process would otherwise accumulate one per
    /// session page ever visited.
    func testPresenceIsBoundedAndRetractionRemovesOneEntryNotTheSet() {
        var presence = ComposerPresence()
        for i in 0..<(ComposerPresence.capacity * 2) {
            presence.register("session:sess-\(i)")
        }
        XCTAssertEqual(presence.count, ComposerPresence.capacity)
        XCTAssertFalse(presence.contains("session:sess-0"), "the oldest registration goes")

        let newest = "session:sess-\(ComposerPresence.capacity * 2 - 1)"
        let second = "session:sess-\(ComposerPresence.capacity * 2 - 2)"
        XCTAssertEqual(presence.newest, newest)
        presence.retract(newest)
        XCTAssertEqual(presence.newest, second, "one entry left, not the whole set")
        XCTAssertFalse(presence.isEmpty)
    }

    /// Registering an already-present composer is idempotent (its `onAppear` can run
    /// again at any time) and moves it to the front rather than duplicating it.
    func testRegisteringTheSameComposerTwiceIsOneEntry() {
        var presence = ComposerPresence()
        presence.register("chat")
        presence.register("session:sess-9")
        presence.register("chat")

        XCTAssertEqual(presence.count, 2)
        XCTAssertEqual(presence.newest, "chat")
    }

    /// The whole reported flow, end to end through the store: measure, background,
    /// take the zeroed report and the unmatched retraction that a backgrounding
    /// fires, come back. The bar must still clear the composer.
    func testBackgroundAndReturnKeepsTheComposerCleared() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 200)
        dock.reportComposer(key: "session:sess-9", height: 150)

        dock.suspendForBackground()
        // What the backgrounding snapshot actually produces (measured 3/3): a layout
        // at no height, and an `onDisappear` for a composer that never left.
        dock.reportComposer(key: "session:sess-9", height: 0)
        dock.reportComposer(key: "session:sess-9", height: nil)
        dock.resumeForForeground()

        XCTAssertEqual(dock.composerClearance, .measured(150),
            "the composer is still on screen, so the seat must still clear it")
        XCTAssertGreaterThanOrEqual(
            FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
            FilePreviewDockBar.tabBarHeight + 150,
            "this is the exact geometry that put file.dock.close under the send button"
        )
    }

    /// The store's half of the retraction guard: once `.background` has been seen, an
    /// "I'm gone" is not believed. Backgrounding fires them for composers that are
    /// still on screen, and never fires the matching `onAppear` on the way back.
    func testARetractionWhileBackgroundedIsIgnored() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat", height: 96)

        dock.suspendForBackground()
        dock.reportComposer(key: "chat", height: nil)

        XCTAssertEqual(dock.composerKey, "chat", "presence survives a backgrounding")
        XCTAssertEqual(dock.composerClearance, .measured(96))
    }

    /// The composer's own foreground re-assert (`onChange(of: scenePhase)`) races the
    /// store's `resumeForForeground` (two `scenePhase` observers with no defined
    /// order), so a POSITIVE height must be accepted even while the store still
    /// thinks the app is backgrounded. Dropping it would reintroduce the P1.
    func testAForegroundReassertIsAcceptedEvenIfItArrivesBeforeTheResume() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat", height: 96)
        dock.suspendForBackground()

        dock.reportComposer(key: "chat", height: 128)
        dock.resumeForForeground()

        XCTAssertEqual(dock.composerClearance, .measured(128))
    }

    /// The guard must not become a leak: once the app is back, a REAL navigation to a
    /// composer-less tab still drops the seat down to the tab bar. That was the other
    /// half of the original defect (46pt of clearance for a composer that is not
    /// there).
    func testARetractionAfterTheReturnIsBelievedAgain() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat", height: 96)
        dock.suspendForBackground()
        dock.resumeForForeground()

        dock.reportComposer(key: "chat", height: nil)

        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer)
        // The composer-less clearance is the tab bar plus the seat's own gap (R25) —
        // the 96pt composer is what has to be gone, not the gap.
        XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                       FilePreviewDockBar.tabBarHeight + FilePreviewDockBar.gap)
    }

    /// The height memory is bounded: the keys are draft keys, so one entry per
    /// session page ever visited would grow for the life of the process.
    func testTheComposerHeightMemoryIsBounded() {
        var memory = ComposerHeightMemory()
        for i in 0..<(ComposerHeightMemory.capacity * 3) {
            memory.record("session:sess-\(i)", height: CGFloat(100 + i))
        }

        XCTAssertEqual(memory.count, ComposerHeightMemory.capacity)
        XCTAssertNil(memory.height(for: "session:sess-0"), "the oldest key is the one that goes")
        XCTAssertEqual(memory.keysNewestFirst.first,
                       "session:sess-\(ComposerHeightMemory.capacity * 3 - 1)")
    }

    /// A zero is never remembered: the memory exists to answer "what was this
    /// composer's real height", and a remembered 0 would make the fallback produce
    /// exactly the clearance it exists to prevent.
    func testTheHeightMemoryRefusesNonMeasurements() {
        var memory = ComposerHeightMemory()
        memory.record("chat", height: 0)
        memory.record("chat", height: -12)
        XCTAssertNil(memory.height(for: "chat"))
        XCTAssertEqual(memory.count, 0)
    }

    // MARK: - The second P1: the clearance belongs to the SURFACE ON SCREEN
    //
    // Presence-as-a-set fixed "an invisible composer's goodbye erased a visible one",
    // and left a second defect standing: with a set, the clearance was a max over every
    // composer that EXISTS. Measured on the shipping build with a preview docked,
    // `file.dock.bar` [12,575][390,620] IDENTICALLY on Settings, Notes, Inbox and the
    // Tasks search results — stranded ~171pt above the tab bar, floating mid-content and
    // hiding a row — plus the same root cause's second symptom on the Chat tab, where the
    // seat was placed from an OFF-SCREEN composer's height instead of its own.
    //
    // Two mechanisms, neither of which a retraction can fix:
    //  1. The chat composer's draft key follows `ChatStore.activeID` (nil → hydrated →
    //     nil again on `switchAgent`). A key change re-identifies nothing, so no
    //     `onDisappear` runs, so the key it left behind stayed registered for the life of
    //     the process and presence could never empty.
    //  2. A `TabView` keeps its off-screen tabs MOUNTED, so those composers keep
    //     reporting (and re-run their `onAppear`) while the user is somewhere else. A
    //     mounted view cannot tell "my tab is in front" from "I exist".
    //
    // So the seat is placed from the surface the app SAYS is on screen (`MainTabView`
    // publishes the tab, a pushed session page claims on top), and every composer names
    // the surface it is on. What is pinned below is that a composer nobody can see
    // contributes nothing, while a composer the user IS looking at can never be argued
    // away — whatever order SwiftUI chooses to run its callbacks in.

    /// (a) The core of the defect: a registered composer on a tab that is not showing
    /// must contribute NOTHING. This is the exact measured state — a docked preview, the
    /// chat composer mounted and registered, the user on Settings.
    func testAnOffScreenTabsComposerContributesNothingToTheClearance() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 400)
        dock.setComposerSurfaceBase(.chatTab)
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 135)
        XCTAssertEqual(dock.composerClearance, .measured(135), "on the Chat tab it is the answer")

        // Switch to Settings. The chat composer is still mounted and still registered —
        // that is what a TabView does — and it is no longer the seat's business.
        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .settings))

        XCTAssertTrue(dock.composers.contains("chat:conv-1"), "still mounted, still registered")
        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer)
        XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                       FilePreviewDockBar.tabBarHeight + FilePreviewDockBar.gap,
            "this is the 171pt of stranded clearance that hid a row of Settings")
    }

    /// (b) The R23 invariant, replayed through the surfaces. The retained Chat tab's
    /// composer re-runs `onAppear`/`onDisappear` around the foreground transition (the
    /// measured trail, twice), and none of it may reach the session composer the user is
    /// looking at — including the belt for the worst ordering, where the VISIBLE
    /// composer's own presence is retracted while its page is still on screen.
    func testTheForegroundingRaceStillResolvesToTheVisibleComposersHeight() {
        let dock = FilePreviewDock()
        let sessionId = "cb18d315"
        let sessionKey = "session:\(sessionId)"
        let retainedChat = "chat:new-general"

        // A session page pushed from the Tasks tab, Chat tab mounted behind it.
        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .tasks))
        let claim = dock.claimComposerSurface(.session(sessionId))
        dock.reportComposer(key: retainedChat, surface: .chatTab, height: 114)
        dock.reportComposer(key: sessionKey, surface: .session(sessionId), height: 300)
        XCTAssertEqual(dock.activeComposerSurface, .session(sessionId))

        dock.suspendForBackground()
        dock.resumeForForeground()

        // The measured churn, twice, in the order the instrumented app produced it.
        for _ in 0..<2 {
            dock.reportComposer(key: retainedChat, surface: .chatTab, height: 114)  // onAppear
            dock.reportComposer(key: retainedChat, surface: .chatTab, height: nil)  // onDisappear
            XCTAssertEqual(dock.composerClearance, .measured(300),
                "the composer that never left is the one the seat clears")
        }

        // The worst ordering: the VISIBLE composer's own retraction, believed. Its page
        // is still on screen and still owns the surface, so the seat may not drop onto it.
        dock.reportComposer(key: sessionKey, surface: .session(sessionId), height: nil)
        XCTAssertNotEqual(dock.composerClearance, ComposerClearance.noComposer,
            "a chat surface NEVER gets tab-bar-only clearance")
        XCTAssertGreaterThanOrEqual(
            FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
            FilePreviewDockBar.tabBarHeight + 300,
            "this is the exact state that measured bar bottom == composer bottom == 791"
        )

        dock.releaseComposerSurface(claim)
        XCTAssertEqual(dock.activeComposerSurface, MainTabView.composerSurface(for: .tasks))
    }

    /// (c) The other half: a composer-less surface really does drop the seat down to the
    /// tab bar (plus the seat's own 6pt gap, R25), even with two composers registered
    /// elsewhere. Four tabs, one answer — the measurement that started this was four
    /// IDENTICAL stranded frames.
    func testAComposerLessSurfaceIsTabBarOnlyEvenWithOtherComposersRegistered() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 135)
        dock.reportComposer(key: "session:s1", surface: .session("s1"), height: 300)

        for tab in [MainTabView.Tab.inbox, .notes, .tasks, .settings] {
            dock.setComposerSurfaceBase(MainTabView.composerSurface(for: tab))
            XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer, "\(tab)")
            XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                           FilePreviewDockBar.tabBarHeight + FilePreviewDockBar.gap, "\(tab)")
        }
        XCTAssertEqual(dock.composers.count, 2, "both composers are still mounted elsewhere")
    }

    /// (d) The clearance follows the SURFACE, not a retraction. Nothing retracts here at
    /// all: a retained tab's composer may never send an `onDisappear`, and the seat still
    /// has to be right on both sides of the switch.
    func testASurfaceSwitchUpdatesTheClearanceWithoutWaitingForARetraction() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 120)
        XCTAssertEqual(dock.composerClearance, .measured(120))

        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .notes))
        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer,
            "no report of any kind was needed to get this right")

        dock.setComposerSurfaceBase(.chatTab)
        XCTAssertEqual(dock.composerClearance, .measured(120),
            "and coming back does not have to wait for a re-measure either")
    }

    /// The first mechanism, end to end: the chat composer's key changes under it (nil
    /// `activeID` → hydrated) with no appear/disappear pair, and the key it leaves behind
    /// must not stay registered — that orphan is what made every composer-less tab
    /// inherit 135pt, and what placed the Chat tab's own seat from a height it no longer
    /// had.
    func testAChangedDraftKeyLeavesNothingRegisteredBehindIt() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        // Cold launch: ChatStore.activeID is nil, so the key is agent-scoped.
        dock.reportComposer(key: "chat:new-general", surface: .chatTab, height: 135)
        // Hydration fills activeID. Publisher #4 (`onChange(of: draftKey)`) hands off.
        dock.reportComposer(key: "chat:new-general", surface: .chatTab, height: nil)
        dock.reportComposer(key: "chat:conv-77", surface: .chatTab, height: 96)

        XCTAssertEqual(dock.composers.count, 1)
        XCTAssertEqual(dock.composerKey, "chat:conv-77")
        XCTAssertEqual(dock.composerClearance, .measured(96),
            "the Chat tab is placed from ITS OWN composer, not from the tallest thing ever measured")
    }

    /// A surface that has measured a composer HAS one: a screen does not lose its input
    /// bar while it stays on screen, so a retraction that arrives anyway (the D1 shape —
    /// SwiftUI picks the ordering and has picked wrong before) must not produce
    /// tab-bar-only clearance. Only a surface that has never had a composer does.
    func testASurfaceThatHasMeasuredAComposerNeverGoesTabBarOnly() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 132)
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: nil)

        XCTAssertTrue(dock.composers.isEmpty, "the retraction was honest about its own entry")
        XCTAssertEqual(dock.composerClearance, .measured(132),
            "the Chat tab still has a composer — the callback was wrong, not the screen")
        XCTAssertGreaterThan(
            FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
            FilePreviewDockBar.tabBarHeight)

        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .settings))
        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer,
            "a surface that has never had a composer is the only thing that sits on the tab bar")
    }

    /// Presence entries carry their surface, and an `.unattached` composer (one that has
    /// not declared a screen) counts everywhere — the safe direction, since a seat that
    /// floats above a composer nobody can see is cosmetic while a seat on the send button
    /// ate a draft.
    func testPresenceEntriesAnswerOnlyForTheirOwnSurface() {
        var presence = ComposerPresence()
        presence.register("chat:conv-1", surface: .chatTab)
        presence.register("session:s1", surface: .session("s1"))
        presence.register("draft:new-session")

        XCTAssertEqual(presence.keys(onSurface: .chatTab), ["draft:new-session", "chat:conv-1"])
        XCTAssertEqual(presence.keys(onSurface: .session("s1")), ["draft:new-session", "session:s1"])
        XCTAssertEqual(presence.keys(onSurface: .tab("settings")), ["draft:new-session"])
        XCTAssertEqual(presence.keys(onSurface: .unattached).count, 3,
            "nothing published yet (a harness, a test, the first update cycle): everything counts")
        XCTAssertEqual(presence.surface(for: "chat:conv-1"), .chatTab)

        // One composer is on one screen: a key that comes back naming another surface is
        // re-pointed, not duplicated.
        presence.register("chat:conv-1", surface: .session("s1"))
        XCTAssertEqual(presence.count, 3)
        XCTAssertEqual(presence.surface(for: "chat:conv-1"), .session("s1"))
        XCTAssertEqual(presence.keys(onSurface: .chatTab), ["draft:new-session"])
    }

    /// A pushed page owns the surface while its tab is selected, and the tab switch needs
    /// no cooperation from its `onDisappear`: the claim goes dormant with the base and
    /// revives with it, so returning to the tab is right even if `onAppear` never re-runs.
    func testAPushedPageClaimsTheSurfaceAndATabSwitchNeedsNoRelease() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .tasks))
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 96)

        let token = dock.claimComposerSurface(.session("s1"))
        dock.reportComposer(key: "session:s1", surface: .session("s1"), height: 240)
        XCTAssertEqual(dock.composerClearance, .measured(240))

        // Off to the Chat tab with the page still pushed.
        dock.setComposerSurfaceBase(.chatTab)
        XCTAssertEqual(dock.activeComposerSurface, .chatTab)
        XCTAssertEqual(dock.composerClearance, .measured(96), "the Chat tab's own composer")
        XCTAssertFalse(dock.releaseComposerSurface(token),
            "a disappear that arrives on another tab is the tab switch, not a pop")

        // Back to Tasks: the dormant claim answers again.
        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .tasks))
        XCTAssertEqual(dock.activeComposerSurface, .session("s1"))
        XCTAssertEqual(dock.composerClearance, .measured(240))

        // A real pop, on the page's own tab.
        XCTAssertTrue(dock.releaseComposerSurface(token))
        XCTAssertEqual(dock.activeComposerSurface, MainTabView.composerSurface(for: .tasks))
        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer,
            "the task board has no composer of its own")
    }

    /// The first frame of a pushed session page: it owns the surface, but its composer has
    /// not run a geometry pass yet. The seat HIDES for those frames. The two alternatives
    /// are both the P1 wearing a hat — place it from the tab's composer behind the page
    /// (a 96pt clearance under a 300pt composer), or drop it onto the tab bar.
    func testAClaimedSurfacesFirstPaintHidesTheSeatInsteadOfGuessing() {
        let dock = FilePreviewDock()
        dock.present(report)
        dock.collapse(report, offset: 100)
        dock.setComposerSurfaceBase(.chatTab)
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 96)

        // Push a session page from the Chat tab's own stack: claimed, nothing measured.
        _ = dock.claimComposerSurface(.session("brand-new"))

        XCTAssertEqual(dock.composerClearance, .unknownHeight)
        XCTAssertFalse(
            FilePreviewDockBar.isVisible(hasSeat: dock.dockBarVisible, keyboardUp: false,
                                         composer: dock.composerClearance),
            "the seat, the file and the scroll position all survive in the store — it costs one tap"
        )
        XCTAssertGreaterThan(
            FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
            FilePreviewDockBar.tabBarHeight,
            "and even the state that should never be painted is not tab-bar-only")

        // The first real measurement lands and the seat comes back, at ITS height.
        dock.reportComposer(key: "session:brand-new", surface: .session("brand-new"), height: 300)
        XCTAssertEqual(dock.composerClearance, .measured(300))
        XCTAssertTrue(FilePreviewDockBar.isVisible(hasSeat: dock.dockBarVisible, keyboardUp: false,
                                                   composer: dock.composerClearance))
    }

    /// The claim's half of the retraction guard: a backgrounding snapshot's `onDisappear`
    /// is not proof that a page is gone, and believing it would hand the surface back to
    /// the tab underneath while the session composer is still right there.
    func testASurfaceReleaseWhileBackgroundedIsNotBelieved() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(MainTabView.composerSurface(for: .tasks))
        let token = dock.claimComposerSurface(.session("s1"))
        dock.reportComposer(key: "session:s1", surface: .session("s1"), height: 300)

        dock.suspendForBackground()
        XCTAssertFalse(dock.releaseComposerSurface(token))
        XCTAssertEqual(dock.composerClearance, .measured(300))

        dock.resumeForForeground()
        XCTAssertEqual(dock.activeComposerSurface, .session("s1"),
            "the page never left, so it still owns the surface")
        XCTAssertTrue(dock.releaseComposerSurface(token), "and a real pop is still believed")
    }

    /// Bounded like every other table here: a claim can leak (its page destroyed while
    /// its tab was not selected), so the stack cannot be allowed to grow per visit. A
    /// leaked claim below the top is harmless — the top matching one wins.
    func testTheSurfaceClaimStackIsBounded() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        for i in 0..<(FilePreviewDock.surfaceClaimCapacity * 2) {
            _ = dock.claimComposerSurface(.session("s\(i)"))
        }

        XCTAssertEqual(dock.composerSurfaceClaims.count, FilePreviewDock.surfaceClaimCapacity)
        XCTAssertEqual(dock.activeComposerSurface,
                       .session("s\(FilePreviewDock.surfaceClaimCapacity * 2 - 1)"),
            "the newest claim is the one on top")
    }

    /// Tab identity, and the one place it has to line up with a composer: the Chat tab's
    /// surface is what `ComposerView` declares. Two tabs sharing a surface would let one
    /// tab's composer place the other's seat.
    func testEveryTabIsItsOwnComposerSurface() {
        let tabs: [MainTabView.Tab] = [.chat, .inbox, .notes, .tasks, .settings]
        let surfaces = tabs.map { MainTabView.composerSurface(for: $0) }

        XCTAssertEqual(Set(surfaces).count, tabs.count)
        XCTAssertEqual(MainTabView.composerSurface(for: .chat), .chatTab,
            "the chat composer registers for .chatTab; the tab table has to agree")
        XCTAssertFalse(surfaces.contains(.unattached),
            "a tab that resolved to .unattached would answer for every surface at once")
        XCTAssertNotEqual(ComposerSurfaceID.session("s1"), ComposerSurfaceID.session("s2"))
    }

    // MARK: - Keyboard timing (P2)

    /// The bar is hidden outright while the keyboard is up: hidden cannot cover the
    /// send button under ANY keyboard height, and nobody navigates mid-sentence.
    func testTheSeatIsHiddenWhileTheKeyboardIsUp() {
        XCTAssertFalse(FilePreviewDockBar.isVisible(hasSeat: true, keyboardUp: true,
                                                    composer: .measured(96)))
        XCTAssertTrue(FilePreviewDockBar.isVisible(hasSeat: true, keyboardUp: false,
                                                   composer: .measured(96)))
        XCTAssertFalse(FilePreviewDockBar.isVisible(hasSeat: false, keyboardUp: false,
                                                    composer: .measured(96)),
            "no seat, no bar, whatever the keyboard is doing")
    }

    /// The return rides the keyboard's OWN dismiss timing (P2, 2026-08-29: the seat
    /// arrived ~170ms after the composer had already landed, because a spring's
    /// visible settle outlasts its nominal duration). A notification that carries no
    /// usable duration falls back rather than animating in zero time.
    func testTheKeyboardsAnnouncedDurationDrivesTheReturn() {
        XCTAssertEqual(
            FilePreviewDockBar.keyboardDuration(
                [UIResponder.keyboardAnimationDurationUserInfoKey: 0.35]),
            0.35, accuracy: 0.0001)
        XCTAssertEqual(FilePreviewDockBar.keyboardDuration(nil),
                       FilePreviewDockBar.defaultKeyboardDuration)
        XCTAssertEqual(FilePreviewDockBar.keyboardDuration([:]),
                       FilePreviewDockBar.defaultKeyboardDuration)
        XCTAssertEqual(
            FilePreviewDockBar.keyboardDuration(
                [UIResponder.keyboardAnimationDurationUserInfoKey: 0.0]),
            FilePreviewDockBar.defaultKeyboardDuration,
            "a zero duration would make the return a jump-cut")
    }

    // MARK: - The bar's geometry and automation contract

    /// The bar is an overlay on the tab view, whose bounds include the tab bar, and
    /// it must clear the WHOLE composer: a seat that covers the send button breaks
    /// the very thing he collapses the report to do.
    ///
    /// These assertions used to pin the ARITHMETIC (`tabBar + 32 + 6 + 8 + gap`) and
    /// were green while the shipped bar sat ON the text field — measured,
    /// `file.dock.bar` [12,694][390,739] fully CONTAINED `chat.composer`
    /// [28,714][374,736]. A test that restates the implementation's sum can only
    /// ever prove the sum was copied correctly, which is exactly what happened: the
    /// sum counted the composer's bottom control row, and the composer is a STACK
    /// (notices, voice-retry row, thumbnail strip, a field that grows to six lines,
    /// then that row). So what is pinned now is the RULE the geometry has to satisfy,
    /// stated without reference to any composer constant.
    func testDockClearanceIsTheWholePublishedComposerHeight() {
        // 46 is the OLD hand-derived control-row height. A composer that is really
        // 132pt tall (notices + retry row + a three-line field + the control row)
        // must be cleared in full, not to a fraction of itself.
        let clearance = FilePreviewDockBar.bottomClearance(composer: .measured(132))
        XCTAssertEqual(clearance,
                       FilePreviewDockBar.tabBarHeight + 132 + FilePreviewDockBar.gap)
        XCTAssertGreaterThanOrEqual(clearance, FilePreviewDockBar.tabBarHeight + 132,
            "a seat that overlaps ANY part of the composer can cover the send button")
    }

    /// The other half of the rule, and the other half of the defect: on a tab with
    /// no composer (Settings, Notes) the old constant floated the bar 46pt above the
    /// tab bar, clearing something that is not there.
    ///
    /// It clears the tab bar plus the SAME 6pt gap the composer case gets (R25). The
    /// first version of this rule returned a bare `tabBarHeight`, and on the built
    /// binary the capsule's rounded corners met the tab bar's top edge with nothing
    /// between them — a floating pill welded to the chrome. The gap belongs to the
    /// seat, not to the composer.
    func testDockClearsTheTabBarByTheSameGapOnAComposerlessTab() {
        XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: .noComposer),
                       FilePreviewDockBar.tabBarHeight + FilePreviewDockBar.gap,
            "the seat must not touch the tab bar on Settings / Notes / Inbox")
        XCTAssertGreaterThan(FilePreviewDockBar.gap, 0, "a zero gap is the welded look")
    }

    /// The seat's placement is the same SHAPE on every surface: tab bar, then a gap,
    /// then whatever else is down there. Stated as a comparison so a future edit that
    /// re-special-cases one branch has to fail here.
    func testEveryClearanceLeavesTheSameGapAboveTheChrome() {
        let bare = FilePreviewDockBar.bottomClearance(composer: .noComposer)
        let withComposer = FilePreviewDockBar.bottomClearance(composer: .measured(120))
        XCTAssertEqual(bare - FilePreviewDockBar.tabBarHeight, FilePreviewDockBar.gap)
        XCTAssertEqual(withComposer - bare, 120, "the only difference is the composer itself")
    }

    /// The seat and the thing it sits on have to share their left and right edges.
    ///
    /// Measured (R26): `file.dock.bar` spanned x 12..390 (378pt) while the floating tab
    /// pill beneath it spans x 21..381 (360pt) on a 402pt screen — the seat overhung its
    /// own seat-back by 9pt on each side, which reads as a mis-cut piece of chrome rather
    /// than a card resting on the tab bar. The inset is the PILL's now, so the two
    /// capsules are the same width and start at the same x.
    func testTheSeatSitsOnTheTabPillsOwnInsets() {
        let screen: CGFloat = 402
        let pill = (minX: CGFloat(21), maxX: CGFloat(381))

        let seat = (
            minX: FilePreviewDockBar.horizontalInset,
            maxX: screen - FilePreviewDockBar.horizontalInset
        )
        XCTAssertEqual(seat.minX, pill.minX, accuracy: 0.01, "the seat starts left of the pill")
        XCTAssertEqual(seat.maxX, pill.maxX, accuracy: 0.01, "the seat ends right of the pill")
        XCTAssertEqual(seat.maxX - seat.minX, pill.maxX - pill.minX, accuracy: 0.01)

        // The defect, restated so the fix is measured against it: the shipped 12pt inset
        // overhung by 9pt a side. If this stops reproducing, the fixture is wrong.
        let shippedInset: CGFloat = 12
        XCTAssertEqual(pill.minX - shippedInset, 9, accuracy: 0.01)
        XCTAssertGreaterThan(FilePreviewDockBar.horizontalInset, shippedInset)

        // And the inset is a seat, not a squeeze: on the narrowest phone the bar still
        // gets the overwhelming majority of the width for a file name.
        let narrowest: CGFloat = 320
        let usable = narrowest - 2 * FilePreviewDockBar.horizontalInset
        XCTAssertGreaterThan(usable / narrowest, 0.85, "the seat lost its width to the inset")
    }

    /// Clearance must be MONOTONIC in the composer's height: the whole point of
    /// publishing a live measurement is that a growing draft pushes the seat up.
    func testClearanceGrowsWithTheComposer() {
        let short = FilePreviewDockBar.bottomClearance(composer: .measured(90))
        let tall = FilePreviewDockBar.bottomClearance(composer: .measured(240))
        XCTAssertGreaterThan(tall, short,
            "a six-line draft is taller than an empty one and the seat has to move")
    }

    // MARK: - The published-height channel

    /// The store is the channel, and the report is KEYED. SwiftUI runs an incoming
    /// view's `onAppear` before the outgoing view's `onDisappear`, so an unkeyed
    /// retraction would erase the height of the composer that is actually on screen
    /// and drop the seat onto its text field.
    func testAStaleRetractionCannotEraseTheLiveComposersHeight() {
        let dock = FilePreviewDock()
        XCTAssertNil(dock.composerHeight, "no composer has reported yet")

        dock.reportComposer(key: "chat:conv-1", height: 96)
        XCTAssertEqual(dock.composerHeight, 96)

        // Navigate to a session page: the new composer reports before the old one
        // says goodbye.
        dock.reportComposer(key: "session:sess-9", height: 150)
        dock.reportComposer(key: "chat:conv-1", height: nil)

        XCTAssertEqual(dock.composerHeight, 150,
            "the departing composer's retraction belongs to a view that is gone")
    }

    /// Leaving for a composer-less tab really does clear it, so the bar drops onto
    /// the tab bar instead of floating above a composer that is no longer there.
    ///
    /// This is the pre-surface channel (no `surface:` argument, so the composer answers
    /// for every surface — see `ComposerSurfaceID`). For a composer that DOES declare its
    /// screen, the same drop comes from the surface changing rather than from the
    /// retraction arriving: `testASurfaceSwitchUpdatesTheClearanceWithoutWaitingForARetraction`.
    func testTheLiveComposersOwnRetractionClearsTheHeight() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "chat:conv-1", height: 96)
        dock.reportComposer(key: "chat:conv-1", height: nil)

        XCTAssertNil(dock.composerHeight)
        XCTAssertEqual(dock.composerClearance, ComposerClearance.noComposer,
            "the composer really left: this is the one case that clears the tab bar alone")
        XCTAssertEqual(FilePreviewDockBar.bottomClearance(composer: dock.composerClearance),
                       FilePreviewDockBar.tabBarHeight + FilePreviewDockBar.gap)
    }

    /// The hide-while-unknown leg now writes ONE log line (subsystem "dock") naming the
    /// surface, because a field report of "the seat vanished on Notes" had nothing in
    /// the log to distinguish it from a closed preview. What is asserted here is the
    /// part that could regress: the logging added state, and that state must not change
    /// the answer or make it flip between reads.
    func testTheUnknownHeightLegIsStableAcrossRepeatedReads() {
        let dock = FilePreviewDock()
        dock.setComposerSurfaceBase(.chatTab)
        // Registered, laid out at zero height (the backgrounding snapshot / first pass).
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 0)
        for _ in 0..<5 {
            XCTAssertEqual(dock.composerClearance, ComposerClearance.unknownHeight,
                "a body-pass storm must keep getting the same answer")
        }
        // And a real measurement still takes over immediately.
        dock.reportComposer(key: "chat:conv-1", surface: .chatTab, height: 118)
        XCTAssertEqual(dock.composerClearance, ComposerClearance.measured(118))
        XCTAssertTrue(FilePreviewDockBar.isVisible(
            hasSeat: true, keyboardUp: false, composer: dock.composerClearance
        ), "a measured height brings the seat straight back")
    }

    /// A composer that grows while it is on screen (typing into a six-line draft)
    /// keeps updating the same key.
    func testTheSameComposerCanRevisitItsHeight() {
        let dock = FilePreviewDock()
        dock.reportComposer(key: "session:sess-9", height: 96)
        dock.reportComposer(key: "session:sess-9", height: 188)
        XCTAssertEqual(dock.composerHeight, 188)
    }

    /// Automation (maestro / XCUITest) matches identifiers as REGEXES, and a raw
    /// name with `|`, `(`, `.`, or `+` in it has already made an element
    /// unaddressable once in this app. Every id the dock ships must stay inside
    /// [A-Za-z0-9._-].
    func testAccessibilityIdentifiersAreRegexSafe() {
        let safe = try! NSRegularExpression(pattern: "^[A-Za-z0-9._-]+$")
        for id in ["file.dock.bar", "file.dock.close", "file.htmlPreview", "file.preview.done"] {
            let range = NSRange(id.startIndex..., in: id)
            XCTAssertNotNil(safe.firstMatch(in: id, range: range), "\(id) is not regex-safe")
        }
    }
}
