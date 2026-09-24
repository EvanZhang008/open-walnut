import XCTest

/// THE MODEL PILL HEALS ITSELF, driven as a finger drives it.
///
/// The field report (TestFlight build 82, phone on a cloud replica): the chat
/// composer's model menu showed ONE row, "Opus 5", for 5.5 hours while the Mac
/// offered ten models. The Mac's bridge to the replica had blipped for about 1.3s,
/// the phone's only `GET /api/v1/chat/engine` landed in the gap, and the phone never
/// asked again: the only refresh path was a Retry button that only the unreachable
/// state showed.
///
/// Every assertion here is a SCREEN fact (what the pill and its menu say) or a WIRE
/// fact (what the stub was asked, and when). Nothing reaches into the app, and no
/// test ever taps Retry: healing without a tap is the whole claim.
///
/// The box is `tests/ui/mid-turn-stub-server.mjs`, told what to answer through
/// `POST /__stub/engine?mode=…`: `unreachable` is the 503 `primary_unreachable` a
/// current replica answers while the Mac is away, `degraded` is the one-model
/// answer an OLD replica gave (the reported state), and `lane` is the Mac itself,
/// whose session serves the full ten-row catalog.
///
/// RUN IT WITH `ios-native/tests/ui/run-ui-tests.sh` and the stub running (see
/// `MidTurnQueueUITests` for why a bare `xcodebuild` skips every case here).
final class ModelPillHealUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// The pills once they show the Mac's current model (Fable 5.1, High).
    private static let healedLabel = "Model: Fable 5.1"
    private static let healedEffort = "Effort: High"
    /// Rows only the Mac's catalog has; the degraded answer has none of them.
    /// Spelled as the Mac's picker spells them (`catalogRowLabel`), which is the
    /// point: "Haiku 4.5", not the catalog's bare "Haiku".
    private static let catalogOnlyRows = ["Default (Opus 5.5 1M)", "Opus 5.5 1M", "Haiku 4.5", "GPT-6 Astra"]

    /// The Mac's rows, top to bottom: `sortByModelStrength` over the real catalog,
    /// as the web computes it (`ModelStrengthOrderTests` pins the same list).
    private static let macOrder = [
        "Haiku 4.5", "GPT-6 Luna", "Sonnet 5", "GPT-6 Astra", "Fable 5 1M", "Fable 5.1 1M",
        "GPT-5.6 Sol", "GPT-6 Sol", "Default (Opus 5.5 1M)", "Opus 5.5 1M",
    ]

    // MARK: - Scenario 1: unreachable, spaced retries, heals with no tap

    @MainActor
    func testAnUnreachableLookupRetriesOnItsOwnSpacedOutAndHealsWithoutATap() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("unreachable")
        let app = try launchPaired()
        openChatTab(app)
        XCTAssertTrue(element(app, "chat.composer").waitForExistence(timeout: 45), "the chat composer never appeared")

        // A fresh launch with the Mac away used to show NO pill and no Retry. The
        // pill shows, says the model is unknown, and its menu offers the retry.
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: unknown", timeout: 20),
                      "no unreachable pill on a fresh launch (reads \(pill.exists ? pill.label : "absent"))")
        try await openMenu(app, pill)
        XCTAssertTrue(element(app, "composer.modelPill.retry").waitForExistence(timeout: 5),
                      "the unreachable pill's menu offers no Retry")
        try await stub.screenshot(app, "model-pill-00-fresh-launch-unreachable-menu")
        closeMenu(app)

        // The Mac is away. Let the phone retry on its own for a while.
        try await Task.sleep(for: .seconds(10))
        let whileDown = try await stub.engineGets()
        XCTAssertGreaterThanOrEqual(
            whileDown.count, 3,
            "the phone asked \(whileDown.count) time(s) in 10s of the Mac being away: it is not "
                + "retrying on its own, which is the reported bug"
        )
        XCTAssertLessThanOrEqual(
            whileDown.count, 8,
            "the phone asked \(whileDown.count) times: that is a hot loop, not a backoff"
        )
        let gaps = zip(whileDown.dropFirst(), whileDown).map { $0.at.timeIntervalSince($1.at) }
        XCTAssertTrue(
            gaps.allSatisfy { $0 >= 0.8 },
            "two engine lookups were closer than the first rung (1s): gaps \(Self.fmt(gaps))"
        )
        XCTAssertTrue(
            zip(gaps.dropFirst(), gaps).allSatisfy { $0 >= $1 * 0.8 },
            "the retry gaps are not backing off: \(Self.fmt(gaps))"
        )
        try await stub.screenshot(app, "model-pill-01-mac-unreachable")

        // The Mac comes back. Nobody touches anything.
        let flippedAt = Date()
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 45),
            "the pill did not heal within 45s of the Mac coming back (it reads "
                + "\(pill.exists ? pill.label : "absent")) and no Retry was tapped"
        )
        let healedAfter = Date().timeIntervalSince(flippedAt)
        XCTAssertLessThanOrEqual(healedAfter, 35, "healing took \(Int(healedAfter))s, past the ladder's 30s cap")
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-02-healed-menu")
        try await assertEffortPillOffersTheLevels(app, shot: "model-pill-02-healed-effort")

        let options = try await stub.requests().filter { $0.path.hasSuffix("/model-options") }
        XCTAssertFalse(options.isEmpty, "the healed pill never read the lane session's catalog")
    }

    // MARK: - Scenario 2: an old replica's one-model answer heals by itself

    @MainActor
    func testAOneModelAnswerFromAnOldReplicaHealsWithinSecondsWithoutATap() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)

        // The reported state: one model, and the menu offers only it.
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")
        try await openMenu(app, pill)
        // Proof the menu is OPEN, without which "the rows are absent" is vacuous.
        XCTAssertTrue(app.buttons["Opus 5"].waitForExistence(timeout: 5), "the model menu did not open")
        for row in Self.catalogOnlyRows {
            XCTAssertFalse(app.buttons[row].exists, "the degraded menu already lists \(row)")
        }
        try await stub.screenshot(app, "model-pill-03-degraded-one-row")
        closeMenu(app)

        // The Mac answers again. Nobody touches anything: the suspect answer is
        // rechecked on the ladder's early rungs, not left to the 60s TTL.
        let flippedAt = Date()
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 30),
            "the one-model answer did not heal on its own (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        let healedAfter = Date().timeIntervalSince(flippedAt)
        XCTAssertLessThan(healedAfter, 20, "the heal took \(Int(healedAfter))s: that is the TTL, not a recheck")
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-04-recheck-healed-menu")
    }

    // MARK: - Scenario 3: a settled answer is re-validated on foreground

    @MainActor
    func testASettledAnswerIsReaskedWhenTheAppComesBackToTheFront() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        // Let the rechecks run out (1 + 2 + 4 + 8 + 15s), so no timer is due for a
        // minute and only the foreground can explain a heal.
        XCTAssertTrue(
            waitUntil(timeout: 60) { ((try? self.syncEngineGets(stub).count) ?? 0) >= 6 },
            "the suspect answer was not rechecked five times"
        )
        try await Task.sleep(for: .seconds(2))
        try await stub.setEngine("lane")
        let beforeHome = try await stub.engineGets().count
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        let asksInBackground = try await stub.engineGets().count - beforeHome
        XCTAssertEqual(asksInBackground, 0, "the pill asked \(asksInBackground) time(s) from the background")
        let activatedAt = Date()
        app.activate()

        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 20),
            "coming back to the app did not re-ask (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        let healedAfter = Date().timeIntervalSince(activatedAt)
        XCTAssertLessThan(healedAfter, 15, "the heal took \(Int(healedAfter))s: that is the TTL, not the foreground")
    }

    // MARK: - Scenario 4 (the gate's P1): nothing changes under an open menu

    /// The gate's repro: the degraded one-row menu is OPEN, the Mac comes back,
    /// and the answer lands. The menu used to rebuild under the finger, and a tap
    /// where "Opus 5" had been picked GPT-6 Luna (a real `POST …/model`). Now the
    /// rows hold until the menu closes, the same tap writes nothing, and the new
    /// rows arrive after the close.
    @MainActor
    func testAnAnswerLandingWhileTheMenuIsOpenNeverMovesTheRowsUnderTheFinger() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        try await openMenu(app, pill)
        let oldRow = app.buttons["Opus 5"]
        XCTAssertTrue(oldRow.waitForExistence(timeout: 5), "the model menu did not open")
        let oldRowCentre = CGPoint(x: oldRow.frame.midX, y: oldRow.frame.midY)
        let asksBefore = try await stub.engineGets().count
        let optionsBefore = try await stub.requests().filter { $0.path.hasSuffix("/model-options") }.count

        // The Mac comes back WHILE the menu is open.
        try await stub.setEngine("lane")
        XCTAssertTrue(
            waitUntil(timeout: 20) {
                let records = (try? self.syncRequests(stub)) ?? []
                return records.filter { $0.path.hasSuffix("/model-options") }.count > optionsBefore
            },
            "no re-ask reached the Mac's catalog while the menu was open, so this would prove nothing"
        )
        let asksWhileOpen = try await stub.engineGets().count - asksBefore
        XCTAssertGreaterThanOrEqual(asksWhileOpen, 1)
        // Give a rebuild every chance to happen.
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(oldRow.exists, "the row under the finger vanished while the menu was open")
        XCTAssertEqual(CGPoint(x: oldRow.frame.midX, y: oldRow.frame.midY), oldRowCentre,
                       "the row under the finger moved while the menu was open")
        for row in Self.catalogOnlyRows {
            XCTAssertFalse(app.buttons[row].exists, "\(row) appeared in the OPEN menu: it was rebuilt under the finger")
        }
        try await stub.screenshot(app, "model-pill-05-menu-open-answer-waiting")

        // The finger lands where the old row was.
        app.windows.firstMatch.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: oldRowCentre.x, dy: oldRowCentre.y)).tap()
        try await Task.sleep(for: .seconds(2))
        let writes = try await stub.requests().filter { record in
            (record.method == "POST" && (record.path.hasSuffix("/model") || record.path.hasSuffix("/effort")))
                || (record.method == "PUT" && record.path.hasSuffix("/chat/model"))
        }
        XCTAssertTrue(writes.isEmpty, "a tap on the unchanged row WROTE a model: \(writes.map(\.path))")

        // Closed: the waiting answer lands now.
        XCTAssertTrue(
            waitForLabel(pill, Self.healedLabel, timeout: 5),
            "the answer that waited for the close never landed (pill reads \(pill.exists ? pill.label : "absent"))"
        )
        try await assertMenuListsTheWholeCatalog(app, pill, shot: "model-pill-06-after-close-menu")
    }

    /// The open and close signals fire on EVERY open, not just the first (the
    /// reason SwiftUI's `Menu` could not be kept: its content `onAppear` fires on
    /// the first open only). Three rounds: each time an answer lands while the
    /// menu is open, the menu keeps its row, and the pill takes the answer only
    /// once the menu has closed.
    @MainActor
    func testEveryOpenHoldsItsRowsAndEveryCloseAppliesTheWaitingAnswer() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("degraded")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Opus 5", timeout: 45), "the degraded pill never appeared")

        // Each round flips which one model the old replica claims. Its answers
        // stay suspect, so the recheck ladder keeps asking (1, 2, 4, 8, 15s). A
        // trip to the home screen between rounds restarts that ladder (the
        // foreground re-asks and resets it), so every round has a recheck due
        // within seconds of the menu opening.
        let rounds: [(from: String, to: String, toModel: String)] = [
            ("Opus 5", "Sonnet 5", "global.anthropic.claude-sonnet-5"),
            ("Sonnet 5", "Opus 5", "global.anthropic.claude-opus-5"),
            ("Opus 5", "Sonnet 5", "global.anthropic.claude-sonnet-5"),
        ]
        for (index, round) in rounds.enumerated() {
            if index > 0 {
                let asksBeforeHome = try await stub.engineGets().count
                XCUIDevice.shared.press(.home)
                try await Task.sleep(for: .seconds(1.5))
                app.activate()
                XCTAssertTrue(
                    waitUntil(timeout: 10) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBeforeHome },
                    "round \(index + 1): coming back to the app did not re-ask"
                )
                XCTAssertTrue(waitForLabel(pill, "Model: \(round.from)", timeout: 5))
            }
            try await openMenu(app, pill)
            XCTAssertTrue(app.buttons[round.from].waitForExistence(timeout: 5), "round \(index + 1): the menu did not open")
            let asksBefore = try await stub.engineGets().count
            try await stub.setEngine("degraded", model: round.toModel)
            XCTAssertTrue(
                waitUntil(timeout: 25) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBefore },
                "round \(index + 1): no re-ask landed while the menu was open"
            )
            try await Task.sleep(for: .seconds(1))
            XCTAssertTrue(app.buttons[round.from].exists, "round \(index + 1): the open menu lost its row")
            XCTAssertFalse(app.buttons[round.to].exists, "round \(index + 1): the open menu was rebuilt")
            try await stub.screenshot(app, "model-pill-07-round\(index + 1)-open")
            closeMenu(app)
            XCTAssertTrue(
                waitForLabel(pill, "Model: \(round.to)", timeout: 5),
                "round \(index + 1): the close did not apply the waiting answer (pill reads \(pill.label))"
            )
        }
    }

    // MARK: - Scenario 6: a pick through the UIKit menu

    /// A tap on a row writes exactly that model, and while the write is out both
    /// pills are disabled (their quieter ink) with the spinner on the model pill;
    /// they take taps again once the Mac has answered.
    ///
    /// "Disabled" is checked as the user meets it, not only as a flag: the first
    /// version of this test caught SwiftUI re-enabling the UIKit button right
    /// after the pill disabled it, so a pill drawn in the quiet ink still opened
    /// its menu. A tap on the effort pill mid-write must open nothing.
    @MainActor
    func testAPickWritesTheTappedModelAndThePillsWaitForTheWrite() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.call("POST", "__stub/write-delay?ms=7000")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        let effort = app.buttons["composer.effortPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")
        XCTAssertTrue(pill.isEnabled && effort.isEnabled)
        try await stub.screenshot(app, "model-pill-09-enabled-pills")

        try await openMenu(app, pill)
        let sonnet = app.buttons["Sonnet 5"]
        XCTAssertTrue(sonnet.waitForExistence(timeout: 5), "the model menu did not open")
        sonnet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 3) { !pill.isEnabled }, "the pill took taps while its pick was being written")
        XCTAssertFalse(effort.isEnabled, "the effort pill took taps while a model pick was being written")
        XCTAssertEqual(pill.label, "Model: Sonnet 5", "the pick is not shown while it is written")
        try await stub.screenshot(app, "model-pill-09-disabled-pills-while-writing")
        effort.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertFalse(app.buttons["Extra High"].waitForExistence(timeout: 1.5),
                       "a disabled effort pill opened its menu mid-write")
        XCTAssertFalse(pill.isEnabled, "the write finished before the disabled tap was checked; lengthen the delay")

        XCTAssertTrue(waitUntil(timeout: 12) { pill.isEnabled }, "the pill never came back after the write landed")
        XCTAssertEqual(pill.label, "Model: Sonnet 5")
        let writes = try await stub.requests().filter { $0.method == "POST" && $0.path.hasSuffix("/model") }
        XCTAssertEqual(writes.map(\.model), ["global.anthropic.claude-sonnet-5"],
                       "the tap wrote something other than the row it landed on")
        try await stub.screenshot(app, "model-pill-09-after-write")
    }

    // MARK: - Scenario 5: the menu and the pills at the default and largest text sizes

    /// The gate: "Default (Opus 5.5 1M)" wrapped onto two lines at the DEFAULT
    /// size, because an Effort submenu in the same menu reserved a chevron column
    /// in every row. Effort is its own pill now. At the default size every name is
    /// on one line; at XXXL (the largest standard size) the menu grows with the
    /// text, every row is still there in the Mac's order, and the two pills still
    /// fit beside the mic.
    ///
    /// And AX5, the largest ACCESSIBILITY size, with the WIDEST real pill label
    /// (gate r2 D2: side by side there, "GPT-6 Astra" read "GP…" in a 131pt pill
    /// while "High" kept its full width). The pills stack, and the model name must
    /// fit the pill it got, measured against the real font.
    @MainActor
    func testTheMenuAndPillsAtTheDefaultAndTheLargestTextSizes() async throws {
        let stub = try await stubUnderTest()
        let ax5 = "UICTContentSizeCategoryAccessibilityXXXL"
        let widest = Self.widestPillLabel(at: .accessibilityExtraExtraExtraLarge)
        print("[evidence] widest real pill label at AX5: \(widest.label) (\(Int(widest.width))pt), model \(widest.id)")
        for (size, tag) in [(nil as String?, "default"), ("UICTContentSizeCategoryXXXL", "xxxl"), (ax5, "ax5")] {
            try await stub.reset()
            try await stub.setEngine("lane")
            let expected: String
            // Only some rows of the catalog have an effort axis (and so a second pill).
            var hasEffort = true
            if size == ax5 {
                try await stub.setLane(model: widest.id, effort: "xhigh")
                expected = "Model: \(widest.label)"
                hasEffort = Self.rowsWithEffort.contains(widest.id)
            } else {
                expected = Self.healedLabel
            }
            let extra = size.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? []
            let app = try launchPaired(extra)
            openChatTab(app)
            let pill = app.buttons["composer.modelPill"]
            XCTAssertTrue(waitForLabel(pill, expected, timeout: 45),
                          "\(tag): the pill never showed \(expected) (reads \(pill.exists ? pill.label : "absent"))")
            let effort = app.buttons["composer.effortPill"]
            XCTAssertEqual(effort.waitForExistence(timeout: 10), hasEffort, "\(tag): effort pill presence")
            let mic = element(app, "chat.mic")
            XCTAssertTrue(mic.waitForExistence(timeout: 5))
            XCTAssertLessThanOrEqual(pill.frame.maxX, mic.frame.minX,
                                     "\(tag): the model pill runs into the mic (\(pill.frame) vs \(mic.frame))")
            if hasEffort {
                XCTAssertLessThanOrEqual(effort.frame.maxX, mic.frame.minX,
                                         "\(tag): the effort pill runs into the mic (\(effort.frame) vs \(mic.frame))")
            }
            if size == ax5 {
                if hasEffort {
                    XCTAssertGreaterThanOrEqual(effort.frame.minY, pill.frame.maxY,
                                                "ax5: the pills are side by side (\(pill.frame), \(effort.frame)), not stacked")
                }
                assertTheNameFits(widest.label, in: pill.frame, at: .accessibilityExtraExtraExtraLarge, tag: tag)
            } else {
                XCTAssertLessThanOrEqual(pill.frame.maxX, effort.frame.minX, "\(tag): the pills overlap")
            }
            try await stub.screenshot(app, "model-pill-08-\(tag)-pills")

            try await openMenu(app, pill)
            XCTAssertTrue(app.buttons[Self.macOrder[0]].waitForExistence(timeout: 5), "\(tag): the model menu did not open")
            // Row frames only prove it while the menu does not scroll: a row cut off
            // at the bottom of a scrolling menu keeps its whole frame, over the pill,
            // though the menu clips it. At the big sizes the TAP below is the proof.
            if size == nil { assertNoRowCovers(pill, rows: Self.macOrder, app, tag: tag) }
            try await stub.screenshot(app, "model-pill-08-\(tag)-menu")
            // Every row, in the Mac's order. At the big sizes the list is taller than
            // the menu and scrolls, and a row far out of view is not in the tree at
            // all, so the rows are read before and after scrolling to the end (a
            // slow swipe scrolls; it must never pick a row, which the wire check
            // below holds).
            var seen = Self.rowsInView(app)
            // The menu scrolls: swipe on a row in the middle of what is in view (a
            // row at the edge can be clipped to nothing) until the last row shows.
            var swipes = 0
            while seen.last != Self.macOrder.last, swipes < 6 {
                let reachable = Self.rowsInView(app).filter { app.buttons[$0].isHittable }
                guard !reachable.isEmpty else {
                    XCTFail("\(tag): no row of the open menu is reachable")
                    break
                }
                app.buttons[reachable[reachable.count / 2]].swipeUp(velocity: .slow)
                swipes += 1
                try await Task.sleep(for: .seconds(1))
                seen += Self.rowsInView(app).filter { !seen.contains($0) }
                XCTAssertTrue(Self.macOrder.contains { app.buttons[$0].exists },
                              "\(tag): scrolling the menu closed it")
            }
            if swipes > 0 {
                print("[evidence] \(tag): the menu scrolled (\(swipes) swipe(s)) to its last row")
                try await stub.screenshot(app, "model-pill-08-\(tag)-menu-scrolled")
            }
            XCTAssertEqual(seen, Self.macOrder, "\(tag): the menu's rows, top to bottom, are not the Mac's order")
            if size == nil {
                let single = app.buttons["Sonnet 5"].frame.height
                let longest = app.buttons["Default (Opus 5.5 1M)"].frame.height
                print("[evidence] \(tag): row heights Sonnet 5 = \(single)pt, Default (Opus 5.5 1M) = \(longest)pt")
                XCTAssertLessThan(longest, single * 1.25,
                                  "default size: \"Default (Opus 5.5 1M)\" is \(Int(longest))pt against \(Int(single))pt: it wrapped")
            }
            print("[evidence] \(tag): pills \(pill.frame) + \(hasEffort ? "\(effort.frame)" : "none"), mic \(mic.frame)")
            // A second tap on the pill closes its menu and picks nothing (gate r2 D1).
            try await tapPillToClose(app, pill, rows: Self.macOrder, tag: tag)
            if hasEffort {
                try await openMenu(app, effort)
                XCTAssertTrue(app.buttons["Extra High"].waitForExistence(timeout: 5), "\(tag): the effort menu did not open")
                if size == nil { assertNoRowCovers(effort, rows: Self.effortRows, app, tag: "\(tag) effort") }
                try await stub.screenshot(app, "model-pill-08-\(tag)-effort-menu")
                try await tapPillToClose(app, effort, rows: Self.effortRows, tag: "\(tag) effort")
                if size == ax5 {
                    // Stacked, the model pill is above the effort pill: the effort
                    // menu opens above both, so a tap on the model pill closes it too.
                    try await openMenu(app, effort)
                    XCTAssertTrue(app.buttons["Extra High"].waitForExistence(timeout: 5), "\(tag): the effort menu did not open")
                    try await stub.screenshot(app, "model-pill-08-\(tag)-effort-menu-clear")
                    try await tapPillToClose(app, pill, rows: Self.effortRows, tag: "\(tag) effort, a tap on the model pill")
                    if app.buttons[Self.macOrder[0]].exists { closeMenu(app) }
                }
            }
            let writes = try await stub.writes()
            XCTAssertTrue(writes.isEmpty, "\(tag): looking at the menus wrote \(writes.map(\.path))")
            app.terminate()
        }
    }

    /// The pill labels the stub's catalog can put on the pill, keyed by model id:
    /// what the app names each row's model (`currentModelLabel`: the versioned name
    /// from the resolved model, else the row's label).
    private static let pillLabels: [(id: String, label: String)] = [
        ("haiku", "Haiku 4.5"), ("gpt-6-luna", "GPT-6 Luna"), ("global.anthropic.claude-sonnet-5", "Sonnet 5"),
        ("gpt-6-astra", "GPT-6 Astra"), ("global.anthropic.claude-fable-5[1m]", "Fable 5"),
        ("global.anthropic.claude-fable-5-1[1m]", "Fable 5.1"), ("gpt-5.6-sol", "GPT-5.6 Sol"),
        ("gpt-6-sol", "GPT-6 Sol"), ("default", "Opus 5.5"), ("opus", "Opus 5.5"),
    ]

    private static let effortRows = ["Low", "Medium", "High", "Extra High", "Max"]

    /// The model rows the open menu has in its tree right now, top to bottom.
    @MainActor
    private static func rowsInView(_ app: XCUIApplication) -> [String] {
        macOrder.filter { app.buttons[$0].exists }.sorted { app.buttons[$0].frame.minY < app.buttons[$1].frame.minY }
    }
    /// The stub catalog's rows that declare effort levels (the rest carry none).
    private static let rowsWithEffort: Set<String> = [
        "default", "global.anthropic.claude-fable-5[1m]", "global.anthropic.claude-fable-5-1[1m]",
        "global.anthropic.claude-sonnet-5", "opus", "gpt-6-astra",
    ]

    /// The pill's font at a text size: `.caption.weight(.medium)`.
    private static func pillFont(at size: UIContentSizeCategory) -> UIFont {
        let traits = UITraitCollection(preferredContentSizeCategory: size)
        let caption = UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: traits)
        return UIFont.systemFont(ofSize: caption.pointSize, weight: .medium)
    }

    private static func width(_ text: String, _ font: UIFont) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    private static func widestPillLabel(at size: UIContentSizeCategory) -> (id: String, label: String, width: CGFloat) {
        let font = pillFont(at: size)
        return pillLabels.map { ($0.id, $0.label, width($0.label, font)) }.max { $0.2 < $1.2 }!
    }

    /// The name fits the pill it got: every word fits the text column, and the
    /// words wrapped greedily into that column need no more lines than the pill is
    /// tall. This is the check the old side-by-side layout fails (one 89pt line
    /// for a ~230pt name).
    @MainActor
    private func assertTheNameFits(
        _ label: String, in frame: CGRect, at size: UIContentSizeCategory, tag: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let font = Self.pillFont(at: size)
        let traits = UITraitCollection(preferredContentSizeCategory: size)
        let glyphPoints = UIFontMetrics(forTextStyle: .caption1).scaledValue(for: 8, compatibleWith: traits)
        let glyph = UIImage(
            systemName: "chevron.up.chevron.down",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: glyphPoints, weight: .semibold)
        )?.size.width ?? glyphPoints
        // PillChip: 9pt padding each side, 4pt between the name and the glyph.
        let column = frame.width - 18 - 4 - glyph
        // Greedy word wrap, each line measured whole (summing rounded word widths
        // overstates a line by a point or two).
        var lines: [String] = []
        for word in label.split(separator: " ").map(String.init) {
            let w = Self.width(word, font)
            XCTAssertLessThanOrEqual(w, column + 1, "\(tag): \"\(word)\" (\(Int(w))pt) does not fit the pill's "
                                     + "\(Int(column))pt text column: it truncates", file: file, line: line)
            if let last = lines.last, Self.width(last + " " + word, font) <= column + 1 {
                lines[lines.count - 1] = last + " " + word
            } else {
                lines.append(word)
            }
        }
        let fits = Int(((frame.height - 10 + 2) / font.lineHeight).rounded(.down))
        print("[evidence] \(tag): \"\(label)\" is \(Int(Self.width(label, font)))pt, needs \(lines.count) line(s) "
              + "of the \(Int(column))pt column \(lines); the pill \(frame) holds \(fits)")
        XCTAssertLessThanOrEqual(lines.count, fits, "\(tag): \"\(label)\" needs \(lines.count) lines in a pill "
                                 + "\(Int(frame.height))pt tall that holds \(fits): it truncates", file: file, line: line)
    }

    /// With the pill's menu up, tap the pill: the menu closes (the tap landed
    /// outside it) and nothing is written.
    @MainActor
    private func tapPillToClose(
        _ app: XCUIApplication, _ pill: XCUIElement, rows: [String], tag: String,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let stub = try await stubUnderTest()
        let before = try await stub.writes().count
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        try await Task.sleep(for: .milliseconds(1500))
        let stillUp = rows.filter { app.buttons[$0].exists }
        XCTAssertTrue(stillUp.isEmpty, "\(tag): a tap on the pill left its menu up (\(stillUp))", file: file, line: line)
        if !stillUp.isEmpty { closeMenu(app) }
        let writes = try await stub.writes()
        XCTAssertEqual(writes.count, before, "\(tag): a tap on the pill with its menu up wrote "
                       + "\(writes.dropFirst(before).map(\.path))", file: file, line: line)
    }

    /// No row of an open menu sits over its pill: a second tap there must land
    /// outside the menu (gate r2 D1).
    @MainActor
    private func assertNoRowCovers(
        _ pill: XCUIElement, rows: [String], _ app: XCUIApplication, tag: String,
        file: StaticString = #filePath, line: UInt = #line
    ) {
        let target = pill.frame
        // Only rows a finger can reach: a row scrolled out of a long menu keeps a
        // frame, but it is clipped and takes no tap.
        let reachable = rows.filter { app.buttons[$0].exists && app.buttons[$0].isHittable }
        XCTAssertFalse(reachable.isEmpty, "\(tag): no row of the open menu is reachable, so this check "
                       + "would pass vacuously", file: file, line: line)
        let covering = reachable.filter { app.buttons[$0].frame.intersects(target) }
        XCTAssertTrue(covering.isEmpty, "\(tag): \(covering) sit over the pill \(target)", file: file, line: line)
    }

    // MARK: - Scenario 7: a second tap on the pill never picks a row (gate r2 D1)

    /// The gate's repro: the menu grew out of the pill and covered it, with its
    /// strongest rows exactly where the pill was. A double tap wrote `default`
    /// 380ms after the open; tap, wait 1.2s, tap the pill again (to close the menu)
    /// wrote `opus` while the user was on Sonnet 5; on the effort pill both wrote
    /// `max`. Every second tap here lands on the pill's own spot while its menu is
    /// up, and nothing may be written.
    @MainActor
    func testASecondTapOnThePillWhileItsMenuIsUpNeverPicksARow() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "high")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        let effort = app.buttons["composer.effortPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: Sonnet 5", timeout: 45), "the pill never showed Sonnet 5")
        XCTAssertTrue(waitForLabel(effort, "Effort: High", timeout: 10), "no effort pill on High")
        try await secondTaps(app, stub, pill, rows: Self.macOrder, tag: "model")
        try await secondTaps(app, stub, effort, rows: Self.effortRows, tag: "effort")
        XCTAssertEqual(pill.label, "Model: Sonnet 5")
        XCTAssertEqual(effort.label, "Effort: High")

        // An effort the session does not report (the CLI default): no row is
        // checked, so there is no "current" row a stray tap could safely land on.
        try await stub.setLane(model: "global.anthropic.claude-sonnet-5", effort: "none")
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(1))
        app.activate()
        XCTAssertTrue(waitForLabel(effort, "Effort: Effort", timeout: 20),
                      "no unknown-effort pill (reads \(effort.exists ? effort.label : "absent"))")
        try await secondTaps(app, stub, effort, rows: Self.effortRows, tag: "effort-unknown")
    }

    /// The Retry-only menu under the same rule: Retry never sits over the pill, so
    /// a second tap there closes the menu instead of picking it (Retry writes
    /// nothing, but a stray one would restart the ladder).
    @MainActor
    func testASecondTapOnTheRetryPillNeverPicksRetry() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("unreachable")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, "Model: unknown", timeout: 45), "no unreachable pill")
        try await secondTaps(app, stub, pill, rows: ["Retry"], tag: "retry", retryID: "composer.modelPill.retry")
    }

    /// Double tap, then open + second tap after 0.6s and after 1.2s, all at the
    /// pill's own spot. Each ends with the menu closed and nothing written.
    @MainActor
    private func secondTaps(
        _ app: XCUIApplication, _ stub: StubControl, _ pill: XCUIElement, rows: [String], tag: String,
        retryID: String? = nil, file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let frame = pill.frame
        let spot = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX, dy: frame.midY))
        let before = try await stub.writes().count
        func menuIsUp() -> Bool {
            if let retryID, element(app, retryID).exists { return true }
            return rows.contains { app.buttons[$0].exists }
        }

        spot.doubleTap()
        try await Task.sleep(for: .milliseconds(1500))
        try await stub.screenshot(app, "model-pill-10-\(tag)-after-double-tap")
        if menuIsUp() { closeMenu(app) }
        var writes = try await stub.writes()
        XCTAssertEqual(writes.count, before, "\(tag): a double tap on the pill wrote \(writes.dropFirst(before).map(\.path))",
                       file: file, line: line)

        for gap in [600, 1200] {
            spot.tap()
            try await Task.sleep(for: .milliseconds(gap))
            XCTAssertTrue(menuIsUp(), "\(tag): the menu did not open", file: file, line: line)
            assertNoRowCovers(pill, rows: rows, app, tag: "\(tag) after \(gap)ms", file: file, line: line)
            if let retryID {
                let retry = element(app, retryID)
                XCTAssertFalse(retry.frame.intersects(frame), "\(tag): Retry sits over the pill", file: file, line: line)
            }
            try await stub.screenshot(app, "model-pill-10-\(tag)-open-\(gap)ms")
            spot.tap()
            try await Task.sleep(for: .milliseconds(1500))
            try await stub.screenshot(app, "model-pill-10-\(tag)-after-second-tap-\(gap)ms")
            XCTAssertFalse(menuIsUp(), "\(tag): a second tap on the pill after \(gap)ms did not close its menu",
                           file: file, line: line)
            if menuIsUp() { closeMenu(app) }
            writes = try await stub.writes()
            XCTAssertEqual(writes.count, before,
                           "\(tag): a second tap on the pill after \(gap)ms wrote \(writes.dropFirst(before).map(\.path))",
                           file: file, line: line)
        }
        print("[evidence] \(tag): double tap, 600ms and 1200ms second taps at \(spot.screenPoint): "
              + "\(try await stub.writes().count - before) writes")
    }

    // MARK: - Scenario 8: a composer on another tab never re-asks (gate r2 D4)

    /// The gate: on Inbox, the hidden Chat composer asked the Mac twice in 130s,
    /// both `trigger=appeared` at a stream reconnect (a retained tab re-runs its
    /// composer's appear), and each armed the 60s TTL. Off screen means no request
    /// at all; coming back asks once.
    @MainActor
    func testTheChatComposerOnAnotherTabNeverAsks() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")

        // A conversation with a live stream, as the gate had: only then is there a
        // stream to reconnect while the tab is hidden.
        let field = element(app, "chat.composer")
        XCTAssertTrue(field.waitForExistence(timeout: 10), "no composer to type into")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10), "the composer took no focus")
        field.typeText("hello")
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10), "no send button")
        send.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitUntil(timeout: 30) {
            ((try? self.syncRequests(stub)) ?? []).contains { $0.method == "POST" && $0.path.hasSuffix("/messages") }
        }, "the message never went out")
        try await Task.sleep(for: .seconds(1))
        try await stub.call("POST", "__stub/finish-turn")
        try await Task.sleep(for: .seconds(2))
        // The keyboard covers the tab bar: put it away the way a thumb does.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        if app.keyboards.element.exists {
            app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
                .press(forDuration: 0.05, thenDragTo: app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)))
        }
        XCTAssertTrue(waitUntil(timeout: 5) { !app.keyboards.element.exists }, "the keyboard would not go away")

        let inbox = app.buttons["Inbox"]
        XCTAssertTrue(inbox.waitForExistence(timeout: 10), "no Inbox tab")
        inbox.tap()
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(waitUntil(timeout: 5) { inbox.isSelected }, "the Inbox tab did not become selected")
        let leftAt = Date()
        let asksBefore = try await stub.engineGets().count
        // Two reconnects of the chat's stream while it is hidden (the gate saw the
        // re-asks land on those), then on past the 60s TTL.
        try await Task.sleep(for: .seconds(12))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(30))
        try await stub.dropStreams()
        try await Task.sleep(for: .seconds(30))
        let hidden = try await stub.requests().filter {
            $0.at > leftAt && ($0.path == "/api/v1/chat/engine" || $0.path.hasSuffix("/model-options"))
        }
        let streams = try await stub.requests().filter { $0.at > leftAt && $0.path.hasSuffix("/stream") }
        print("[evidence] on Inbox \(Int(Date().timeIntervalSince(leftAt)))s: \(streams.count) stream (re)connects, "
              + "\(hidden.count) model asks \(hidden.map { "\($0.path)@\($0.at)" })")
        XCTAssertGreaterThanOrEqual(streams.count, 2, "the hidden chat's stream never reconnected: the repro did not happen")
        XCTAssertTrue(hidden.isEmpty, "the hidden Chat composer asked the Mac \(hidden.count) time(s) while on Inbox")
        try await stub.screenshot(app, "model-pill-11-inbox-hidden-composer")

        app.buttons["Chat"].tap()
        XCTAssertTrue(
            waitUntil(timeout: 10) { ((try? self.syncEngineGets(stub).count) ?? 0) > asksBefore },
            "coming back to Chat did not re-ask a stale answer"
        )
        try await Task.sleep(for: .seconds(2))
        let back = try await stub.engineGets().count - asksBefore
        XCTAssertEqual(back, 1, "coming back to Chat asked \(back) times, not once")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 10))
    }

    // MARK: - Scenario 9: the Mac goes away after a good answer (gate r2 D3)

    /// The gate: with the Mac away, the pill showed the raw catalog id
    /// ("global.anthropic.claude-fable-5-1[1m]") in place of the name it had a
    /// moment before, because the Retry state dropped the catalog the name came
    /// from. It keeps the name from the last good answer, and says it is last known.
    @MainActor
    func testAMacThatGoesAwayLeavesTheLastKnownNameOnThePill() async throws {
        let stub = try await stubUnderTest()
        try await stub.reset()
        try await stub.setEngine("lane")
        let app = try launchPaired()
        openChatTab(app)
        let pill = app.buttons["composer.modelPill"]
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill never showed the Mac's model")

        try await stub.setEngine("unreachable")
        let before = try await stub.engineGets().count
        XCUIDevice.shared.press(.home)
        try await Task.sleep(for: .seconds(2))
        app.activate()
        XCTAssertTrue(
            waitUntil(timeout: 20) { ((try? self.syncEngineGets(stub).count) ?? 0) > before },
            "coming back to the app did not ask, so the Mac being away was never seen"
        )
        let lastKnown = "\(Self.healedLabel), last known"
        XCTAssertTrue(waitForLabel(pill, lastKnown, timeout: 20),
                      "the unreachable pill reads \(pill.exists ? pill.label : "absent"), not \(lastKnown)")
        XCTAssertFalse(pill.label.contains("global.anthropic"), "the pill shows a raw catalog id: \(pill.label)")
        print("[evidence] mac away after a good answer: pill reads \"\(pill.label)\"")
        try await stub.screenshot(app, "model-pill-12-last-known-name")
        try await openMenu(app, pill)
        XCTAssertTrue(element(app, "composer.modelPill.retry").waitForExistence(timeout: 5),
                      "the unreachable pill's menu offers no Retry")
        XCTAssertFalse(app.buttons["Haiku 4.5"].exists, "the unreachable menu lists models it cannot write")
        try await stub.screenshot(app, "model-pill-12-last-known-menu")
        closeMenu(app)

        try await stub.setEngine("lane")
        XCTAssertTrue(waitForLabel(pill, Self.healedLabel, timeout: 45), "the pill did not heal once the Mac was back")
        let writes = try await stub.writes()
        XCTAssertTrue(writes.isEmpty, "the Mac being away wrote \(writes.map(\.path))")
    }

    // MARK: - Driving the app

    @MainActor
    private func launchPaired(_ extra: [String] = []) throws -> XCUIApplication {
        let (server, token) = try pairing()
        return UITestLaunch.launch(["-walnut.serverUrl", server, "-walnut.deviceToken", token] + extra)
    }

    private func pairing() throws -> (server: String, token: String) {
        guard
            let server = ProcessInfo.processInfo.environment["WALNUT_UITEST_SERVER"],
            let token = ProcessInfo.processInfo.environment["WALNUT_UITEST_TOKEN"],
            !server.isEmpty, !token.isEmpty
        else {
            throw XCTSkip(
                "no pairing reached the test runner: run this through ios-native/tests/ui/run-ui-tests.sh "
                    + "with WALNUT_UITEST_SERVER pointed at a running tests/ui/mid-turn-stub-server.mjs"
            )
        }
        return (server, token)
    }

    @MainActor
    private func openChatTab(_ app: XCUIApplication) {
        let chat = app.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 60), "the tab bar never appeared")
        chat.tap()
    }

    @MainActor
    private func element(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier))
            .firstMatch
    }

    /// Every helper that touches XCUI is `@MainActor`: a nonisolated async helper
    /// resumes on the cooperative pool after its first await, and the next XCUI
    /// call then raises `Must be called on the main thread` (measured: the first
    /// run of this file died exactly there, after the heal had already happened).
    ///
    /// A pill is a button, and `tap()` on it waits for hit-testability that a
    /// composer row inside a hosted cell does not always report; a synthesized
    /// touch at its centre is what a thumb is.
    @MainActor
    private func openMenu(_ app: XCUIApplication, _ pill: XCUIElement) async throws {
        XCTAssertTrue(pill.waitForExistence(timeout: 10), "no model pill to open")
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        try await Task.sleep(for: .milliseconds(800))
    }

    @MainActor
    private func closeMenu(_ app: XCUIApplication) {
        // A tap beside the menu (its left margin, outside its width) dismisses it.
        // Never above it: with the Mac's order the list reaches the top of the
        // screen, and a tap there would PICK a model.
        app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.3)).tap()
        usleep(600_000)
    }

    @MainActor
    private func assertMenuListsTheWholeCatalog(
        _ app: XCUIApplication, _ pill: XCUIElement, shot: String,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        try await openMenu(app, pill)
        for row in Self.macOrder {
            XCTAssertTrue(
                app.buttons[row].waitForExistence(timeout: 5),
                "the healed menu does not list \(row): it is still the one-row answer, or the rows "
                    + "are not spelled the way the Mac's picker spells them",
                file: file, line: line
            )
        }
        // The Mac's order, top to bottom. iOS reverses a menu that opens upward
        // unless told not to.
        let frames = Self.macOrder.map { app.buttons[$0].frame }
        let tops = frames.map(\.minY)
        XCTAssertEqual(
            tops, tops.sorted(),
            "the menu rows are not in the Mac's order: \(zip(Self.macOrder, tops).map { "\($0) @\(Int($1))" })",
            file: file, line: line
        )
        // Every name on ONE line at the default text size: "Default (Opus 5.5 1M)"
        // wrapped when an Effort submenu shared this menu.
        let single = frames[Self.macOrder.firstIndex(of: "Sonnet 5")!].height
        for (row, frame) in zip(Self.macOrder, frames) {
            XCTAssertLessThan(frame.height, single * 1.25,
                              "\(row) is \(Int(frame.height))pt tall against \(Int(single))pt: it wrapped",
                              file: file, line: line)
        }
        XCTAssertFalse(element(app, "composer.modelPill.effort").exists,
                       "effort is its own pill now, not a row in the model menu", file: file, line: line)
        try await stubUnderTest().screenshot(app, shot)
        closeMenu(app)
    }

    @MainActor
    private func assertEffortPillOffersTheLevels(
        _ app: XCUIApplication, shot: String, file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        let effort = app.buttons["composer.effortPill"]
        XCTAssertTrue(waitForLabel(effort, Self.healedEffort, timeout: 5),
                      "no effort pill beside the model (reads \(effort.exists ? effort.label : "absent"))",
                      file: file, line: line)
        try await openMenu(app, effort)
        for level in ["Low", "Medium", "High", "Extra High", "Max"] {
            XCTAssertTrue(app.buttons[level].waitForExistence(timeout: 5), "the effort menu has no \(level)",
                          file: file, line: line)
        }
        let tops = ["Low", "Medium", "High", "Extra High", "Max"].map { app.buttons[$0].frame.minY }
        XCTAssertEqual(tops, tops.sorted(), "the effort levels are not low to high", file: file, line: line)
        try await stubUnderTest().screenshot(app, shot)
        closeMenu(app)
    }

    @MainActor
    private func waitForLabel(_ element: XCUIElement, _ label: String, timeout: TimeInterval) -> Bool {
        waitUntil(timeout: timeout) { element.exists && element.label == label }
    }

    @MainActor
    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            usleep(250_000)
        }
        return condition()
    }

    private static func fmt(_ gaps: [TimeInterval]) -> String {
        gaps.map { String(format: "%.1fs", $0) }.joined(separator: ", ")
    }

    // MARK: - The stub

    private func stubUnderTest() async throws -> StubControl {
        let (server, _) = try pairing()
        guard let base = URL(string: server) else { throw XCTSkip("unusable server URL \(server)") }
        let stub = StubControl(base: base)
        do {
            _ = try await stub.call("GET", "__stub/state")
        } catch {
            throw XCTSkip(
                "\(server) is not the UI stub (no /__stub/state: \(error)). Start "
                    + "ios-native/tests/ui/mid-turn-stub-server.mjs and point WALNUT_UITEST_SERVER at it; "
                    + "this test never runs against a real Walnut."
            )
        }
        return stub
    }

    private func syncEngineGets(_ stub: StubControl) throws -> [StubControl.Record] {
        try syncRequests(stub).filter { $0.method == "GET" && $0.path == "/api/v1/chat/engine" }
    }

    /// Synchronous read for a polling predicate (the XCUITest wait loop is sync).
    private func syncRequests(_ stub: StubControl) throws -> [StubControl.Record] {
        var result: [StubControl.Record] = []
        var failure: Error?
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do { result = try await stub.requests() } catch { failure = error }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 10)
        if let failure { throw failure }
        return result
    }

    struct StubControl: Sendable {
        let base: URL

        struct Record: Decodable {
            let seq: Int
            let at: Date
            let method: String
            let path: String
            /// The value a model write carried (the stub records it).
            let model: String?
        }

        @discardableResult
        func call(_ method: String, _ path: String, body: Data? = nil) async throws -> Data {
            let root = base.absoluteString.hasSuffix("/") ? base.absoluteString : base.absoluteString + "/"
            guard let url = URL(string: root + path) else {
                throw NSError(domain: "stub", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad URL \(path)"])
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = 20
            if let body {
                request.httpBody = body
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(code) else {
                throw NSError(domain: "stub", code: code, userInfo: [
                    NSLocalizedDescriptionKey: "\(method) \(path) answered \(code)",
                ])
            }
            return data
        }

        func reset() async throws { try await call("POST", "__stub/reset") }

        /// The lane session's current model and effort as the Mac reports them
        /// (`effort: "none"` = the session reports no effort).
        func setLane(model: String? = nil, effort: String? = nil) async throws {
            var query: [String] = []
            if let model { query.append("model=\(model.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? model)") }
            if let effort { query.append("effort=\(effort)") }
            try await call("POST", "__stub/lane?\(query.joined(separator: "&"))")
        }

        func dropStreams() async throws { try await call("POST", "__stub/drop-streams") }

        /// The lane session's model and effort writes this generation.
        func writes() async throws -> [Record] {
            try await requests().filter {
                $0.method == "POST" && $0.path.hasPrefix("/api/v1/sessions/")
                    && ($0.path.hasSuffix("/model") || $0.path.hasSuffix("/effort"))
            }
        }

        func setEngine(_ mode: String, model: String? = nil) async throws {
            let suffix = model.map { "&model=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
            try await call("POST", "__stub/engine?mode=\(mode)\(suffix)")
        }

        func requests() async throws -> [Record] {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom { decoder in
                let raw = try decoder.singleValueContainer().decode(String.self)
                let parser = ISO8601DateFormatter()
                parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                guard let date = parser.date(from: raw) else {
                    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
                }
                return date
            }
            return try decoder.decode([Record].self, from: try await call("GET", "__stub/requests"))
        }

        /// Every `GET /chat/engine` the app made this generation, in order.
        func engineGets() async throws -> [Record] {
            try await requests().filter { $0.method == "GET" && $0.path == "/api/v1/chat/engine" }
        }

        /// On the main actor: every XCUI call (the screenshot included) raises
        /// `must be called on the main thread` from anywhere else, and a
        /// nonisolated async helper resumes on the cooperative pool.
        @MainActor
        func screenshot(_ app: XCUIApplication, _ name: String) async throws {
            let shot = app.screenshot()
            let attachment = XCTAttachment(screenshot: shot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "screenshot \(name)") { $0.add(attachment) }
            try await call("POST", "__stub/screenshot?name=\(name)", body: shot.pngRepresentation)
        }
    }
}
