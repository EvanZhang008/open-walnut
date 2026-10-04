import XCTest
@testable import Walnut

/// When Walnut asks for Apple Health by itself: once when the app opens, and
/// whenever an agent reads health data here while it is off.
final class HealthAccessDecisionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func state(
        available: Bool = true, enabled: Bool = false, offered: Bool = false, sheetWillShow: Bool = true,
        busy: Bool = false, lastOfferAt: Date? = nil, lastNudgeAt: Date? = nil
    ) -> HealthAccessDecision.State {
        .init(available: available, enabled: enabled, offered: offered, sheetWillShow: sheetWillShow,
              busy: busy, lastOfferAt: lastOfferAt, lastNudgeAt: lastNudgeAt, now: now)
    }

    func testFirstOpenShowsTheSheetOnce() {
        XCTAssertEqual(HealthAccessDecision.decide(.appOpen, state()), .showSheet)
        // Asked before (by itself or from Turn On): opening the app again asks nothing,
        // even when the user closed the sheet without answering.
        XCTAssertEqual(HealthAccessDecision.decide(.appOpen, state(offered: true)), .nothing)
        // Already on: nothing on open (the activation sync runs on its own).
        XCTAssertEqual(HealthAccessDecision.decide(.appOpen, state(enabled: true, sheetWillShow: false)), .nothing)
    }

    func testOpeningNeverStartsSendingWithoutApplesSheet() {
        // Paired again after Disconnect: the sheet was answered long ago, maybe for another Mac.
        XCTAssertEqual(HealthAccessDecision.decide(.appOpen, state(sheetWillShow: false)), .nothing)
    }

    func testAHealthReadWhileOffAsksRightThere() {
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, state()), .showSheet)
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, state(offered: true)), .showSheet)
        // The sheet will not show again: offer a one-tap Turn On instead.
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, state(offered: true, sheetWillShow: false)), .offerTurnOn)
    }

    func testATurnedDownOfferWaitsTenMinutes() {
        let declined = state(offered: true, sheetWillShow: false, lastOfferAt: now.addingTimeInterval(-60))
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, declined), .nothing)
        let later = state(offered: true, sheetWillShow: false, lastOfferAt: now.addingTimeInterval(-601))
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, later), .offerTurnOn)
    }

    func testAHealthReadWhileOnSyncsNowOncePerMinute() {
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, state(enabled: true, sheetWillShow: false)), .syncNow)
        let recent = state(enabled: true, sheetWillShow: false, lastNudgeAt: now.addingTimeInterval(-10))
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, recent), .nothing)
        let old = state(enabled: true, sheetWillShow: false, lastNudgeAt: now.addingTimeInterval(-61))
        XCTAssertEqual(HealthAccessDecision.decide(.healthRead, old), .syncNow)
    }

    func testNothingWhenUnavailableOrBusy() {
        for trigger in [HealthAccessDecision.Trigger.appOpen, .healthRead] {
            XCTAssertEqual(HealthAccessDecision.decide(trigger, state(available: false)), .nothing)
            XCTAssertEqual(HealthAccessDecision.decide(trigger, state(busy: true)), .nothing)
        }
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
