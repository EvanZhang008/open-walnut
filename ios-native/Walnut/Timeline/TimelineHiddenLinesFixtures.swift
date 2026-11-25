import Foundation

/// Replies whose status lines Walnut hid (`ChatMessage.hidden`), for the timeline harness
/// (`--timeline-harness-hidden-lines`, which also turns `ui.show_hidden_lines` on): each one's
/// "Hidden by Walnut" row under the words, closed until tapped.
enum TimelineHiddenLinesFixtures {
    static func messages() -> [ChatMessage] {
        var answer = ChatMessage(
            id: "hl-1", role: "assistant",
            // The status line still in the text, as a transcript a replica built carries it: the
            // screen takes it out, and the fold shows it after the server's own `hidden` lines.
            text: "Yes. It landed and production serves it; replies no longer end with the list of open threads.\n\nFOR_USER_STATE: answered",
            createdAt: "2026-11-25T01:00:01Z", kind: nil)
        answer.hidden = "th-5eb5fa81b1fd: answered \u{00B7} the fix is live, production serves it\nth-91c2aa07d3e4: working \u{00B7} the phone port is next"
        return [
            ChatMessage(id: "hl-0", role: "user", text: "Is the hidden-thread-block fix live yet?",
                        createdAt: "2026-11-25T01:00:00Z", kind: nil),
            answer,
            ChatMessage(id: "hl-2", role: "user", text: "Great, thanks.", createdAt: "2026-11-25T01:00:02Z", kind: nil),
            ChatMessage(id: "hl-3", role: "assistant", text: "You are welcome.", createdAt: "2026-11-25T01:00:03Z", kind: nil),
        ]
    }
}
