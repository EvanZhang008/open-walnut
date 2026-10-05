import XCTest
@testable import Walnut

/// The live composer's mode pill (`ComposerModeModel`).
///
/// The bug class: a pill that names a mode the session is not in. The mode is a
/// safety setting (Plan never edits, Bypass never asks), so a pill that kept a
/// refused pick, or painted the previous session's mode after a switch, would be
/// telling the user the agent is safer or looser than it is.
@MainActor
final class ComposerModeModelTests: XCTestCase {

    private final class FakeTransport: ComposerModeTransport {
        var modes: [String: String] = [:]
        var failApply: Error?
        var failRead: Error?
        var applied: [(String, String, String)] = []
        var gate: (() async -> Void)?
        var applyGate: (() async -> Void)?

        func sessionControls(id: String) async throws -> SessionControlsPayload {
            await gate?()
            if let failRead { throw failRead }
            return Self.payload(modes[id] ?? "bypass")
        }

        func applySessionControl(id: String, controlId: String, value: String) async throws -> SessionControlsPayload {
            applied.append((id, controlId, value))
            await applyGate?()
            if let failApply { throw failApply }
            modes[id] = value
            return Self.payload(value)
        }

        static func payload(_ current: String) -> SessionControlsPayload {
            SessionControlsPayload(engine: "claude", controls: [
                .init(id: "mode", name: "Mode", type: "select", currentValue: current, options: [
                    .init(value: "plan", name: "Plan"),
                    .init(value: "default", name: "Default"),
                    .init(value: "bypass", name: "Bypass"),
                ]),
            ])
        }
    }

    private func settle(_ mode: ComposerModeModel) async {
        await mode.loadTask?.value
        await mode.pickTask?.value
    }

    /// Attach reads the session's mode and names it by the server's label.
    func testAttachShowsTheSessionsMode() async {
        let api = FakeTransport()
        api.modes["s1"] = "plan"
        let mode = ComposerModeModel(transport: api)
        XCTAssertNil(mode.label, "no pill before the controls answer")
        mode.attach("s1")
        await settle(mode)
        XCTAssertEqual(mode.label, "Plan")
        XCTAssertEqual(mode.menu.sections.flatMap(\.items).map(\.choice), [.mode("plan"), .mode("default"), .mode("bypass")])
        XCTAssertEqual(mode.menu.sections.flatMap(\.items).filter(\.checked).map(\.title), ["Plan"])
        XCTAssertEqual(mode.menu.sections.map(\.title), ["Mode: Plan"])
    }

    /// A pick shows at once with a spinner, writes the `mode` control, and lands
    /// on the server's answer.
    func testAPickWritesTheModeControl() async {
        let api = FakeTransport()
        let mode = ComposerModeModel(transport: api)
        mode.attach("s1")
        await settle(mode)
        mode.menuSelect(.mode("plan"))
        XCTAssertEqual(mode.label, "Plan", "the pick shows while it is written")
        XCTAssertEqual(mode.pillState, .writing)
        await settle(mode)
        XCTAssertEqual(api.applied.map(\.1), ["mode"])
        XCTAssertEqual(api.applied.map(\.2), ["plan"])
        XCTAssertEqual(mode.label, "Plan")
        XCTAssertEqual(mode.pillState, .ready)
    }

    /// A refused pick goes back to the mode the session really has and says why
    /// above the next menu.
    func testARefusedPickGoesBackAndSaysWhy() async {
        let api = FakeTransport()
        api.failApply = APIError.server(
            status: 409, code: "conflict", message: "The CLI refused the switch", serverHash: nil, serverContent: nil
        )
        let mode = ComposerModeModel(transport: api)
        mode.attach("s1")
        await settle(mode)
        mode.select("plan")
        await settle(mode)
        XCTAssertEqual(mode.label, "Bypass", "a refused pick must not stay on the pill")
        XCTAssertTrue(mode.menu.title.contains("Couldn't change the mode"), mode.menu.title)
    }

    /// An answer for a session the composer has left never paints the new one.
    func testASlowAnswerForTheOldSessionIsDropped() async {
        let api = FakeTransport()
        api.modes["old"] = "plan"
        api.modes["new"] = "default"
        var release: CheckedContinuation<Void, Never>?
        api.gate = { await withCheckedContinuation { release = $0 } }
        let mode = ComposerModeModel(transport: api)
        mode.attach("old")
        let oldLoad = mode.loadTask
        for _ in 0..<200 where release == nil { await Task.yield() }
        XCTAssertNotNil(release, "the old load never reached the server")
        if release == nil { return }
        api.gate = nil
        mode.attach("new")
        await mode.loadTask?.value
        release?.resume()
        await oldLoad?.value
        XCTAssertEqual(mode.sessionID, "new")
        XCTAssertEqual(mode.label, "Default", "the old session's Plan reached the new session's pill")
    }

    /// A pick still being written when the composer leaves the session is
    /// dropped, even once the composer is back on it: the return re-reads the
    /// session, and the abandoned pick's refusal never lands as a failure note.
    func testAPickInFlightIsDroppedWhenTheComposerLeaves() async {
        let api = FakeTransport()
        api.modes["new"] = "default"
        api.failApply = APIError.server(
            status: 409, code: "conflict", message: "refused", serverHash: nil, serverContent: nil
        )
        var release: CheckedContinuation<Void, Never>?
        api.applyGate = { await withCheckedContinuation { release = $0 } }
        let mode = ComposerModeModel(transport: api)
        mode.attach("old")
        await settle(mode)
        mode.select("plan")
        let pick = mode.pickTask
        for _ in 0..<200 where release == nil { await Task.yield() }
        XCTAssertNotNil(release, "the pick never reached the server")
        if release == nil { return }
        mode.attach("new")
        await mode.loadTask?.value
        XCTAssertEqual(mode.label, "Default")
        XCTAssertEqual(mode.pillState, .ready)
        mode.attach("old")
        await mode.loadTask?.value
        release?.resume()
        await pick?.value
        XCTAssertEqual(mode.label, "Bypass")
        XCTAssertEqual(mode.pillState, .ready)
        XCTAssertEqual(mode.menu.title, "", "the abandoned pick's refusal reached the menu")
    }

    /// The pill holds its seat: "Mode", quiet and taking no taps, until the first
    /// answer. A read that fails with nothing known says why, with a Retry that
    /// heals it; a re-read that fails later keeps the mode it had.
    func testThePillHoldsItsSeatAndAFailedReadOffersRetry() async {
        let api = FakeTransport()
        api.failRead = APIError.server(
            status: 502, code: "bridge_offline", message: "The Mac is away", serverHash: nil, serverContent: nil
        )
        let mode = ComposerModeModel(transport: api)
        mode.attach("s1")
        XCTAssertNil(mode.label)
        XCTAssertEqual(mode.pillState, .waiting, "nothing to pick from before the first answer")
        await settle(mode)
        XCTAssertNotNil(mode.loadFailure)
        XCTAssertEqual(mode.pillState, .ready, "the failed pill must take a tap: its menu is the Retry")
        XCTAssertEqual(mode.menu.sections.flatMap(\.items).map(\.choice), [.retry])

        api.failRead = nil
        mode.menuSelect(.retry)
        await settle(mode)
        XCTAssertEqual(mode.label, "Bypass")
        XCTAssertNil(mode.loadFailure)

        api.failRead = APIError.network(underlying: URLError(.timedOut))
        mode.refresh()
        await settle(mode)
        XCTAssertEqual(mode.label, "Bypass", "a failed re-read dropped the mode the pill knew")
        XCTAssertNil(mode.loadFailure)
    }

    /// The same pick again, and a pick with no session, write nothing.
    func testNoOpPicksWriteNothing() async {
        let api = FakeTransport()
        let mode = ComposerModeModel(transport: api)
        mode.select("plan")
        mode.attach("s1")
        await settle(mode)
        mode.select("bypass")
        await settle(mode)
        XCTAssertTrue(api.applied.isEmpty)
    }

    /// The mode control is found by id: Claude's `mode`, else an ACP adapter's
    /// plan/exec split; a session with neither has no mode pill.
    func testTheModeControlIsFoundById() {
        let codex = SessionControlsPayload(engine: "codex", controls: [
            .init(id: "approval", name: "Approval", type: "select", currentValue: "a", options: [.init(value: "a", name: "A")]),
            .init(id: "collaboration_mode", name: "Mode", type: "select", currentValue: "plan", options: [
                .init(value: "plan", name: "Plan"), .init(value: "exec", name: "Exec"),
            ]),
        ])
        XCTAssertEqual(ComposerModeModel.modeControl(in: codex)?.id, "collaboration_mode")
        let none = SessionControlsPayload(engine: "codex", controls: [
            .init(id: "approval", name: "Approval", type: "select", currentValue: "a", options: [.init(value: "a", name: "A")]),
        ])
        XCTAssertNil(ComposerModeModel.modeControl(in: none))
    }
}
