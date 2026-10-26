#if DEBUG
import Foundation

/// A session transcript in every turn shape (`TimelineTurnShape`), for the DEBUG
/// timeline harness: the device pass that looks at hidden turns, an answered turn's
/// fold, Walnut's notes folded above a person's words, and no tag printing. Rows
/// carry `sentBy` the way a current server sends it. Neutral, invented content.
enum TimelineTurnFixtures {
    static func messages() -> [ChatMessage] {
        var rows: [ChatMessage] = []
        var second = 0
        func add(_ role: String, _ text: String, kind: ChatMessage.Kind? = nil, sentBy: String? = nil,
                 detail: String? = nil, result: String? = nil, input: String? = nil, isError: Bool? = nil) {
            second += 1
            var m = ChatMessage(id: "tf-\(second)", role: role, text: text,
                                createdAt: String(format: "2026-10-25T09:%02d:%02dZ", second / 60, second % 60),
                                kind: kind, detail: detail, resultPreview: result, inputPreview: input,
                                isError: isError)
            m.sentBy = sentBy
            rows.append(m)
        }
        func envelope(_ attributes: String, _ body: String) -> String {
            "<walnut-message \(attributes)>\n\(body)\n</walnut-message>"
        }
        // A person's question, answered after two calls (one run, left as it is).
        add("user", "Can you check why the nightly build failed?", sentBy: "person")
        add("assistant", "Read", kind: .tool, detail: "logs/nightly.log", result: "timeout in net test")
        add("assistant", "Bash", kind: .tool, detail: "Re-run the network tests", result: "12 passed")
        add("assistant", "It failed on a flaky network test. I re-ran it and it passed, so nothing is blocked.")
        // Two turns that needed nothing: hidden as one row.
        add("user", envelope("kind=\"peer-note\" from=\"Docs lead [1a2b3c4d]\" title=\"Review done\"",
                             "The style review is done, no changes needed."), sentBy: "agent")
        add("assistant", TimelineTurnMarker.tag)
        add("user", envelope("kind=\"notification\" from=\"Walnut\" outcome=\"completed\"",
                             "The task Update screenshots was completed."), sentBy: "agent")
        add("assistant", "Read", kind: .tool, detail: "docs/screens.md", result: "ok")
        add("assistant", TimelineTurnMarker.legacyTag)
        // A trigger whose turn drew an answer: its work is one folded row.
        add("user", envelope("kind=\"trigger\" from=\"Trigger: release branch\" note=\"fired, 1 new item\"",
                             "The release branch build finished."), sentBy: "agent")
        add("assistant", "Bash", kind: .tool, detail: "Check the build status", result: "green")
        add("assistant", "mcp__walnut__task_send", kind: .tool, detail: "Docs lead", result: "sent")
        add("assistant", "The release branch is green. You can tag 1.4 when you are ready.")
        // Walnut's note in front of a person's words: one row above the bubble.
        add("user", envelope("kind=\"notification\" from=\"Walnut\" outcome=\"moved\"",
                             "This task moved to the folder Release.") + "\n\nPlease draft the release notes.",
            sentBy: "person")
        add("assistant", "Listing the merged changes first", kind: .thinking)
        add("assistant", "The draft is ready in docs/release-notes.md.\n\n\(TimelineTurnMarker.tag)")
        // A reply whose turn ended in a failed call: open, the received message folded.
        add("user", envelope("kind=\"reply\" from=\"Build helper [5e6f7a8b]\" title=\"Cache cleared\"",
                             "I cleared the build cache."), sentBy: "agent")
        add("assistant", "Bash", kind: .tool, detail: "Rebuild the docs site", result: "exit 1", isError: true)
        return rows
    }

    /// A live turn a trigger started: history ends at the delivery, the session is
    /// still making calls for it (one finished, one running).
    static func liveTurn() -> (messages: [ChatMessage], tools: [LiveToolCall]) {
        (Array(messages().prefix(10)),
         [LiveToolCall(id: "live-1", name: "Bash", detail: "Check the build status", finished: true),
          LiveToolCall(id: "live-2", name: "Read", detail: "docs/release.md", finished: false)])
    }
}
#endif
