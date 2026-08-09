import XCTest
@testable import Walnut

/// Wave-1 decode contracts + reducer logic: session lifecycle payloads
/// (pendingPermissions, restart/terminate/retry), task detail readback,
/// batch results, focus tiers, butler management, global search, and the
/// user_ask pending-question state machine on ChatStore.
final class Wave1ContractTests: XCTestCase {

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    // MARK: - Session detail + pending permissions

    func testSessionDetailDecodesPendingPermissions() throws {
        let json = """
        {
          "session": { "claudeSessionId": "abc-123", "process_status": "running",
                       "title": "My session", "mode": "default", "archived": false },
          "pendingPermissions": [
            { "requestId": "req-1", "toolName": "Bash",
              "input": { "command": "rm -rf build", "timeout": 5000 },
              "reason": "outside allowlist" }
          ]
        }
        """
        let detail = try decode(SessionDetail.self, json)
        XCTAssertEqual(detail.session.claudeSessionId, "abc-123")
        XCTAssertEqual(detail.pendingPermissions.count, 1)
        let p = detail.pendingPermissions[0]
        XCTAssertEqual(p.requestId, "req-1")
        XCTAssertEqual(p.toolName, "Bash")
        XCTAssertEqual(p.reason, "outside allowlist")
        // Summary picks the command key; the non-string timeout is skipped.
        XCTAssertEqual(p.inputSummary, "rm -rf build")
    }

    func testSessionDetailToleratesEmptyPermissionsAndUnknownInput() throws {
        let json = """
        {
          "session": { "claudeSessionId": "abc" },
          "pendingPermissions": [
            { "requestId": "r2", "input": { "weird": [1, {"x": true}], "deep": {"a": "b"} } }
          ]
        }
        """
        let detail = try decode(SessionDetail.self, json)
        XCTAssertNil(detail.session.processStatus)
        // Unknown structure decodes without throwing; no summary key matches.
        XCTAssertNil(detail.pendingPermissions[0].inputSummary)
        XCTAssertNil(detail.pendingPermissions[0].toolName)
    }

    func testPermissionSummaryClipsLongCommands() throws {
        let long = String(repeating: "x", count: 500)
        let p = PendingPermission(
            requestId: "r", toolName: "Bash",
            input: ["command": .string(long)], reason: nil
        )
        let summary = try XCTUnwrap(p.inputSummary)
        XCTAssertLessThanOrEqual(summary.count, 161) // 160 + ellipsis
        XCTAssertTrue(summary.hasSuffix("…"))
    }

    // MARK: - Lifecycle action payloads

    func testRestartAndTerminateAndRetryDecode() throws {
        let restarted = try decode(SessionRestarted.self,
            #"{ "status": "restarted", "sessionId": "s1", "pendingMessages": 2 }"#)
        XCTAssertEqual(restarted.pendingMessages, 2)

        let terminated = try decode(SessionTerminated.self,
            #"{ "status": "terminated", "sessionId": "s1", "tookMs": 640 }"#)
        XCTAssertEqual(terminated.tookMs, 640)

        // All three retry shapes decode through the one struct.
        let reconnected = try decode(SessionRetried.self,
            #"{ "status": "reconnected", "sessionId": "s1" }"#)
        XCTAssertEqual(reconnected.status, "reconnected")
        let pending = try decode(SessionRetried.self,
            #"{ "status": "pending", "taskId": "t1", "oldSessionId": "s0" }"#)
        XCTAssertNil(pending.sessionId)
        XCTAssertEqual(pending.oldSessionId, "s0")
    }

    // MARK: - Task detail readback

    func testTaskDetailDecodesFullRowAndRelations() throws {
        let json = """
        { "task": {
            "id": "task-1", "title": "Ship it", "status": "in_progress",
            "phase": "IN_PROGRESS", "priority": "important", "project": "walnut",
            "description": "Long description here", "summary": "short",
            "note": "# Note\\nbody", "tags": ["ios"], "starred": true, "pinned": false,
            "depends_on": ["task-0"], "is_blocked": true,
            "resolved_dependencies": [ { "id": "task-0", "title": "Dep", "phase": "TODO" } ],
            "dependents": [ { "id": "task-2", "title": "After", "phase": "TODO" } ],
            "children": [ { "id": "task-3", "title": "Child", "phase": "COMPLETE", "status": "done" } ],
            "parent": { "id": "task-p", "title": "Parent", "phase": "IN_PROGRESS", "status": "in_progress" },
            "session_ids": ["s1"],
            "some_future_field": { "ignored": true }
        } }
        """
        let detail = try decode(TaskDetailEnvelope.self, json).task
        XCTAssertEqual(detail.description, "Long description here")
        XCTAssertEqual(detail.note, "# Note\nbody")
        XCTAssertEqual(detail.isBlocked, true)
        XCTAssertEqual(detail.resolvedDependencies?.first?.title, "Dep")
        XCTAssertEqual(detail.children?.first?.status, "done")
        XCTAssertEqual(detail.parent?.id, "task-p")
    }

    // MARK: - Batch results (partial success contract)

    func testBatchResultsDecodePartialSuccess() throws {
        let phase = try decode(BatchPhaseResult.self, """
        { "changed": [ { "id": "a", "title": "A" } ],
          "failed": [ { "id": "b", "ok": false, "error": "blocked by dependency" } ],
          "syncFailed": ["a"] }
        """)
        XCTAssertEqual(phase.changed.count, 1)
        XCTAssertEqual(phase.failed.first?.error, "blocked by dependency")
        XCTAssertEqual(phase.syncFailed, ["a"])

        let del = try decode(BatchDeleteResult.self,
            #"{ "deleted": [ { "id": "a" } ], "failed": [] }"#)
        XCTAssertEqual(del.deleted.first?.id, "a")
        XCTAssertTrue(del.failed.isEmpty)
    }

    // MARK: - Focus tiers

    func testFocusTierResultDecodes() throws {
        let result = try decode(FocusTierResult.self, """
        { "pinned_tasks": ["a", "b"], "focus_tasks": ["a"],
          "satellite_tasks": [], "backlog_tasks": ["b"], "wait_tasks": [],
          "custom_tier_tasks": { "ct_12345678": ["c"] } }
        """)
        XCTAssertEqual(result.pinnedTasks, ["a", "b"])
        XCTAssertEqual(result.customTierTasks?["ct_12345678"], ["c"])

        let pins = try decode(FocusPinResult.self, #"{ "pinned_tasks": ["x"] }"#)
        XCTAssertEqual(pins.pinnedTasks, ["x"])
    }

    // MARK: - Butler management

    func testConversationManagementPayloadsDecode() throws {
        let patched = try decode(ConversationPatched.self,
            #"{ "conversation": { "id": "conv-1", "title": "Renamed", "pinned": true } }"#)
        XCTAssertEqual(patched.conversation.title, "Renamed")

        let stopped = try decode(ConversationStopped.self,
            #"{ "stopped": 1, "questionCancelled": true }"#)
        XCTAssertEqual(stopped.stopped, 1)
        XCTAssertTrue(stopped.questionCancelled)
    }

    // MARK: - Global search

    func testGlobalSearchDecodesAndSynthesizesIds() throws {
        let response = try decode(GlobalSearchResponse.self, """
        { "results": [
            { "type": "task", "id": "task-9", "title": "Fix bug", "snippet": "…", "score": 0.9 },
            { "type": "memory", "title": "A memory", "score": 0.5 },
            { "type": "task", "taskId": "task-7", "title": "Live shape", "matchField": "title" },
            { "type": "session", "sessionId": "sess-1", "title": "A session" }
        ] }
        """)
        XCTAssertEqual(response.results.count, 4)
        XCTAssertEqual(response.results[0].resultId, "task-9")
        // Memory hit without an id still has a usable synthetic Identifiable id.
        XCTAssertEqual(response.results[1].id, "memory|A memory")
        // Live server emits typed keys (taskId/sessionId), not the doc's `id?`.
        XCTAssertEqual(response.results[2].resultId, "task-7")
        XCTAssertEqual(response.results[3].resultId, "sess-1")
    }

    // MARK: - Error helpers

    func testWave1ErrorCodeHelpers() {
        let cron = APIError.server(status: 409, code: "cron_owner", message: "owns crons", serverHash: nil, serverContent: nil)
        XCTAssertTrue(cron.isCronOwner)
        let cloud = APIError.server(status: 501, code: "not_supported_cloud", message: "primary only", serverHash: nil, serverContent: nil)
        XCTAssertTrue(cloud.isNotSupportedCloud)
        XCTAssertFalse(cloud.isCronOwner)
    }

    // MARK: - ChatStore user_ask state machine

    @MainActor
    func testUserAskToolEventSetsPendingQuestion() {
        let chat = ChatStore()
        chat.activeID = "conv-1"
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-start", data: "{}"), conversationID: "conv-1"
        )
        XCTAssertFalse(chat.pendingQuestion)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "tool", data: #"{ "name": "user_ask" }"#),
            conversationID: "conv-1"
        )
        XCTAssertTrue(chat.pendingQuestion, "user_ask tool event must surface the question state")
        // An ordinary tool must NOT set it.
        chat.pendingQuestion = false
        chat.handleForTesting(
            SSEEvent(id: nil, event: "tool", data: #"{ "name": "Read" }"#),
            conversationID: "conv-1"
        )
        XCTAssertFalse(chat.pendingQuestion)
    }

    @MainActor
    func testPendingQuestionClearsOnTurnEndAndError() {
        let chat = ChatStore()
        chat.activeID = "conv-1"
        chat.handleForTesting(
            SSEEvent(id: nil, event: "tool", data: #"{ "name": "user_ask" }"#),
            conversationID: "conv-1"
        )
        XCTAssertTrue(chat.pendingQuestion)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "message-end", data: #"{ "turnId": "t", "fullText": "done" }"#),
            conversationID: "conv-1"
        )
        XCTAssertFalse(chat.pendingQuestion, "turn end must clear the question state")

        chat.handleForTesting(
            SSEEvent(id: nil, event: "tool", data: #"{ "name": "user_ask" }"#),
            conversationID: "conv-1"
        )
        XCTAssertTrue(chat.pendingQuestion)
        chat.handleForTesting(
            SSEEvent(id: nil, event: "error", data: #"{ "message": "boom" }"#),
            conversationID: "conv-1"
        )
        XCTAssertFalse(chat.pendingQuestion, "turn error must clear the question state")
    }
}
