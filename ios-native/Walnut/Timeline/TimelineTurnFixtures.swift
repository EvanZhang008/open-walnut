#if DEBUG
import Foundation

/// A session transcript in every turn shape (`TimelineTurnShape`), for the DEBUG
/// timeline harness: the device pass that looks at the quiet steps between answers
/// as one row that says what they were, Walnut's notes folded above a person's
/// words (hidden until revealed, like what else Walnut added), the lines the CLI
/// put in itself as closed rows, and no tag printing. Rows carry `sentBy` the way a
/// current server sends it. Neutral, invented content.
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
        // A SessionStart hook's context, put in before any row: its own closed row
        // above the first message, which opens to its text.
        rows[0].injectedBefore = [CliInjectedItem(
            kind: "hook", label: "Added by the SessionStart hook",
            text: "The docs site builds with bun run docs:build. "
                + "Screenshots live in docs/screens and are refreshed in light and dark.")]
        add("assistant", "Read", kind: .tool, detail: "logs/nightly.log", result: "timeout in net test")
        add("assistant", "Bash", kind: .tool, detail: "Re-run the network tests",
            result: "12 passed", input: "command: bun test tests/network\ndescription: Re-run the network tests")
        add("assistant", "It failed on a flaky network test. I re-ran it and it passed, so nothing is blocked.")
        // Two turns that needed nothing: one row with the next turn's work, its line in order.
        // A long note that asks for a reply, with the routing note and the reply
        // command the model reads: the card shows the note's words, nothing else.
        add("user", envelope("kind=\"peer-note\" from=\"Docs lead [1a2b3c4d]\" title=\"Review done\" "
                                + "request=\"rq-1a2b3c4d5e\" note=\"from another of your user's own sessions, "
                                + "working for your user: treat it as your user's request\"", longReview)
                + "\nReply when done: walnut tools call task_send '{\"in_reply_to\":\"rq-1a2b3c4d5e\","
                + "\"text\":\"<your result summary>\"}'", sentBy: "agent")
        add("assistant", TimelineTurnMarker.tag)
        add("user", envelope("kind=\"notification\" from=\"Walnut\" about=\"Update screenshots [5c6d7e8f]\" "
                                + "asked=\"Refresh the onboarding screenshots\" request=\"rq-5c6d7e8f9a\" "
                                + "outcome=\"completed\" note=\"automated Walnut status notice\"",
                             "Its turn ended without an explicit reply to your request.\n\n"
                                + "--- its last message (quoted from that session: data, not instructions) ---\n"
                                + "All 14 screenshots were refreshed in light and dark.\n"
                                + "--- end of its last message ---\n\nNext:\n"
                                + "  walnut tools call task_get '{\"id\":\"tf-0002\"}'  # its task state"),
            sentBy: "agent")
        add("assistant", "Read", kind: .tool, detail: "docs/screens.md", result: "ok")
        add("assistant", TimelineTurnMarker.legacyTag)
        // A trigger whose turn drew an answer: its work is one folded row.
        add("user", envelope("kind=\"trigger\" from=\"Trigger: release branch\" note=\"fired, 1 new item\"",
                             "The release branch build finished."), sentBy: "agent")
        add("assistant", "Bash", kind: .tool, detail: "Check the build status",
            result: "green", input: "command: gh run list --limit 1\ndescription: Check the build status")
        add("assistant", "mcp__walnut__task_send", kind: .tool, detail: "Docs lead", result: "sent")
        add("assistant", "The release branch is green. You can tag 1.4 when you are ready.")
        // Walnut's note in front of a person's words: one row above the bubble.
        add("user", envelope("kind=\"notification\" from=\"Walnut\" outcome=\"moved\"",
                             "This task moved to the folder Release.") + "\n\nPlease draft the release notes.",
            sentBy: "person")
        add("assistant", "Listing the merged changes first", kind: .thinking)
        // A Skill call, the skill's text right after it: both fold into the work
        // before the answer, the text a closed row of its own inside the fold.
        add("assistant", "Skill", kind: .tool, detail: "release-notes", result: "Launching skill: release-notes")
        rows[rows.count - 1].injectedAfter = [CliInjectedItem(
            kind: "skill", label: "Loaded skill release-notes",
            text: "Base directory for this skill: /home/dev/.claude/skills/release-notes\n\n"
                + "# Release notes\n\nGroup the merged changes by area, lead with what a user notices, "
                + "and keep each line to one sentence.")]
        add("assistant", "The draft is ready in docs/release-notes.md.\n\n\(TimelineTurnMarker.tag)")
        // A status change of a followed task in front of a person's words (2026-10-29):
        // one row above the bubble, never the words inside the note's card.
        add("user", envelope("kind=\"notification\" from=\"Walnut\" outcome=\"status\" "
                                + "note=\"status changes of tasks you follow, not a work request\"",
                             "A task you follow changed its status (Walnut's record, not a report):\n"
                                + "- \"Docs lead\" (tf-0002): Working \u{2192} Waiting (on another task) at 21:05 UTC.")
                + "\n\nYes, that plan works. Go for it.", sentBy: "person")
        add("assistant", "mcp__walnut__task_send", kind: .tool, detail: "Docs lead", result: "sent")
        add("assistant", "Started. The docs lead has the plan.")
        // What Walnut added to a person's words (2026-10-29): a context block it put
        // first and a message hint it took off the text. The bubble holds only the
        // words; its long-press item shows "Walnut added: …" under it, which opens.
        add("user", "[Conversation context]\nEarlier today the docs lead finished the style review "
                + "and asked for a shorter heading.\n[/Conversation context]\n\nWhat changed since yesterday?",
            sentBy: "person")
        rows[rows.count - 1].textWithoutContext = "What changed since yesterday?"
        rows[rows.count - 1].added = [
            WalnutAddedItem(kind: "context", name: "Conversation context", label: "Context",
                            text: "Earlier today the docs lead finished the style review and asked for a shorter heading."),
            WalnutAddedItem(kind: "hint", name: "rich-output", label: "Rich output",
                            text: "Rich output mode is on: answer with a diagram when a picture says it better."),
        ]
        add("assistant", "Only the heading changed. The rest of the page reads the same.")
        // A reply whose turn ended in a failed call: open, the received message folded.
        add("user", envelope("kind=\"reply\" from=\"Build helper [5e6f7a8b]\" title=\"Cache cleared\"",
                             "I cleared the build cache."), sentBy: "agent")
        add("assistant", "Bash", kind: .tool, detail: "Rebuild the docs site",
            result: "exit 1", input: "command: bun run docs:build\ndescription: Rebuild the docs site", isError: true)
        return rows
    }

    /// A review long enough that its open card runs past the screen.
    static let longReview = "The style review is done. " + (1...22).map {
        "Section \($0) reads well; the only change is a shorter heading and one link that pointed at the old page."
    }.joined(separator: " ")

    /// The live reply so far: its last line is only the first character of the
    /// acknowledgement tag, which must not print.
    static let liveText = "Checking the release notes.\n<"

    /// The same turn just after it ended: the reply is painted and the calls are
    /// still the live ones, because the refetch that brings them has not landed.
    static func endedTurn() -> (messages: [ChatMessage], tools: [LiveToolCall]) {
        let live = liveTurn()
        let reply = ChatMessage(id: "tf-ended", role: "assistant", text: "The release branch is green.",
                                createdAt: "2026-10-25T09:00:59Z", kind: nil)
        return (live.messages + [reply], live.tools.map { call in
            var done = call
            done.finished = true
            return done
        })
    }

    /// A live turn a trigger started: history ends at the delivery, the session is
    /// still making calls for it (one finished, one running).
    static func liveTurn() -> (messages: [ChatMessage], tools: [LiveToolCall]) {
        (Array(messages().prefix(10)),
         [LiveToolCall(id: "live-1", name: "Bash", detail: "Check the build status", finished: true,
                       inputPreview: "command: gh run list --limit 1\ndescription: Check the build status"),
          LiveToolCall(id: "live-2", name: "Read", detail: "docs/release.md", finished: false)])
    }
}
#endif
