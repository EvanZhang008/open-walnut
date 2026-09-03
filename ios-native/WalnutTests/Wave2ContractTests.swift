import XCTest
@testable import Walnut

/// Wave-2 decode contracts + pure helpers: routines (schedule display, state),
/// provider-neutral session controls (lenient decode), queued messages,
/// plan/side-question payloads, NL quick-parse (local dates), the config
/// whitelist projection, chat stats math, and file browsing payloads.
final class Wave2ContractTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: - Routines

    func testRoutineJobDecodesFullRow() throws {
        let json = """
        { "jobs": [ {
            "id": "job-1", "name": "Morning triage", "description": "daily sweep",
            "enabled": true,
            "createdAtMs": 1754000000000, "updatedAtMs": 1754000000000,
            "schedule": { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "America/Los_Angeles" },
            "sessionTarget": "isolated", "wakeMode": "next-cycle",
            "payload": { "kind": "agentTurn", "message": "triage" },
            "executor": { "type": "claude-code", "config": { "cwd": "/tmp/x" } },
            "state": { "nextRunAtMs": 1754900000000, "lastRunAtMs": 1754800000000,
                       "lastStatus": "ok", "lastDurationMs": 4200 }
        } ] }
        """
        let jobs = try decode(RoutinesResponse.self, json).jobs
        XCTAssertEqual(jobs.count, 1)
        let job = jobs[0]
        XCTAssertEqual(job.name, "Morning triage")
        XCTAssertTrue(job.enabled)
        XCTAssertEqual(job.schedule.display, "0 9 * * 1-5 · America/Los_Angeles")
        XCTAssertEqual(job.executor?.label, "Claude Code")
        XCTAssertEqual(job.state?.lastStatus, "ok")
        XCTAssertNotNil(job.state?.lastRunDate)
        XCTAssertNotNil(job.state?.nextRunDate)
    }

    func testRoutineScheduleDisplayVariants() throws {
        let every = try decode(RoutineJob.Schedule.self, #"{ "kind": "every", "everyMs": 1800000 }"#)
        XCTAssertEqual(every.display, "Every 30m")
        let everyHours = try decode(RoutineJob.Schedule.self, #"{ "kind": "every", "everyMs": 5400000 }"#)
        XCTAssertEqual(everyHours.display, "Every 1.5h")
        let bareCron = try decode(RoutineJob.Schedule.self, #"{ "kind": "cron", "expr": "*/5 * * * *" }"#)
        XCTAssertEqual(bareCron.display, "*/5 * * * *")
        let at = try decode(RoutineJob.Schedule.self, #"{ "kind": "at", "at": "2026-08-10T09:00:00.000Z" }"#)
        XCTAssertTrue(at.display.hasPrefix("At "))
        // Unknown kind must not crash — fall back to the raw kind.
        let future = try decode(RoutineJob.Schedule.self, #"{ "kind": "lunar" }"#)
        XCTAssertEqual(future.display, "lunar")
    }

    func testRoutineErrorStateDecodes() throws {
        let job = try decode(RoutineEnvelope.self, """
        { "job": { "id": "j2", "name": "Backup", "enabled": false,
                   "schedule": { "kind": "every", "everyMs": 3600000 },
                   "state": { "lastStatus": "error", "lastError": "host unreachable" } } }
        """).job
        XCTAssertFalse(job.enabled)
        XCTAssertEqual(job.state?.lastError, "host unreachable")
        XCTAssertNil(job.state?.lastRunDate)
    }

    // MARK: - Session controls

    func testSessionControlsDecodeModeSelect() throws {
        let payload = try decode(SessionControlsPayload.self, """
        { "engine": "claude", "controls": [ {
            "id": "mode", "name": "Mode", "type": "select", "currentValue": "default",
            "options": [ { "value": "default", "name": "Default" },
                         { "value": "plan", "name": "Plan" },
                         { "value": "bypass", "name": "Bypass" } ]
        } ] }
        """)
        XCTAssertEqual(payload.engine, "claude")
        XCTAssertEqual(payload.controls.first?.currentValue, "default")
        XCTAssertEqual(payload.controls.first?.options?.count, 3)
        XCTAssertEqual(payload.controls.first?.options?[1].label, "Plan")
    }

    func testSessionControlsToleratesUnknownShapes() throws {
        // A future Codex control with a non-string currentValue must not
        // throw — leniency is the whole point of the custom decoder.
        let payload = try decode(SessionControlsPayload.self, """
        { "engine": "codex", "controls": [
            { "id": "sandbox", "currentValue": true, "options": "nope" },
            { "id": "mode", "type": "select", "currentValue": "plan",
              "options": [ { "value": "plan" } ] }
        ] }
        """)
        XCTAssertEqual(payload.controls.count, 2)
        XCTAssertNil(payload.controls[0].currentValue)
        XCTAssertNil(payload.controls[0].options)
        // An option without a name falls back to the value for its label.
        XCTAssertEqual(payload.controls[1].options?.first?.label, "plan")
    }

    // MARK: - Queue

    func testQueuedMessagesDecodeAndPendingFlag() throws {
        let response = try decode(SessionQueueResponse.self, """
        { "messages": [
            { "id": "qm-1", "sessionId": "s", "message": "do the thing",
              "status": "pending", "enqueuedAt": "2026-08-09T01:00:00.000Z", "seq": 4 },
            { "id": "qm-2", "sessionId": "s", "message": "mid-flight",
              "status": "processing", "enqueuedAt": "2026-08-09T01:01:00.000Z" }
        ] }
        """)
        XCTAssertEqual(response.messages.count, 2)
        XCTAssertTrue(response.messages[0].isPending)
        XCTAssertFalse(response.messages[1].isPending)
        XCTAssertNotNil(response.messages[0].enqueuedDate)
    }

    // MARK: - Plan + side questions

    func testPlanAndSideQuestionPayloadsDecode() throws {
        let plan = try decode(SessionPlanPayload.self,
            ##"{ "content": "# Plan\n- step", "planFile": "/tmp/plans/p.md", "sourceSessionId": "src-1" }"##)
        XCTAssertTrue(plan.content.hasPrefix("# Plan"))
        XCTAssertEqual(plan.sourceSessionId, "src-1")

        let questions = try decode(SideQuestionsResponse.self, """
        { "sideQuestions": [
            { "id": "sq-1", "sessionId": "s", "question": "why?", "answer": "because",
              "createdAt": "2026-08-09T01:00:00.000Z", "promotedTaskId": "task-1" },
            { "id": "sq-2", "sessionId": "s", "question": "what?", "answer": "42" }
        ] }
        """).sideQuestions
        XCTAssertEqual(questions.count, 2)
        XCTAssertEqual(questions[0].promotedTaskId, "task-1")
        XCTAssertNil(questions[1].promotedTaskId)
    }

    // MARK: - Quick-parse

    func testQuickParseDecodesSnakeCaseAndLocalDates() throws {
        let parsed = try decode(QuickParsedTask.self, """
        { "title": "File the report", "due_date": "2026-08-10T09:00:00",
          "start_date": "2026-08-10", "priority": "important",
          "project": "walnut", "project_is_new": true, "pinTier": "focus" }
        """)
        XCTAssertEqual(parsed.title, "File the report")
        XCTAssertEqual(parsed.priority, "important")
        XCTAssertEqual(parsed.projectIsNew, true)

        // Local wall-clock parse: 9am IN THE CURRENT TIMEZONE.
        let due = try XCTUnwrap(QuickParsedTask.parseLocalDate(parsed.dueDate))
        let hour = Calendar.current.component(.hour, from: due)
        XCTAssertEqual(hour, 9)
        // Date-only variant parses to local midnight.
        let start = try XCTUnwrap(QuickParsedTask.parseLocalDate(parsed.startDate))
        XCTAssertEqual(Calendar.current.component(.hour, from: start), 0)
        // Garbage → nil, never a crash.
        XCTAssertNil(QuickParsedTask.parseLocalDate("tomorrow-ish"))
        XCTAssertNil(QuickParsedTask.parseLocalDate(nil))
    }

    func testQuickParseMinimalShape() throws {
        // The server guarantees only `title`; everything else is optional.
        let parsed = try decode(QuickParsedTask.self, #"{ "title": "Buy milk" }"#)
        XCTAssertEqual(parsed.title, "Buy milk")
        XCTAssertNil(parsed.dueDate)
        XCTAssertNil(parsed.project)
    }

    // MARK: - Config projection + chat stats

    func testServerConfigInfoDecodesAndSortsHosts() throws {
        let info = try decode(ServerConfigInfo.self, """
        { "config": {
            "user": { "name": "Evan" },
            "defaults": { "priority": "none" },
            "provider": { "type": "bedrock", "model": "opus", "bedrock_region": "us-west-2" },
            "agent": { "main_model": "global.anthropic.claude-opus-4-8[1m]" },
            "hosts": { "zeta": { "label": "Zeta Box", "enabled": true },
                       "alpha": { "label": "Alpha", "enabled": true },
                       "off": { "label": "Disabled One", "enabled": false } }
          },
          "cloud": false, "processNice": 0,
          "memory": { "rssMb": 512, "heapUsedMb": 200, "uptimeSec": 90061 } }
        """)
        XCTAssertEqual(info.config.provider?.type, "bedrock")
        XCTAssertEqual(info.config.provider?.bedrockRegion, "us-west-2")
        XCTAssertEqual(info.config.agent?.mainModel, "global.anthropic.claude-opus-4-8[1m]")
        // Disabled hosts drop; the rest sort A→Z by label.
        XCTAssertEqual(info.enabledHostLabels, ["Alpha", "Zeta Box"])
        XCTAssertEqual(info.memory?.uptimeSec, 90061)
        // 90061s = 1d 1h.
        XCTAssertEqual(SettingsView.uptimeText(90061), "1d 1h")
        XCTAssertEqual(SettingsView.uptimeText(300), "5m")
        XCTAssertEqual(SettingsView.uptimeText(7200), "2h 0m")
    }

    func testChatStatsContextPercent() throws {
        let stats = try decode(ChatStats.self, """
        { "apiMessageCount": 42, "estimatedTokens": 30000, "systemTokens": 5000,
          "toolsTokens": 5000, "estimatedTotalTokens": 40000,
          "compacted": false, "contextWindow": 200000 }
        """)
        XCTAssertEqual(stats.contextPercent, 20)
        // Missing window → no percent, never a divide-by-zero.
        let partial = try decode(ChatStats.self, #"{ "apiMessageCount": 1 }"#)
        XCTAssertNil(partial.contextPercent)
        let zeroWindow = try decode(ChatStats.self,
            #"{ "estimatedTotalTokens": 10, "contextWindow": 0 }"#)
        XCTAssertNil(zeroWindow.contextPercent)
    }

    // MARK: - File browsing

    func testFileListAndContentDecode() throws {
        // LIVE server shape (verified 2026-08-09): entries carry NO `path`
        // despite the doc — clients join parent + name. Both shapes decode.
        let list = try decode(SessionFileListResponse.self, """
        { "path": "/repo", "entries": [
            { "name": "src", "type": "dir", "hasChildren": true },
            { "name": "README.md", "path": "/repo/README.md", "type": "file", "size": 2048 }
        ] }
        """)
        XCTAssertEqual(list.entries.count, 2)
        XCTAssertTrue(list.entries[0].isDirectory)
        XCTAssertFalse(list.entries[1].isDirectory)
        // Path-less entry joins against the listed directory; an absolute
        // server-sent path wins; trailing slash doesn't double up.
        XCTAssertEqual(list.entries[0].absolutePath(in: "/repo"), "/repo/src")
        XCTAssertEqual(list.entries[0].absolutePath(in: "/repo/"), "/repo/src")
        XCTAssertEqual(list.entries[1].absolutePath(in: "/elsewhere"), "/repo/README.md")
        XCTAssertEqual(SessionDirectoryList.sizeText(2048), "2.0 KB")
        XCTAssertEqual(SessionDirectoryList.sizeText(500), "500 B")
        XCTAssertEqual(SessionDirectoryList.sizeText(3_145_728), "3.0 MB")
        XCTAssertNil(list.selectedFile, "a real directory names no file")

        // Ask for a FILE and the server lists its PARENT, naming the file.
        // Verified live 2026-09-03 against GET /api/v1/files/list?path=/usr/bin/jq:
        // {"path":"/usr/bin","selectedFile":"jq","entries":[…]}. The client used to
        // decode this and throw both fields away, which is how a listing of
        // /usr/bin ended up titled "jq".
        let redirected = try decode(SessionFileListResponse.self, """
        { "path": "/usr/bin", "selectedFile": "jq", "entries": [
            { "name": "aa", "type": "file" }, { "name": "jq", "type": "file" }
        ] }
        """)
        XCTAssertEqual(redirected.path, "/usr/bin")
        XCTAssertEqual(redirected.selectedFile, "jq")

        let ok = try decode(SessionFileContent.self,
            #"{ "content": "hello", "size": 5, "truncated": false, "binary": false, "extension": "txt" }"#)
        XCTAssertEqual(ok.content, "hello")
        XCTAssertNil(ok.error)
        // Missing file: 200 with error set (the viewer contract).
        let missing = try decode(SessionFileContent.self, #"{ "error": "File not found" }"#)
        XCTAssertEqual(missing.error, "File not found")
        XCTAssertNil(missing.content)
    }

    // MARK: - Error copy (cloud failure ladder)

    func testFriendlyFilesErrorCoversCloud501() {
        // UPDATED (2026-09): 501 used to be told "open this on your Mac", because
        // file content could not ride the bridge at all. It can now
        // (`fs.readBounded`), so a 501 means only that the target host's daemon
        // is out of date — which fixes itself on the next auto-deploy. Sending
        // that reader to their Mac forever was the wrong advice, and it also made
        // 501 indistinguishable from a 403 secret-path refusal.
        let cloud = APIError.server(status: 501, code: "not_supported_cloud",
                                    message: "no bridge read", serverHash: nil, serverContent: nil)
        let cloudCopy = SessionDirectoryList.friendlyFilesError(cloud)
        XCTAssertTrue(cloudCopy.contains("older Walnut daemon"), cloudCopy)
        XCTAssertFalse(cloudCopy.contains("Mac"), cloudCopy)
        let offline = APIError.server(status: 503, code: "bridge_offline",
                                      message: "down", serverHash: nil, serverContent: nil)
        XCTAssertTrue(SessionDirectoryList.friendlyFilesError(offline).contains("reachable"))
    }

    func testRoutinesFriendlyErrorLadder() {
        let upgrade = APIError.server(status: 400, code: "session_control_needs_upgrade",
                                      message: "old daemon", serverHash: nil, serverContent: nil)
        XCTAssertTrue(RoutinesView.friendlyError(upgrade).contains("upgrading"))
        let engine = APIError.server(status: 503, code: "internal",
                                     message: "Routines engine is not running", serverHash: nil, serverContent: nil)
        XCTAssertTrue(RoutinesView.friendlyError(engine).contains("starting"))
    }
}
