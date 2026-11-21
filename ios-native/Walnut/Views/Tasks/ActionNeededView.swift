import SwiftUI

/// Action needed under a task's row, the phone's copy of the web's block (web
/// components/actions/ActionNeeded.tsx, server core/action-needed.ts): one line per thing the task
/// asks of the user, its kind and what it asks, its answer right there, and its own Snooze.
///
/// Each kind is answered the way the phone already answers it (`ActionNeededModel.answer`): an
/// approval in its sheet (one tap), a letter's actions, a one-question
/// prompt's options; the rest open the task's session, where its own card answers it.
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

struct ActionNeededView: View {
    let task: WalnutTask
    let items: [WalnutActionItem]
    var onOpenSession: () -> Void = {}

    /// Answered or snoozed from here before the server's next status: kept off or marked here.
    @State private var sent = Set<String>()
    @State private var snoozed: [String: Date?] = [:]
    @State private var error: String?

    var body: some View {
        let shown = items.filter { !sent.contains($0.id) }
        if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Action needed")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                ForEach(shown) { item in line(item) }
                if let error {
                    Text(error).font(.caption2).foregroundStyle(Theme.decideText)
                }
            }
            .padding(8)
            .background(Theme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("board.row.actions.\(task.id)")
        }
    }

    private func until(_ item: WalnutActionItem) -> Date? {
        // A snooze set here reads at once; one that ran out reads as none, wherever it was set.
        let at: Date? = snoozed[item.id] ?? ActionNeededModel.date(item.snoozedUntil)
        return at.flatMap { $0 > Date() ? $0 : nil }
    }

    @ViewBuilder
    private func line(_ item: WalnutActionItem) -> some View {
        let later = until(item)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(ActionNeededModel.label(item.kind).uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(later == nil ? Theme.warning : .secondary)
                // The agent's own words: markdown and file links as everywhere else (LetterAgentTextTests).
                Text(MarkdownParser.inline(item.summary))
                    .font(.caption)
                    .foregroundStyle(later == nil ? .primary : .secondary)
                    .lineLimit(2)
                    .handlingFilePathLinks(task: task, field: .needs)
                Spacer(minLength: 0)
            }
            if let later {
                HStack(spacing: 8) {
                    Text("Snoozed until \(later.formatted(date: .abbreviated, time: .shortened))\(item.blocking == true ? " · its session waits on it" : "")")
                        .font(.caption2).foregroundStyle(.secondary)
                    Button("Unsnooze") { Task { await snooze(item, nil) } }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.warning)
                        .font(.caption2)
                        .accessibilityIdentifier("action.unsnooze.\(item.id)")
                }
            } else {
                HStack(spacing: 6) {
                    answer(item)
                    Menu {
                        ForEach(ActionNeededModel.presets(), id: \.id) { p in
                            Button(p.label) { Task { await snooze(item, p.until) } }
                        }
                    } label: {
                        Text("Snooze").font(.caption)
                    }
                    .accessibilityIdentifier("action.snooze.\(item.id)")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("action.item.\(item.kind).\(item.id)")
    }

    @ViewBuilder
    private func answer(_ item: WalnutActionItem) -> some View {
        switch ActionNeededModel.answer(item) {
        case .approvalSheet:
            Button("Review") { Task { await ApprovalCenter.shared.open(id: item.id) } }
                .buttonStyle(.borderedProminent).controlSize(.mini)
        case .letterOptions:
            ForEach(item.options ?? []) { o in
                Button(o.label) { Task { await answerLetter(item, o) } }
                    .buttonStyle(.bordered).controlSize(.mini)
            }
        case .promptOptions:
            ForEach(item.options ?? []) { o in
                Button(o.label) { Task { await answerQuestion(item, o) } }
                    .buttonStyle(.bordered).controlSize(.mini)
            }
        case .openSession:
            Button("Open") { onOpenSession() }
                .buttonStyle(.bordered).controlSize(.mini)
        }
    }

    private func answerLetter(_ item: WalnutActionItem, _ o: WalnutAskOption) async {
        sent.insert(item.id)
        do {
            _ = try await WalnutAPI().answerLetter(id: item.id, actionId: o.id, freeText: nil)
            AppLog.info("action-needed", "letter answered", ["taskId": task.id, "letterId": item.id, "actionId": o.id])
        } catch {
            sent.remove(item.id)
            self.error = "Not sent. Try again."
        }
    }

    private func answerQuestion(_ item: WalnutActionItem, _ o: WalnutAskOption) async {
        guard let sid = item.sessionId, let question = item.question else { onOpenSession(); return }
        sent.insert(item.id)
        do {
            // The question's own words are its answer's key, as the session card sends them.
            _ = try await WalnutAPI().respondSessionPermission(id: sid, requestId: item.id, allow: true, answers: [question: o.label])
            AppLog.info("action-needed", "question answered", ["taskId": task.id, "requestId": item.id])
        } catch {
            sent.remove(item.id)
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
