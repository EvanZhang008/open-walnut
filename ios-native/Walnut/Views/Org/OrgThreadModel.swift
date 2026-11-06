import Foundation

/// How an Org node's Threads read on the phone: the same rules as the web's Threads view, ported
/// from `src/core/org/thread-view.ts` (pure; pinned in `OrgThreadModelTests`).
///
/// A card shows only what he has not seen: the node's summary and the answers he has not reacted
/// to. A thread with nothing for him (new, working, pending) is out of sight behind one quiet
/// line; a snoozed one waits in its own section until its date, or earlier on news.
enum OrgThreadModel {
    /// One exchange: his message (or a few in a row the node answered at once) and the answer.
    struct Exchange: Equatable, Identifiable {
        /// 1-based number of its first message in the thread; 0 for the node's own first post.
        let n: Int
        let messages: [OrgThreadMessage]
        let answer: OrgThreadMessage.Answer?
        let opener: OrgThread.Opener?
        /// He reacted after the answer: context now, not news.
        let known: Bool
        var id: String { messages.first?.id ?? "opener" }
    }

    /// The sections of the Threads page, in the order drawn.
    struct Sections: Equatable {
        /// For him now: pinned first (newest pin on top), then newest change first.
        var open: [OrgThread] = []
        /// Put aside, soonest back first.
        var snoozed: [OrgThread] = []
        /// Open, but the node's move: nothing for him.
        var inProgress: [OrgThread] = []
        /// Closed this week.
        var closed: [OrgThread] = []
    }

    // MARK: - Exchanges

    static func exchanges(_ t: OrgThread) -> [Exchange] {
        var out: [Exchange] = []
        let knownThrough = t.known.flatMap { k in t.messages.firstIndex { $0.id == k.through } } ?? -1
        let ackedByHim = t.closed?.by == "human"
        if let o = t.opener {
            out.append(Exchange(n: 0, messages: [], answer: nil, opener: o,
                                known: ackedByHim || t.messages.contains { $0.at > o.at }))
        }
        let m = t.messages
        var n = 1
        var i = 0
        while i < m.count {
            let first = m[i]
            var j = i + 1
            while j < m.count && sameAnswer(first.answer, m[j].answer) { j += 1 }
            if let answer = first.answer {
                // A message whose reply was not found, sent before the same reply covered a later
                // one, was covered by it too.
                var k = j
                while k < m.count && m[k].answer == nil && m[k].at < answer.at {
                    if k + 1 < m.count, sameAnswer(answer, m[k + 1].answer) { j = k + 2 }
                    k += 1
                }
                while j < m.count && sameAnswer(answer, m[j].answer) { j += 1 }
            }
            let messages = Array(m[i..<j])
            let answer = first.answer
            let later = answer.map { a in m[j...].contains { $0.at > a.at } } ?? false
            out.append(Exchange(n: n, messages: messages, answer: answer, opener: nil,
                                known: answer != nil && (later || ackedByHim || knownThrough >= i)))
            n += messages.count
            i = j
        }
        return out
    }

    private static func sameAnswer(_ a: OrgThreadMessage.Answer?, _ b: OrgThreadMessage.Answer?) -> Bool {
        guard let a, let b else { return a == nil && b == nil }
        return a.at == b.at && a.text == b.text
    }

    /// The answers (and the node's first post) he has not reacted to, minus a reply shared with
    /// another thread, which reads only in the whole conversation.
    static func unread(_ t: OrgThread, shared: Set<String> = []) -> [Exchange] {
        exchanges(t).filter { x in
            (x.answer != nil || x.opener != nil) && !x.known && !x.messages.contains { shared.contains($0.id) }
        }
    }

    /// The messages whose answer is one reply that also sits under a message of another thread.
    static func sharedAnswers(_ threads: [OrgThread]) -> Set<String> {
        var byReply: [String: (threads: Set<String>, messages: [String])] = [:]
        for t in threads {
            for m in t.messages {
                guard let a = m.answer else { continue }
                let key = a.at + "\n" + a.text
                var g = byReply[key] ?? ([], [])
                g.threads.insert(t.id)
                g.messages.append(m.id)
                byReply[key] = g
            }
        }
        var out = Set<String>()
        for g in byReply.values where g.threads.count > 1 { out.formUnion(g.messages) }
        return out
    }

    // MARK: - Where a thread is drawn

    static func pinnedNow(_ t: OrgThread) -> Bool { t.pinned != nil && t.closed == nil }

    static func snoozedNow(_ t: OrgThread, now: Date) -> Bool {
        guard let s = t.snoozed, t.closed == nil, !pinnedNow(t),
              let until = WalnutTask.parseISO(s.until), until > now else { return false }
        return !newsSince(t, s.at)
    }

    private static func newsSince(_ t: OrgThread, _ at: String) -> Bool {
        t.messages.contains { $0.at > at || ($0.answer.map { $0.at > at } ?? false) }
    }

    /// His view shows it: he must decide (needs), the result is in (answered), an answer of the
    /// node's he has not reacted to is on it, or he pinned it.
    static func shownToHim(_ t: OrgThread, shared: Set<String> = [], now: Date) -> Bool {
        if t.closed != nil { return false }
        if pinnedNow(t) { return true }
        if t.state == "pending" || snoozedNow(t, now: now) { return false }
        if t.state == "needs" || t.state == "answered" { return true }
        return !unread(t, shared: shared).isEmpty
    }

    static func sections(_ threads: [OrgThread], now: Date) -> Sections {
        let shared = sharedAnswers(threads)
        var s = Sections()
        let shown = threads.filter { shownToHim($0, shared: shared, now: now) }
            .sorted { $0.updatedAt > $1.updatedAt }
        let pinned = shown.filter(pinnedNow).sorted { ($0.pinned?.at ?? "") > ($1.pinned?.at ?? "") }
        s.open = pinned + shown.filter { !pinnedNow($0) }
        s.snoozed = threads.filter { snoozedNow($0, now: now) }.sorted { ($0.snoozed?.until ?? "") < ($1.snoozed?.until ?? "") }
        s.inProgress = threads.filter { $0.closed == nil && !snoozedNow($0, now: now) && !shownToHim($0, shared: shared, now: now) }
        // Newest close first, and a closed row's time is its close (`shownAt`), so the list reads in order.
        s.closed = threads.filter { $0.closed != nil }.sorted { shownAt($0) > shownAt($1) }
        return s
    }

    /// Where a thread went after an action took it off the cards, said once at the top of the
    /// page; nil while it is still on a card.
    static func movedNotice(_ id: String, threads: [OrgThread], now: Date) -> String? {
        let s = sections(threads, now: now)
        if s.open.contains(where: { $0.id == id }) { return nil }
        if let t = s.snoozed.first(where: { $0.id == id }) {
            guard let sn = t.snoozed else { return "Snoozed" }
            // The words the snoozed row and the card use, so one moment reads one way.
            return "Snoozed until \(backAt(sn.until, now: now))"
        }
        if s.inProgress.contains(where: { $0.id == id }) { return "Moved to In progress" }
        if s.closed.contains(where: { $0.id == id }) { return "Closed. It is under Closed this week" }
        return nil
    }

    /// The time a thread's row shows: its close for a closed one, else its last message.
    static func shownAt(_ t: OrgThread) -> String {
        t.closed?.at ?? t.messages.last?.at ?? t.opener?.at ?? t.updatedAt
    }

    // MARK: - Words

    /// A thread's state as the user reads it: the task-state names where they mean the same.
    static func stateLabel(_ t: OrgThread) -> String {
        if let c = t.closed { return c.how == "acked" ? "Done" : "Dropped" }
        switch t.state {
        case "new": return "New"
        case "working": return "Working"
        case "needs": return "Needs you"
        case "answered": return "Answered"
        case "pending": return "Pending"
        default: return t.state.capitalized
        }
    }

    /// Where a thread the node opened itself came from (threads-model.ts THREAD_SOURCES).
    static func fromLabel(_ o: OrgThread.Opener) -> String {
        let base: String
        switch o.from {
        case "mail": base = "Mail"
        case "task": base = "A task"
        case "letter": base = "A letter"
        case "trigger": base = "A trigger"
        default: base = "Its own finding"
        }
        return o.ref.map { "\(base): \($0)" } ?? base
    }

    /// His words an answer replies to, one line.
    static func quote(_ x: Exchange, max: Int = 72) -> String {
        "\u{201C}" + oneLine(x.messages.map { $0.text.isEmpty ? "A picture" : $0.text }.joined(separator: " / "), max: max) + "\u{201D}"
    }

    static func oneLine(_ text: String, max: Int) -> String {
        let plain = text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        guard plain.count > max else { return plain }
        return String(plain.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "\u{2026}"
    }

    /// The opening of a long Markdown text, nil when it is short enough to show whole: whole
    /// paragraphs while they fit `budget` columns (`width`), else the first one cut at a word (never inside
    /// a tag or a link). A table keeps its header and two rows, a code block its first lines, so a
    /// folded card stays a few lines tall whatever the answer holds.
    static func preview(_ markdown: String, budget: Int) -> String? {
        let text = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        guard width(text) > budget else { return nil }
        var blocks: [[String]] = []
        var current: [String] = []
        var inFence = false
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { inFence.toggle() }
            if !inFence, trimmed.isEmpty {
                if !current.isEmpty { blocks.append(current); current = [] }
            } else {
                current.append(line)
            }
        }
        if !current.isEmpty { blocks.append(current) }
        var kept: [String] = []
        var used = 0
        for block in blocks {
            let joined = block.joined(separator: "\n")
            let w = width(joined)
            let first = block.first?.trimmingCharacters(in: .whitespaces) ?? ""
            if used + w <= budget {
                kept.append(joined)
                used += w
                continue
            }
            guard kept.isEmpty else { break }
            if first.hasPrefix("|") {
                kept.append(block.prefix(4).joined(separator: "\n"))
            } else if first.hasPrefix("```") {
                var lines = Array(block.prefix(6))
                if lines.count < 2 || !(lines.last ?? "").trimmingCharacters(in: .whitespaces).hasPrefix("```") { lines.append("```") }
                kept.append(lines.joined(separator: "\n"))
            } else {
                kept.append(cutAtWord(joined, max: budget))
            }
            break
        }
        let shown = kept.joined(separator: "\n\n")
        return shown.count < text.count ? shown : nil
    }

    /// How wide `text` reads: a CJK or full-width character takes two columns, so a budget folds
    /// Chinese and English to about the same number of lines.
    static func width(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { sum, u in
            let v = u.value
            let wide = (0x1100...0x115F).contains(v) || (0x2E80...0xA4CF).contains(v) || (0xAC00...0xD7A3).contains(v)
                || (0xF900...0xFAFF).contains(v) || (0xFE30...0xFE4F).contains(v) || (0xFF00...0xFF60).contains(v)
                || (0x20000...0x3FFFD).contains(v)
            return sum + (wide ? 2 : 1)
        }
    }

    /// `text` cut to at most `max` columns at a space, backed off before a tag or a link it
    /// would split, with an ellipsis.
    static func cutAtWord(_ text: String, max: Int) -> String {
        var head = ""
        var used = 0
        for ch in text {
            let w = width(String(ch))
            if used + w > max { break }
            head.append(ch)
            used += w
        }
        if let space = head.lastIndex(where: { $0 == " " || $0 == "\n" }), head.distance(from: head.startIndex, to: space) > head.count / 2 {
            head = String(head[..<space])
        }
        if let open = head.lastIndex(of: "<"), !head[open...].contains(">") { head = String(head[..<open]) }
        if let open = head.lastIndex(of: "["), !head[open...].contains(")") { head = String(head[..<open]) }
        // A cut right after a list item's marker leaves the marker alone on its last line
        // ("- …"): end on the item before it instead.
        var lines = head.components(separatedBy: "\n")
        while lines.count > 1, let last = lines.last, isBareListMarker(last) { lines.removeLast() }
        head = lines.joined(separator: "\n")
        return head.trimmingCharacters(in: .whitespacesAndNewlines) + "\u{2026}"
    }

    /// A line holding no words: empty, or only a list marker (`-`, `*`, `+`, `•`, `1.`, `2)`).
    static func isBareListMarker(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.isEmpty || ["-", "*", "+", "\u{2022}"].contains(t)
            || t.range(of: #"^\d+[.)]$"#, options: .regularExpression) != nil
    }

    /// The task ids a summary already names as pills (`<task-ref id="…">`), so their chips are not
    /// drawn twice.
    static func namedTasks(in text: String?) -> Set<String> {
        guard let text, let re = try? NSRegularExpression(pattern: #"<task-ref[^>]*\bid="([^"]+)""#) else { return [] }
        let ns = text as NSString
        return Set(re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) })
    }

    /// When a snoozed thread comes back, as a person says it: "today, 3:00 PM", "tomorrow, 9:00 AM".
    static func backAt(_ until: String, now: Date, calendar: Calendar = .current) -> String {
        guard let d = WalnutTask.parseISO(until) else { return until }
        let time = d.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(d, inSameDayAs: now) { return "today, \(time)" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(d, inSameDayAs: tomorrow) {
            return "tomorrow, \(time)"
        }
        return "\(d.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())), \(time)"
    }

    /// The snooze choices a card offers, as the web's picker's presets: later today, tomorrow
    /// morning, next week. Each is an absolute time the server stores.
    static func snoozeChoices(now: Date, calendar: Calendar = .current) -> [(label: String, until: Date)] {
        var out: [(String, Date)] = []
        out.append(("In 3 hours", now.addingTimeInterval(3 * 3600)))
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
           let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) {
            out.append(("Tomorrow, 9 AM", nine))
        }
        if let week = calendar.date(byAdding: .day, value: 7, to: calendar.startOfDay(for: now)),
           let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: week) {
            out.append(("Next week", nine))
        }
        return out
    }
}
