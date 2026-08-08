import Foundation
@testable import Walnut

/// Test driver that scripts SSE events into a real SessionConversationStore —
/// arbitrary snapshot sizes (blocks / completedLen / isStreaming) and delta
/// sequences, exactly as SSEClient would deliver them. Used by the watchdog
/// regression tests to reproduce the giant-live-session freeze offline.
enum ScriptedSSE {

    /// Mirror of the store's SnapshotPayload wire shape (session-stream v1).
    struct Snapshot: Encodable {
        struct Block: Encodable {
            var type = "text"
            var content: String?
            var name: String? = nil
            var status: String? = nil
            var parentToolUseId: String? = nil
        }
        var blocks: [Block]
        var isStreaming = true
        var completedLen = 0
        var processStatus = "running"
    }

    static func session(id: String = "scripted-test-session") -> WalnutSession {
        WalnutSession(
            id: id, title: "Scripted", taskId: nil, taskTitle: nil, project: nil,
            host: "", processStatus: "running", model: nil, mode: nil,
            startedAt: "2026-08-07T00:00:00Z", lastActiveAt: "2026-08-07T00:00:00Z",
            messageCount: 0, cwd: nil, pinned: nil, focusTier: nil, description: nil
        )
    }

    /// A snapshot event whose single live text block totals ~`megabytes` MB —
    /// the "attach to a session whose in-flight live region is huge" shape
    /// (the field crash had a 206MB live stream JSONL behind an attach).
    static func snapshotEvent(megabytes: Int) -> SSEEvent {
        let unit = TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(1, rows: 2) + "\n\n"
        let repeats = (megabytes * 1_048_576) / unit.utf8.count + 1
        let content = String(repeating: unit, count: repeats)
        let snap = Snapshot(blocks: [Block(content: content)])
        let json = String(data: try! JSONEncoder().encode(snap), encoding: .utf8)!
        return SSEEvent(id: nil, event: "snapshot", data: json)
    }

    typealias Block = Snapshot.Block

    static func deltaEvent(bytes: Int) -> SSEEvent {
        let unit = TranscriptFixtures.cjk + "\n\n"
        let repeats = bytes / unit.utf8.count + 1
        let delta = String(String(repeating: unit, count: repeats).prefix(bytes))
        let json = String(data: try! JSONEncoder().encode(["delta": delta]), encoding: .utf8)!
        return SSEEvent(id: nil, event: "text-delta", data: json)
    }

    /// A live-region markdown string of ~`megabytes` MB (mixed CJK + tables).
    static func liveText(megabytes: Int) -> String {
        let unit = TranscriptFixtures.cjk + "\n\n" + TranscriptFixtures.table(1, rows: 2) + "\n\n"
        let repeats = (megabytes * 1_048_576) / unit.utf8.count + 1
        return String(repeating: unit, count: repeats)
    }
}
