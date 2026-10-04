import Foundation

/// The collapsed tool-run line, "Ran 3 commands, read a file": the SAME words the
/// web console prints for the same calls (`web/src/components/sessions/tool-run-
/// phrase.ts`), so a turn read on the phone and on the Mac is described in one
/// voice. Pure, so a test can hold the two implementations to each other's cases.
enum TimelineToolRunPhrase {
    /// One tool call as the phrase needs it: the tool's name and the one-line
    /// `detail` the server derived from its input. For a read or an edit that
    /// detail IS the file path (`toolDetail` in core/tool-summary.ts), which is
    /// what lets the phrase count FILES rather than calls.
    struct Member: Equatable {
        let name: String
        let detail: String?
    }

    /// Phrase category per tool name; unknown tools fall into `other`.
    private enum Category: Hashable {
        case command, read, edit, search, fetch, skill, todo, subagent, other

        init(name: String) {
            switch name {
            case "Bash", "BashOutput", "KillShell": self = .command
            case "Read": self = .read
            case "Edit", "Write", "NotebookEdit", "MultiEdit": self = .edit
            case "Grep", "Glob", "WebSearch": self = .search
            case "WebFetch": self = .fetch
            case "Skill": self = .skill
            case "TodoWrite", "TaskCreate", "TaskUpdate": self = .todo
            // The web keeps a delegation OUT of its runs (it has a card of its
            // own for them); the phone folds everything, so it needs a word.
            case "Task", "Agent": self = .subagent
            default: self = .other
            }
        }

        /// Reads and edits count distinct files, not calls (six edits to one
        /// file read "edited a file", never "edited 6 files").
        var countsFiles: Bool { self == .read || self == .edit }

        func phrase(_ n: Int) -> String {
            switch self {
            case .command: return n == 1 ? "ran a command" : "ran \(n) commands"
            case .read: return n == 1 ? "read a file" : "read \(n) files"
            case .edit: return n == 1 ? "edited a file" : "edited \(n) files"
            case .search: return n == 1 ? "searched files" : "ran \(n) searches"
            case .fetch: return n == 1 ? "fetched a page" : "fetched \(n) pages"
            case .skill: return n == 1 ? "launched a skill" : "launched \(n) skills"
            case .todo: return "updated tasks"
            case .subagent: return n == 1 ? "ran a subagent" : "ran \(n) subagents"
            case .other: return n == 1 ? "used a tool" : "used \(n) tools"
            }
        }
    }

    /// "Ran 3 commands, read a file": categories in first-appearance order, the
    /// first letter capitalised. A read or edit whose path is not known counts as
    /// its own file. Empty input yields an empty phrase.
    static func phrase(_ members: [Member]) -> String {
        var order: [Category] = []
        var counts: [Category: Int] = [:]
        var files: [Category: Set<String>] = [:]
        for member in members {
            let category = Category(name: member.name)
            if category.countsFiles, let path = member.detail, !path.isEmpty {
                if files[category, default: []].contains(path) { continue }
                files[category, default: []].insert(path)
            }
            if counts[category] == nil { order.append(category) }
            counts[category, default: 0] += 1
        }
        let phrase = order.map { $0.phrase(counts[$0] ?? 0) }.joined(separator: ", ")
        guard let first = phrase.first else { return "" }
        return first.uppercased() + phrase.dropFirst()
    }
}

/// The cross-message fold the web console's session timeline does
/// (`SessionChatHistory` historyParts): consecutive tool and thinking rows become
/// ONE run, drawn as a muted "Ran 3 commands ›" line that opens to its members.
///
/// WHY A FOLD AND NOT A ROW PER CALL (2026-10-03 report): a turn that ran twelve
/// commands was twelve capsules tall on the phone, and the reply the reader
/// actually wanted sat under all of them. The reader does not care how many
/// commands ran; the line says so in a few words, and the calls are one tap away.
///
/// Pure, over the message list the stores already hold, so the rule is testable
/// without the layout actor and identical on both surfaces (the Personal AI chat
/// and a session's transcript both build through it).
enum TimelineToolRunFold {
    /// One stretch of the timeline after folding.
    enum Part: Equatable {
        /// A message drawn as itself (prose, a user bubble, a notification, a
        /// call the web keeps out of runs, and a stretch of reasoning with no tool
        /// call in it).
        case message(ChatMessage)
        /// Consecutive tool and thinking rows with at least one tool among them.
        /// `members` keep their order; `key` names the run (see `runKey`).
        case run(key: String, members: [ChatMessage])
    }

    /// Does this message ride a run? Tool and thinking rows do; anything else
    /// (prose, user bubbles, notifications) closes the run it follows, and so
    /// does a call the web console keeps out of its runs.
    static func isRunMember(_ message: ChatMessage) -> Bool {
        guard !message.isUser else { return false }
        if message.kind == .thinking { return true }
        guard message.kind == .tool else { return false }
        return !staysOutOfRuns(name: message.text, detail: message.detail,
                               inputPreview: message.inputPreview)
    }

    /// The calls the web console never folds (`isMergeableHistoryTool`): leaving
    /// plan mode, writing the plan file, and a message to another session. That
    /// last one is conversation, not plumbing; folded into "Ran a command" it
    /// would vanish from the timeline the way an incoming message never does.
    static func staysOutOfRuns(name: String, detail: String?, inputPreview: String?) -> Bool {
        if name == "ExitPlanMode" { return true }
        if name == "Write", let path = detail, path.contains(".claude/plans/") { return true }
        if name.hasPrefix("mcp__"), sendOps.contains(where: { name.hasSuffix("__\($0)") }) { return true }
        if name == "Bash" { return isCliSessionSend(inputPreview) }
        return false
    }

    /// The ops that message another session: `task_send`, and `session_send`, its
    /// older name (the only one the web's detector knows today).
    private static let sendOps = ["task_send", "session_send"]

    /// `walnut tools call task_send …` at a command position of a Bash call, read
    /// off the relayed input render (`command: …`). A cheap form of the web's
    /// tokenizer (`findCliSend`): a quoted mention or `--help` sends nothing.
    private static func isCliSessionSend(_ inputPreview: String?) -> Bool {
        guard let inputPreview, inputPreview.contains("_send"),
              let line = inputPreview.split(separator: "\n", omittingEmptySubsequences: true)
                .first(where: { $0.hasPrefix("command: ") }) else { return false }
        let words = line.dropFirst("command: ".count)
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
        var atHead = true
        for (i, word) in words.enumerated() {
            if word.allSatisfy({ ";|&(){}".contains($0) }) { atHead = true; continue }
            let binary = word.split(separator: "/").last ?? word
            if atHead, binary == "walnut" || binary == "open-walnut", i + 3 < words.count,
               words[i + 1] == "tools", words[i + 2] == "call", sendOps.contains(String(words[i + 3])) {
                let arg = i + 4 < words.count ? words[i + 4] : ""
                return arg != "--help" && arg != "-h"
            }
            atHead = word.contains("=") && !word.hasPrefix("-")
                || ["env", "exec", "sudo", "time", "nice", "command", "builtin"].contains(String(word))
        }
        return false
    }

    static func fold(_ messages: [ChatMessage]) -> [Part] {
        var parts: [Part] = []
        var run: [ChatMessage] = []
        var keyCounts: [String: Int] = [:]
        func emit(_ members: ArraySlice<ChatMessage>) {
            guard let first = members.first else { return }
            // A stretch with a tool in it is a run; reasoning alone is drawn as
            // the rows it already was (a run with an empty phrase would be a lie).
            guard members.contains(where: { $0.kind == .tool }) else {
                parts.append(contentsOf: members.map { .message($0) })
                return
            }
            let base = runKey(first)
            let n = keyCounts[base, default: 0]
            keyCounts[base] = n + 1
            parts.append(.run(key: "\(base)#\(n)", members: Array(members)))
        }
        func flush(ended: Bool) {
            guard !run.isEmpty else { return }
            // Reasoning at the END of a run that a visible message follows led to
            // THAT message, not to the tools before it: it splits off as the
            // "Thinking ›" row above the prose (the web's trailingThinkingStart).
            // At the tail of the list it stays with the run, which the live
            // stream continues.
            var split = run.count
            if ended {
                while split > 0, run[split - 1].kind == .thinking { split -= 1 }
            }
            emit(run[..<split])
            emit(run[split...])
            run.removeAll()
        }
        for message in messages {
            if isRunMember(message) {
                run.append(message)
            } else {
                flush(ended: true)
                parts.append(.message(message))
            }
        }
        flush(ended: false)
        return parts
    }

    /// What names a run: where its FIRST member sits (role, time, kind, and a
    /// tool's name), never what it carries. A session row's id hashes its payload,
    /// so it moves when a cached slim read is replaced by the rich one or the
    /// first call's result lands; a run named by that id snapped shut under the
    /// reader who had just opened it. An occurrence count, assigned in timeline
    /// order, tells apart runs that start at the same place.
    private static func runKey(_ first: ChatMessage) -> String {
        let name = first.kind == .tool ? first.text : ""
        return "\(first.role)|\(first.createdAt)|\(first.kind?.rawValue ?? "")|\(name)"
    }

    /// The members of a run as the phrase wants them.
    static func phraseMembers(_ members: [ChatMessage]) -> [TimelineToolRunPhrase.Member] {
        members.filter { $0.kind == .tool }
            .map { TimelineToolRunPhrase.Member(name: $0.text, detail: $0.detail) }
    }

    /// How many of a run's calls came back as errors (the "N failed" badge).
    static func failCount(_ members: [ChatMessage]) -> Int {
        members.filter { $0.kind == .tool && $0.isError == true }.count
    }

    /// The run row's id: its key in the conversation's namespace plus a suffix no
    /// member row uses. Stable while the run grows at the tail of a live turn and
    /// while its rows are re-read, which is what keeps a run the reader opened
    /// open; and it is the id `expandedRowIDs` remembers.
    static func rowID(scope: String, key: String) -> String {
        "\(TimelineScope.namespace(scope, key))#run"
    }
}
