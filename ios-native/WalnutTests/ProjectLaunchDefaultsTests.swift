import XCTest
@testable import Walnut

/// A project's launch defaults on the phone's new-session draft (DraftLaunchDefaults): what the
/// pills show, the one line that says where the values come from, and what the create call sends.
///
/// The bug class: a draft that shows one engine, model or mode and starts another. Untouched pills
/// show the project's values and send nothing (the server applies and records them); a pick is the
/// task's own and is sent, Claude Code named when the silence would apply the project's pair.
final class ProjectLaunchDefaultsTests: XCTestCase {

    private func defaults(engine: String? = "claude", model: String? = "sonnet", mode: String? = "accept") -> DraftLaunchDefaults? {
        DraftLaunchDefaults(project: "Walnut", metadata: .init(defaultEngine: engine, defaultModel: model, defaultMode: mode))
    }

    // MARK: - Reading the project's row

    func testNoDefaultsIsNil() {
        XCTAssertNil(DraftLaunchDefaults(project: "Walnut", metadata: nil))
        XCTAssertNil(DraftLaunchDefaults(project: "Walnut", metadata: .init()))
        XCTAssertNil(DraftLaunchDefaults(project: "Walnut", metadata: .init(defaultModel: "sonnet")),
                     "a model without its engine is not a default")
    }

    func testModelNeedsItsEngineAndUnknownModeReadsUnset() {
        let d = defaults(engine: nil, model: "sonnet", mode: "plan")
        XCTAssertNil(d?.engine)
        XCTAssertNil(d?.model)
        XCTAssertEqual(d?.mode, .plan)
        XCTAssertNil(defaults(engine: "claude", model: "default", mode: "nope")?.model)
        XCTAssertNil(defaults(engine: "claude", model: "sonnet", mode: "nope")?.mode)
    }

    func testDecodeIsTolerantOfOtherShapes() throws {
        let json = #"{"projects":[{"name":"Walnut","source":"local","metadata":{"default_cwd":"/x","default_engine":"codex","default_mode":7}},{"name":"Home","source":"local","metadata":"odd"}]}"#
        struct Wrapper: Decodable { let projects: [WalnutProjectSource] }
        let rows = try JSONDecoder().decode(Wrapper.self, from: Data(json.utf8)).projects
        XCTAssertEqual(rows.count, 2, "one odd row never fails the list")
        XCTAssertEqual(rows[0].metadata?.defaultEngine, "codex")
        XCTAssertNil(rows[0].metadata?.defaultMode)
        XCTAssertNil(rows[1].metadata)
    }

    // MARK: - What the draft shows

    func testShownModelIsTheProjectsOnAnyEngine() {
        XCTAssertEqual(defaults()?.shownModel, "sonnet")
        XCTAssertEqual(defaults(engine: "codex", model: "gpt-5.5")?.shownModel, "gpt-5.5",
                       "the phone starts the project's own engine, so its model is what it starts on")
        XCTAssertNil(defaults()?.otherEngine)
        XCTAssertEqual(defaults(engine: "codex", model: nil)?.otherEngine, "codex")
    }

    func testLineNamesTheProjectAndDropsWhatWasPickedOver() {
        XCTAssertEqual(defaults()?.line(modeTouched: false, modelTouched: false),
                       "New tasks in Walnut start in Accept Edits with Sonnet (project defaults).")
        XCTAssertEqual(defaults()?.line(modeTouched: true, modelTouched: false),
                       "New tasks in Walnut start with Sonnet (project defaults).")
        XCTAssertNil(defaults()?.line(modeTouched: true, modelTouched: true))
    }

    func testLineNamesAnotherEngine() {
        XCTAssertEqual(defaults(engine: "codex", model: "gpt-5.5", mode: "plan")?.line(modeTouched: false, modelTouched: false),
                       "New tasks in Walnut start on Codex in Plan with gpt-5.5 (project defaults).")
        XCTAssertEqual(defaults(engine: "codex", model: nil, mode: "plan")?.line(modeTouched: false, modelTouched: true),
                       "New tasks in Walnut start in Plan (project defaults).",
                       "a model picked here is Claude Code's, so the project's engine is no longer the line's")
    }

    func testAnotherEngineGivesWayOnARemoteHost() {
        let codex = defaults(engine: "codex", model: "gpt-5.5", mode: "plan")
        XCTAssertEqual(codex?.onHost(""), codex, "the primary machine runs it")
        XCTAssertEqual(codex?.onHost("__local__"), codex)
        let remote = codex?.onHost("clouddev")
        XCTAssertNil(remote?.engine)
        XCTAssertNil(remote?.shownModel, "never Codex's model on Claude Code")
        XCTAssertEqual(remote?.mode, .plan, "the mode still applies")
        XCTAssertEqual(remote?.line(modeTouched: false, modelTouched: false),
                       "New tasks in Walnut start in Plan (project defaults). Codex, the default engine of Walnut, runs only on the main computer, so a session on this host starts Claude Code.")
        let pair = DraftLaunchDefaults.wirePair(picked: nil, touched: false, defaults: remote)
        XCTAssertNil(pair.model)
        XCTAssertFalse(pair.namesClaude)
        XCTAssertEqual(defaults()?.onHost("clouddev"), defaults(), "Claude Code runs on every host")
    }

    func testEveryEngineHasItsName() {
        // The server's engine registry (src/core/agents/engine-registry.ts), by id.
        let names = ["claude": "Claude Code", "codex": "Codex", "gemini": "Gemini", "opencode": "OpenCode",
                     "goose": "Goose", "pi": "Pi", "dsh": "DeepSeek Harness", "custom": "Custom (ACP)"]
        for (id, name) in names { XCTAssertEqual(DraftLaunchDefaults.engineName(id), name) }
    }

    // MARK: - A launch answered without a session id

    func testNewSessionIsTheTasksNewestOneNotSeenBefore() {
        func s(_ id: String, _ task: String, _ at: String) -> WalnutSession {
            WalnutSession(id: id, title: "t", taskId: task, taskTitle: nil, project: nil, host: "", processStatus: "idle",
                          model: nil, mode: nil, startedAt: at, lastActiveAt: at, messageCount: 0, cwd: nil,
                          pinned: nil, focusTier: nil, description: nil)
        }
        let list = [s("old", "t1", "2026-11-08T10:00:00Z"), s("new", "t1", "2026-11-08T11:00:00Z"),
                    s("other", "t2", "2026-11-08T12:00:00Z")]
        XCTAssertEqual(DraftLaunchDefaults.newSession(of: "t1", excluding: [], in: list)?.id, "new")
        XCTAssertNil(DraftLaunchDefaults.newSession(of: "t1", excluding: ["old", "new"], in: list),
                     "a task's older session is never taken for the one this launch started")
        XCTAssertNil(DraftLaunchDefaults.newSession(of: "t4", excluding: [], in: list))
    }

    func testLaunchSessionBodySaysItOpensWithoutAnId() throws {
        var body = WalnutAPI.createSessionBody(cwd: "/x", host: nil, message: "", taskId: nil, mode: nil, model: nil)
        body.sessionIdOptional = true
        let json = String(decoding: try JSONEncoder().encode(body), as: UTF8.self)
        XCTAssertTrue(json.contains("\"sessionIdOptional\":true"))
        let answer = try JSONDecoder().decode(SessionLaunched.self, from: Data(#"{"taskId":"t1","title":"x"}"#.utf8))
        XCTAssertNil(answer.sessionId)
    }

    func testUnknownModelIdIsShownByItsIdAndStaysChecked() {
        XCTAssertEqual(NewSessionChatView.modelLabel("claude-sonnet-4-6"), "claude-sonnet-4-6")
        XCTAssertEqual(NewSessionChatView.modelLabel(nil), "Default model")
        let items = NewSessionChatView.modelMenu(selected: "claude-sonnet-4-6").sections[0].items
        XCTAssertEqual(items.filter(\.checked).map(\.title), ["claude-sonnet-4-6"])
        XCTAssertEqual(NewSessionChatView.modelMenu(selected: "opus").sections[0].items.count, 4,
                       "a known alias adds no row")
    }

    // MARK: - What the create call sends

    func testUntouchedModeLeavesTheProjectsToTheServer() {
        XCTAssertNil(DraftLaunchDefaults.wireMode(picked: .accept, touched: false, defaults: defaults()))
        // No project mode: as before (bypass absent, another start mode named).
        XCTAssertNil(DraftLaunchDefaults.wireMode(picked: .bypass, touched: false, defaults: nil))
        XCTAssertEqual(DraftLaunchDefaults.wireMode(picked: .plan, touched: false, defaults: nil), "plan")
    }

    func testPickedModeIsSentAndBypassOverAProjectModeIsNamed() {
        XCTAssertEqual(DraftLaunchDefaults.wireMode(picked: .plan, touched: true, defaults: defaults()), "plan")
        XCTAssertEqual(DraftLaunchDefaults.wireMode(picked: .bypass, touched: true, defaults: defaults()), "bypass")
        XCTAssertNil(DraftLaunchDefaults.wireMode(picked: .bypass, touched: true, defaults: nil))
    }

    func testUntouchedPairLeavesTheProjectsToTheServer() {
        let pair = DraftLaunchDefaults.wirePair(picked: "sonnet", touched: false, defaults: defaults())
        XCTAssertNil(pair.model)
        XCTAssertFalse(pair.namesClaude)
        let plain = DraftLaunchDefaults.wirePair(picked: nil, touched: false, defaults: defaults(engine: nil, mode: "plan"))
        XCTAssertNil(plain.model)
        XCTAssertFalse(plain.namesClaude)
    }

    func testPickingTheProjectsOwnModelAgainKeepsItsEngine() {
        let codex = defaults(engine: "codex", model: "gpt-5.5", mode: nil)
        XCTAssertTrue(DraftLaunchDefaults.keepsProjectPair(picked: "gpt-5.5", defaults: codex))
        let again = DraftLaunchDefaults.wirePair(picked: "gpt-5.5", touched: true, defaults: codex)
        XCTAssertNil(again.model, "left to the server, which runs it on Codex")
        XCTAssertFalse(again.namesClaude, "never Claude Code with Codex's model")
        let noModel = defaults(engine: "codex", model: nil, mode: nil)
        XCTAssertTrue(DraftLaunchDefaults.keepsProjectPair(picked: nil, defaults: noModel), "Default on a project engine with no model is its default")
        XCTAssertFalse(DraftLaunchDefaults.keepsProjectPair(picked: "opus", defaults: codex))
        XCTAssertFalse(DraftLaunchDefaults.keepsProjectPair(picked: nil, defaults: nil))
    }

    func testPickedModelOverAProjectEngineNamesClaudeCode() {
        let opus = DraftLaunchDefaults.wirePair(picked: "opus", touched: true, defaults: defaults())
        XCTAssertEqual(opus.model, "opus")
        XCTAssertTrue(opus.namesClaude)
        let engineDefault = DraftLaunchDefaults.wirePair(picked: nil, touched: true, defaults: defaults())
        XCTAssertNil(engineDefault.model)
        XCTAssertTrue(engineDefault.namesClaude, "Default over the project's model is an own pick")
        let noProject = DraftLaunchDefaults.wirePair(picked: "opus", touched: true, defaults: nil)
        XCTAssertEqual(noProject.model, "opus")
        XCTAssertFalse(noProject.namesClaude)
    }

    func testNamesClaudeRidesTheWireOnlyWhenSet() throws {
        let named = WalnutAPI.createSessionBody(cwd: "/x", host: nil, message: "", taskId: nil, mode: nil, model: nil, namesClaude: true)
        XCTAssertEqual(named.engine, "claude")
        let plain = WalnutAPI.createSessionBody(cwd: "/x", host: nil, message: "", taskId: nil, mode: nil, model: nil)
        let json = String(decoding: try JSONEncoder().encode(plain), as: UTF8.self)
        XCTAssertFalse(json.contains("engine"), "absent, so an older server sees the same body")
    }
}
