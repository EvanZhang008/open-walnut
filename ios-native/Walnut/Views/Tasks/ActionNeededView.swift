import SwiftUI

/// Action needed under a task's row, the phone's copy of the web's block (web
/// components/actions/ActionNeeded.tsx, server core/action-needed.ts): one line per thing the task
/// asks of the user, its kind and what it asks, its answer right there, and its own Snooze.
///
/// Each kind is answered the way the phone already answers it (`ActionNeededModel.answer`): an
/// approval in its sheet (one tap), a letter's actions, a one-question
/// prompt's options; the rest open the task's session, where its own card answers it.
///
/// Each item also takes the user's words in its own box, always shown (`ReplyBox`, the web's
/// ask card): `@` names a task or a session, `/` lists the asking session's commands, pictures
/// go with the words. What the words do per kind is `ActionNeededModel.words`.
/// tests/core/action-needed-ratchet.test.ts reads `ActionNeededModel.answer` for every kind.
enum ActionNeededModel {
    enum Answer: Equatable { case approvalSheet, letterOptions, promptOptions, openSession }

    /// How a kind is answered on the phone's row.
    static func answer(_ item: WalnutActionItem) -> Answer {
        switch item.kind {
        case "approval": return .approvalSheet
        case "letter": return (item.options ?? []).isEmpty ? .openSession : .letterOptions
        case "question": return (item.options ?? []).isEmpty || item.multi == true || item.question == nil ? .openSession : .promptOptions
        case "permission", "choice", "ask": return .openSession
        default: return .openSession
        }
    }

    /// The status's own Needs you line is one of its items (the block says it); a failure or a
    /// person's own mark is no item, so its line stays (server action-needed.ts ownLineIsItem).
    static func ownLineIsItem(_ s: WalnutUserStatus?) -> Bool {
        guard let s, s.state == "needs", let source = s.source else { return false }
        let kinds: [String: [String]] = [
            "prompt": ["question", "permission"], "letter": ["letter"], "choice": ["choice"],
            "session": ["ask"], "approval": ["approval"],
        ]
        guard let mine = kinds[source] else { return false }
        return (s.actions ?? []).contains { mine.contains($0.kind) }
    }

    static func label(_ kind: String) -> String {
        switch kind {
        case "approval": return "Approval"
        case "question": return "Question"
        case "permission": return "Permission"
        case "letter": return "Letter"
        case "choice": return "Choice"
        case "ask": return "Ask"
        default: return "Action"
        }
    }

    /// How an item's words box answers it (the web's OrgInlineAnswer, one rule per kind).
    enum Words: Equatable {
        /// A reply to the letter: it answers the letter as a pick does.
        case letterReply
        /// A message to its session; the approval still waits for Approve or Deny.
        case approvalNote
        /// The tool step is declined with the words (what to do instead).
        case declineStep
        /// The one question's answer, in the user's words.
        case questionAnswer
        /// A message to its session: `Answer to "<summary>": <words>`.
        case sessionAnswer
        /// No box: the item is answered in its session (a prompt of several questions).
        case none
    }

    static func words(_ item: WalnutActionItem, hasSession: Bool) -> Words {
        switch item.kind {
        case "letter": return .letterReply
        case "approval": return hasSession ? .approvalNote : .none
        case "permission": return hasSession ? .declineStep : .none
        case "question": return hasSession && item.question != nil ? .questionAnswer : .none
        default: return hasSession ? .sessionAnswer : .none
        }
    }

    static func placeholder(_ words: Words) -> String {
        switch words {
        case .letterReply: return "Reply…"
        case .approvalNote: return "Tell it something (Approve still needed)"
        case .declineStep: return "Tell it what to do instead"
        case .questionAnswer: return "Your answer"
        case .sessionAnswer, .none: return "Reply…"
        }
    }

    /// The message a session gets for words that answer `summary` (server askAnswerText).
    static func answerMessage(summary: String, words: String) -> String {
        "Answer to \"\(summary)\": \(words)"
    }

    static func approvalMessage(summary: String, words: String) -> String {
        "About the approval \"\(summary)\": \(words)"
    }

    /// Whether the box lists the session's `/` commands: only where its words reach the
    /// session as a message of their own (`sessionMessage`). A declined step's words and a
    /// question's answer are tool answers, where a command never runs.
    static func takesCommands(_ words: Words) -> Bool {
        switch words {
        case .approvalNote, .sessionAnswer, .letterReply: return true
        case .declineStep, .questionAnswer, .none: return false
        }
    }

    /// The message a session gets for an approval note or an answer. Words that start with a
    /// `/` command go as they are: the session runs a command only at the start of a message,
    /// so the `Answer to "..."` wrapper would turn it into plain text.
    static func sessionMessage(_ words: Words, summary: String, text: String) -> String {
        if text.hasPrefix("/") { return text }
        return words == .approvalNote
            ? approvalMessage(summary: summary, words: text)
            : answerMessage(summary: summary, words: text)
    }

    /// The snooze presets, the web's "In 1 hour" first.
    static func presets(now: Date = Date(), calendar: Calendar = .current) -> [(id: String, label: String, until: Date)] {
        let nine = { (d: Date) in calendar.date(bySettingHour: 9, minute: 0, second: 0, of: d) ?? d }
        let tomorrow = nine(calendar.date(byAdding: .day, value: 1, to: now) ?? now)
        let weekday = calendar.component(.weekday, from: now) // 1 = Sunday
        let toMonday = ((9 - weekday) % 7 == 0) ? 7 : (9 - weekday) % 7
        let monday = nine(calendar.date(byAdding: .day, value: toMonday, to: now) ?? now)
        return [
            ("one-hour", "In 1 hour", now.addingTimeInterval(3600)),
            ("three-hours", "In 3 hours", now.addingTimeInterval(3 * 3600)),
            ("tomorrow", "Tomorrow 9:00", tomorrow),
            ("next-week", "Next week", monday),
        ]
    }

    /// One ask answered from here: the item as it was, what was said, its place among the pages,
    /// and the asks shown with it (it stays only beside one of them; a later ask starts afresh).
    struct Answered: Equatable {
        var item: WalnutActionItem
        var said: String?
        var index: Int
        var peers: [String]
    }

    /// The pages (the web's ask-pages.ts pagesOf): the task's asks in their order, one shown at a
    /// time, with the ones answered here kept at their place while an ask shown with them is open.
    static func pages(_ items: [WalnutActionItem], answered: [String: Answered]) -> [WalnutActionItem] {
        let open = Set(items.map(\.id))
        var pages = items
        let gone = answered.values
            .filter { a in !open.contains(a.item.id) && a.peers.contains { open.contains($0) } }
            .sorted { $0.index < $1.index }
        // After the last page that came before it when it was answered (the web's rule).
        for a in gone {
            let before = Set(a.peers.prefix(max(a.index, 0)))
            let at = (pages.lastIndex { before.contains($0.id) }).map { $0 + 1 } ?? 0
            pages.insert(a.item, at: at)
        }
        return pages
    }

    /// The marks that still hold (the web's liveMarks): a mark whose id is asked again with other
    /// words is dropped, so a reworded ask reads open.
    static func liveMarks(_ items: [WalnutActionItem], answered: [String: Answered]) -> [String: Answered] {
        let byId = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return answered.filter { entry in
            guard let now = byId[entry.key] else { return true }
            return now.summary == entry.value.item.summary
        }
    }

    /// The page to show (pageIndex): the kept one, else the one now at its place, never past the end.
    static func pageIndex(_ ids: [String], at: (id: String, index: Int)?) -> Int {
        guard !ids.isEmpty, let at else { return 0 }
        if let i = ids.firstIndex(of: at.id) { return i }
        return min(max(at.index, 0), ids.count - 1)
    }

    /// The words a screen reader hears for the page shown.
    static func placeText(_ index: Int, of count: Int) -> String { "Decision \(index + 1) of \(count)" }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

private struct SnoozeBody: Encodable { let until: String? }
private struct SnoozeAnswer: Decodable { let task_id: String? }

/// The card (2026-11-20, the user, of the ten designs: "I mean 1 is good let's do it", the web's
/// ask-card.css): the frosted material, 18pt continuous corners with a hairline and a white top
/// edge, the only colour a 7pt orange dot for "needs you" and the links; quiet grey keys, Snooze as
/// quiet text with a clock at the right. One ask at a time ("max shoudl 1 decision, and can left and
/// right"): each ask is its own page with its own words, options and box, "‹ 1/3 ›" beside Snooze
/// pages through them, and an answered page stays, marked with what was said.
struct ActionNeededView: View {
    let task: WalnutTask
    let items: [WalnutActionItem]
    var onOpenSession: () -> Void = {}

    @Environment(TasksStore.self) private var store: TasksStore?
    @Environment(\.colorScheme) private var scheme

    /// Answered from here: kept, marked with what was said, until no open ask is left.
    @State private var answered: [String: ActionNeededModel.Answered] = [:]
    /// The page shown: its ask, and its place (a page that left gives its place to the next).
    @State private var at: (id: String, index: Int)?
    @State private var snoozed: [String: Date?] = [:]
    @State private var error: String?
    /// A line under an item its words reached without answering it (an approval's note).
    @State private var notes: [String: String] = [:]
    /// One id per letter reply until it is taken, so a retry after a lost answer is the same reply.
    @State private var replyIDs: [String: String] = [:]

    private static let corner: CGFloat = 18

    /// The marks that still hold: the same id asked again with new words is a new, open ask.
    private var marks: [String: ActionNeededModel.Answered] { ActionNeededModel.liveMarks(items, answered: answered) }
    private var pages: [WalnutActionItem] { ActionNeededModel.pages(items, answered: marks) }

    var body: some View {
        let pages = self.pages
        let index = ActionNeededModel.pageIndex(pages.map(\.id), at: at)
        let marks = self.marks
        if pages.contains(where: { marks[$0.id] == nil }) {
            let item = pages[index]
            VStack(alignment: .leading, spacing: 8) {
                line(item, index: index, count: pages.count)
                if let error {
                    Text(error).font(.caption2).foregroundStyle(Theme.decideText)
                }
            }
            .padding(EdgeInsets(top: 12, leading: 12, bottom: 8, trailing: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
            .overlay {
                // A hairline all round, and the white top edge of the notices' glass.
                RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                    .strokeBorder(Color.primary.opacity(scheme == .dark ? 0.16 : 0.1), lineWidth: 0.5)
                RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                    .strokeBorder(LinearGradient(colors: [.white.opacity(scheme == .dark ? 0.14 : 0.8), .clear], startPoint: .top, endPoint: .center), lineWidth: 1)
                    .blendMode(.plusLighter)
            }
            .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
            // Paged by its two arrows only for now. A sideways swipe (the web's) waits until it is
            // proven on the simulator not to set off the row's own swipe actions (a full swipe right
            // marks the task Done, BoardRowGestures) or the Tasks drawer's leftward close.
            .accessibilityElement(children: .contain)
            .accessibilityLabel(pages.count > 1 ? ActionNeededModel.placeText(index, of: pages.count) : "Action needed")
            .accessibilityIdentifier("board.row.actions.\(task.id)")
        }
    }

    /// One page on (+1) or back (-1), said to a screen reader.
    private func go(_ delta: Int, pages: [WalnutActionItem], from index: Int) {
        let to = min(max(index + delta, 0), pages.count - 1)
        guard to != index else { return }
        at = (pages[to].id, to)
        AccessibilityNotification.Announcement(ActionNeededModel.placeText(to, of: pages.count)).post()
    }

    /// Answered from here: its page stays, marked with what was said.
    private func markAnswered(_ item: WalnutActionItem, said: String?) {
        let pages = self.pages
        let i = pages.firstIndex { $0.id == item.id } ?? 0
        let words = said?.trimmingCharacters(in: .whitespacesAndNewlines)
        answered[item.id] = .init(item: item, said: (words?.isEmpty ?? true) ? nil : words, index: i,
                                  peers: pages.map(\.id).filter { $0 != item.id })
        at = (item.id, i)
    }

    /// Its send failed: open again, and shown.
    private func reopen(_ item: WalnutActionItem) {
        let i = pages.firstIndex { $0.id == item.id } ?? 0
        answered.removeValue(forKey: item.id)
        at = (item.id, i)
    }

    private func until(_ item: WalnutActionItem) -> Date? {
        // A snooze set here reads at once; one that ran out reads as none, wherever it was set.
        let at: Date? = snoozed[item.id] ?? ActionNeededModel.date(item.snoozedUntil)
        return at.flatMap { $0 > Date() ? $0 : nil }
    }

    @ViewBuilder
    private func line(_ item: WalnutActionItem, index: Int, count: Int) -> some View {
        let later = until(item)
        let done = marks[item.id]
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                // "Needs you": the card's one colour. Grey while put aside, a ring once answered.
                Circle()
                    .fill(done != nil ? Color.clear : later == nil ? Theme.warning : Color.secondary)
                    .overlay { if done != nil { Circle().strokeBorder(Color.secondary, lineWidth: 1.2) } }
                    .frame(width: 7, height: 7)
                    .padding(.top, 6)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ActionNeededModel.label(item.kind))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    // The agent's own words: markdown and file links as everywhere else (LetterAgentTextTests).
                    Text(MarkdownParser.inline(item.summary))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(later == nil && done == nil ? .primary : .secondary)
                        .lineLimit(3)
                        .handlingFilePathLinks(task: task, field: .needs)
                }
                Spacer(minLength: 0)
            }
            if let done {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "checkmark").font(.caption.weight(.semibold))
                    if let said = done.said {
                        Text("Answered: ").foregroundStyle(.secondary) + Text(said).foregroundStyle(.primary)
                    } else {
                        Text("Answered")
                    }
                    Spacer(minLength: 0)
                    pager(index: index, count: count)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("action.answered.\(item.id)")
            } else if let later {
                HStack(spacing: 8) {
                    Text("Snoozed until \(later.formatted(date: .abbreviated, time: .shortened))\(item.blocking == true ? " · its session waits on it" : "")")
                        .font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    pager(index: index, count: count)
                    Button {
                        Task { await snooze(item, nil) }
                    } label: {
                        Label("Unsnooze", systemImage: "clock").font(.footnote)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("action.unsnooze.\(item.id)")
                }
            } else {
                wordsBox(item)
                // Its keys on the left, the pager and Snooze on the right; on a narrow row the keys
                // take a line of their own, and stack when even that is too narrow.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        answer(item)
                        Spacer(minLength: 0)
                        tools(item, index: index, count: count)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) { answer(item) }
                        HStack(spacing: 8) { Spacer(minLength: 0); tools(item, index: index, count: count) }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        VStack(alignment: .leading, spacing: 6) { answer(item) }
                        HStack(spacing: 8) { Spacer(minLength: 0); tools(item, index: index, count: count) }
                    }
                }
                if let note = notes[item.id] {
                    Text(note).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("action.note.\(item.id)")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("action.item.\(item.kind).\(item.id)")
    }

    /// The pager and Snooze, at the right of the card's last line.
    @ViewBuilder
    private func tools(_ item: WalnutActionItem, index: Int, count: Int) -> some View {
        pager(index: index, count: count)
        Menu {
            ForEach(ActionNeededModel.presets(), id: \.id) { p in
                Button(p.label) { Task { await snooze(item, p.until) } }
            }
        } label: {
            Label("Snooze", systemImage: "clock").font(.footnote)
        }
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("action.snooze.\(item.id)")
    }

    /// "‹ 1/3 ›" beside Snooze, when the task asks more than one thing.
    @ViewBuilder
    private func pager(index: Int, count: Int) -> some View {
        if count > 1 {
            let pages = self.pages
            HStack(spacing: 0) {
                Button { go(-1, pages: pages, from: index) } label: {
                    Image(systemName: "chevron.left").frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .disabled(index == 0)
                .accessibilityLabel("Previous decision")
                .accessibilityIdentifier("action.page.prev.\(task.id)")
                Text("\(index + 1)/\(count)")
                    .font(.caption.monospacedDigit())
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("action.page.at.\(task.id)")
                Button { go(1, pages: pages, from: index) } label: {
                    Image(systemName: "chevron.right").frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .disabled(index >= count - 1)
                .accessibilityLabel("Next decision")
                .accessibilityIdentifier("action.page.next.\(task.id)")
            }
            .buttonStyle(.plain)
            .font(.footnote.weight(.medium))
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func answer(_ item: WalnutActionItem) -> some View {
        switch ActionNeededModel.answer(item) {
        case .approvalSheet:
            Button("Review") { Task { await ApprovalCenter.shared.open(id: item.id) } }
                .buttonStyle(AskChipStyle())
        case .letterOptions:
            ForEach(item.options ?? []) { o in
                Button(o.label) { Task { await answerLetter(item, o) } }
                    .buttonStyle(AskChipStyle())
            }
        case .promptOptions:
            ForEach(item.options ?? []) { o in
                Button(o.label) { Task { await answerQuestion(item, o) } }
                    .buttonStyle(AskChipStyle())
            }
        case .openSession:
            Button("Open") { onOpenSession() }
                .buttonStyle(AskChipStyle())
        }
    }

    /// The session the item asks from: its own, else the task's newest.
    private func sessionID(_ item: WalnutActionItem) -> String? {
        if let sid = item.sessionId, !sid.isEmpty { return sid }
        return store?.sessions.filter { $0.taskId == task.id }.max { $0.lastActiveAt < $1.lastActiveAt }?.id
    }

    /// The words box, always shown (the web's ask card): `@` names a task or session, `/` lists
    /// the asking session's commands, pictures go with the words where the answer takes them.
    @ViewBuilder
    private func wordsBox(_ item: WalnutActionItem) -> some View {
        let sid = sessionID(item)
        let words = ActionNeededModel.words(item, hasSession: sid != nil)
        if words != .none {
            let session = sid.flatMap { id in store?.sessions.first { $0.id == id } }
            ReplyBox(
                placeholder: ActionNeededModel.placeholder(words),
                draftKey: "ask-reply:\(task.id):\(item.id)",
                idPrefix: "action.reply.\(item.id)",
                scope: .init(selfTaskId: task.id, commands: sid != nil && ActionNeededModel.takesCommands(words),
                             commandsCwd: session?.cwd, commandsHost: session?.host),
                acceptsPictures: true,
                // Walnut's mic beside the words, as on every box he answers in.
                voiceBox: "ask-reply",
                // A failed send says so in its own box, which keeps the words and pictures.
                failureNote: "Not sent. Your words are still here. Try again.",
                // A board row is a `List` cell: the list opens in the row, under the field.
                listOpensBelow: true
            ) { text, images in
                await sendWords(item, words: words, sessionID: sid, text: text, images: images)
            }
        }
    }

    /// Answer an item in words. True once the server took them; false keeps them in the box.
    private func sendWords(_ item: WalnutActionItem, words: ActionNeededModel.Words, sessionID sid: String?,
                           text: String, images: [SelectedImage]) async -> Bool {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "Add a few words to go with the picture."
            return false
        }
        var payloads: [ImagePayload] = []
        if !images.isEmpty { payloads = await SelectedImage.buildPayloads(images.map(\.jpegData)) }
        let api = WalnutAPI()
        error = nil
        do {
            switch words {
            case .none:
                return false
            case .letterReply:
                let clientId = replyIDs[item.id] ?? UUID().uuidString
                replyIDs[item.id] = clientId
                _ = try await api.replyToLetter(id: item.id, text: text, clientId: clientId, images: payloads)
                replyIDs[item.id] = nil
                markAnswered(item, said: text)
            case .approvalNote:
                guard let sid else { return false }
                _ = try await api.sendSessionMessage(id: sid, text: ActionNeededModel.sessionMessage(words, summary: item.summary, text: text), images: payloads)
                notes[item.id] = "Sent to its session. The approval still waits for Approve or Deny."
            case .declineStep:
                guard let sid else { return false }
                _ = try await api.respondSessionPermission(id: sid, requestId: item.id, allow: false, message: text, images: payloads)
                markAnswered(item, said: text)
            case .questionAnswer:
                guard let sid, let question = item.question else { return false }
                _ = try await api.respondSessionPermission(id: sid, requestId: item.id, allow: true, answers: [question: text], images: payloads)
                markAnswered(item, said: text)
            case .sessionAnswer:
                guard let sid else { return false }
                _ = try await api.sendSessionMessage(id: sid, text: ActionNeededModel.sessionMessage(words, summary: item.summary, text: text), images: payloads)
                markAnswered(item, said: text)
            }
            AppLog.info("action-needed", "answered in words", [
                "taskId": task.id, "itemId": item.id, "kind": item.kind, "images": String(images.count),
            ])
            return true
        } catch {
            // The box says it under its words (`failureNote`); the block's line is for the rest.
            AppLog.warn("action-needed", "words not sent", ["taskId": task.id, "itemId": item.id, "error": String(describing: error)])
            return false
        }
    }

    private func answerLetter(_ item: WalnutActionItem, _ o: WalnutAskOption) async {
        markAnswered(item, said: o.label)
        do {
            _ = try await WalnutAPI().answerLetter(id: item.id, actionId: o.id, freeText: nil)
            AppLog.info("action-needed", "letter answered", ["taskId": task.id, "letterId": item.id, "actionId": o.id])
        } catch {
            reopen(item)
            self.error = "Not sent. Try again."
        }
    }

    private func answerQuestion(_ item: WalnutActionItem, _ o: WalnutAskOption) async {
        guard let sid = item.sessionId, let question = item.question else { onOpenSession(); return }
        markAnswered(item, said: o.label)
        do {
            // The question's own words are its answer's key, as the session card sends them.
            _ = try await WalnutAPI().respondSessionPermission(id: sid, requestId: item.id, allow: true, answers: [question: o.label])
            AppLog.info("action-needed", "question answered", ["taskId": task.id, "requestId": item.id])
        } catch {
            reopen(item)
            self.error = "Not sent. Try again."
        }
    }

    private func snooze(_ item: WalnutActionItem, _ at: Date?) async {
        let before = snoozed[item.id]
        snoozed[item.id] = .some(at)
        do {
            let body = SnoozeBody(until: at.map { ActionNeededModel.iso.string(from: $0) })
            let path = "/tasks/\(WalnutAPI().escape(task.id))/actions/\(WalnutAPI().escape(item.id))/snooze"
            let _: SnoozeAnswer = try await WalnutAPI().send("PUT", path, body: body)
            AppLog.info("action-needed", at == nil ? "item unsnoozed" : "item snoozed", ["taskId": task.id, "itemId": item.id])
            // A snoozed approval's sheet does not open by itself when the app comes forward.
            if at != nil, item.kind == "approval" { ApprovalCenter.shared.snoozed(id: item.id) }
        } catch {
            if let before { snoozed[item.id] = before } else { snoozed.removeValue(forKey: item.id) }
            self.error = "\(at == nil ? "Unsnooze" : "Snooze") failed. Try again."
        }
    }
}

/// The card's choices: quiet grey keys with 8pt corners (the web's ask-card.css).
struct AskChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.footnote)
            .foregroundStyle(.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(Color(uiColor: configuration.isPressed ? .secondarySystemFill : .tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
