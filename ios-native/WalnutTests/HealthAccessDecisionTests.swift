import XCTest
@testable import Walnut

/// When Walnut asks for Apple Health: only when an agent reads health data in a
/// conversation open on this phone, never on app open.
final class HealthAccessDecisionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func state(
        available: Bool = true, enabled: Bool = false, sheetWillShow: Bool = true, readable: Bool = false,
        busy: Bool = false, quietUntil: Date? = nil, lastNudgeAt: Date? = nil
    ) -> HealthAccessDecision.State {
        .init(available: available, enabled: enabled, sheetWillShow: sheetWillShow, readable: readable,
              busy: busy, quietUntil: quietUntil, lastNudgeAt: lastNudgeAt, now: now)
    }

    private func decide(_ s: HealthAccessDecision.State) -> HealthAccessDecision.Action {
        HealthAccessDecision.decide(s)
    }

    func testNeverAskedShowsApplesSheetRightThere() {
        XCTAssertEqual(decide(state()), .showSheet)
        // An update added types nobody was asked about: the sheet again, even while on.
        XCTAssertEqual(decide(state(enabled: true, sheetWillShow: true, readable: true)), .showSheet)
    }

    func testOffWithTheSheetAnsweredOffersOneTapTurnOn() {
        XCTAssertEqual(decide(state(sheetWillShow: false)), .offerTurnOn)
        XCTAssertEqual(decide(state(sheetWillShow: false, readable: true)), .offerTurnOn)
    }

    /// 2026-10-03: Don't Allow on the sheet; sync on, iOS gives nothing to read.
    func testOnButNothingReadableShowsTheWayToTheSwitch() {
        XCTAssertEqual(decide(state(enabled: true, sheetWillShow: false, readable: false)), .showAccessOff)
    }

    func testOnAndReadableSyncsNowOncePerMinute() {
        let on = state(enabled: true, sheetWillShow: false, readable: true)
        XCTAssertEqual(decide(on), .syncNow)
        var recent = on
        recent.lastNudgeAt = now.addingTimeInterval(-10)
        XCTAssertEqual(decide(recent), .nothing)
        var old = on
        old.lastNudgeAt = now.addingTimeInterval(-61)
        XCTAssertEqual(decide(old), .syncNow)
    }

    func testAQuietSpellHoldsEveryNoteButNotTheSync() {
        let quiet = now.addingTimeInterval(60)
        XCTAssertEqual(decide(state(quietUntil: quiet)), .nothing)
        XCTAssertEqual(decide(state(sheetWillShow: false, quietUntil: quiet)), .nothing)
        XCTAssertEqual(decide(state(enabled: true, sheetWillShow: false, quietUntil: quiet)), .nothing)
        XCTAssertEqual(decide(state(enabled: true, sheetWillShow: false, readable: true, quietUntil: quiet)), .syncNow)
        // Over: the note comes back.
        XCTAssertEqual(decide(state(sheetWillShow: false, quietUntil: now.addingTimeInterval(-1))), .offerTurnOn)
    }

    func testNothingWhenUnavailableOrBusy() {
        XCTAssertEqual(decide(state(available: false)), .nothing)
        XCTAssertEqual(decide(state(busy: true)), .nothing)
        XCTAssertEqual(decide(state(enabled: true, sheetWillShow: false, readable: true, busy: true)), .nothing)
    }

    func testRecognisesHealthReads() {
        XCTAssertTrue(HealthAccessDecision.isHealthRead(name: "mcp__walnut__health_status", detail: nil))
        XCTAssertTrue(HealthAccessDecision.isHealthRead(name: "health_sleep", detail: nil))
        XCTAssertTrue(HealthAccessDecision.isHealthRead(name: "mcp__walnut__health_samples", detail: "type: q.BodyMass"))
        XCTAssertTrue(HealthAccessDecision.isHealthRead(name: "Bash", detail: "command: walnut tools call health_series '{\"metric\":\"steps\"}'"))
        XCTAssertFalse(HealthAccessDecision.isHealthRead(name: "mcp__walnut__task_list", detail: nil))
        XCTAssertFalse(HealthAccessDecision.isHealthRead(name: "Bash", detail: "command: grep -rn health_status src"))
        XCTAssertFalse(HealthAccessDecision.isHealthRead(name: "mcp__walnut__day_review", detail: nil))
        XCTAssertFalse(HealthAccessDecision.isHealthRead(name: "Read", detail: "file_path: /tmp/health_status.md"))
    }
}
