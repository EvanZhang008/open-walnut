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
        /// Watching: the ones he watches, oldest watch first; each is in its own section too.
        var watching: [OrgThread] = []
        /// For him now: newest change first.
        var open: [OrgThread] = []
        /// Put aside, soonest back first (under Waiting / Snoozed).
        var snoozed: [OrgThread] = []
        /// Working: open, the node's move (new, working), or work on it still runs since his Acknowledge.
        var working: [OrgThread] = []
        /// Waiting / Snoozed, not snoozed: on someone or something or a time (pending, a result he read, placed in Waiting after his Acknowledge).
        var waiting: [OrgThread] = []
        /// Acknowledged: he acknowledged it and the AI is deciding where it goes (at most 10 minutes).
        var known: [OrgThread] = []
        /// Closed less than a day ago (`archiveAfter`).
        var closed: [OrgThread] = []
        /// Closed a day ago or more: put away until he opens them.
        var archived: [OrgThread] = []
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
        // The server judged it over every thread (`shared`): a read of part of the list, or with
        // cut answers, cannot tell two copies of one reply apart by itself.
        for t in threads { for m in t.messages where m.shared == true { out.insert(m.id) } }
        return out
    }

    // MARK: - Where a thread is drawn

    /// On his Watching list now (server thread-view.ts watchedNow): open and watched.
    static func watchedNow(_ t: OrgThread) -> Bool { watch(t) != nil && t.closed == nil }

    /// Its watch, the older `pinned` of an older server read as one.
    static func watch(_ t: OrgThread) -> OrgThread.Watched? { t.watched ?? t.pinned }

    /// The Watching list (server thread-view.ts watchingOf): oldest watch first.
    static func watching(_ threads: [OrgThread]) -> [OrgThread] {
        threads.filter(watchedNow).sorted { a, b in
            let x = watch(a)?.at ?? "", y = watch(b)?.at ?? ""
            return x == y ? a.id < b.id : x < y
        }
    }

    /// The new place of the card dragged from `from` to `to` in Watching, as the time between its
    /// new neighbours (the web's watchingReorder); nil when it stays put.
    static func watchPlace(_ list: [OrgThread], from: Int, to: Int, now: Date) -> String? {
        guard list.indices.contains(from), list.indices.contains(to), from != to else { return nil }
        var rest = list
        let moved = rest.remove(at: from)
        rest.insert(moved, at: to)
        func ms(_ t: OrgThread) -> Double? { watch(t).flatMap { WalnutTask.parseISO($0.at) }.map { $0.timeIntervalSince1970 * 1000 } }
        let before = to > 0 ? ms(rest[to - 1]) : nil
        let after = to < rest.count - 1 ? ms(rest[to + 1]) : nil
        let place: Double
        if let b = before, let a = after { place = a - b >= 2 ? ((a + b) / 2).rounded(.down) : b + 1 }
        else if let a = after { place = a > 1000 ? a - 1000 : 1 }
        else { place = max((before ?? 0) + 1, now.timeIntervalSince1970 * 1000) }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: Date(timeIntervalSince1970: place / 1000))
    }

    static func snoozedNow(_ t: OrgThread, now: Date) -> Bool {
        guard let s = t.snoozed, t.closed == nil,
              let until = WalnutTask.parseISO(s.until), until > now else { return false }
        return !newsSince(t, s.at)
    }

    private static func newsSince(_ t: OrgThread, _ at: String) -> Bool {
        t.messages.contains { $0.at > at || ($0.answer.map { $0.at > at } ?? false) }
    }

    /// His view shows it: he must decide (needs), the result is in (answered), an answer of the
    /// node's he has not reacted to is on it.
    static func shownToHim(_ t: OrgThread, shared: Set<String> = [], now: Date) -> Bool {
        if t.closed != nil { return false }
        if t.state == "pending" || snoozedNow(t, now: now) { return false }
        if t.state == "needs" || t.state == "answered" { return true }
        return !unread(t, shared: shared).isEmpty
    }

    /// The thread once his Follow up went in, before the next read: an answered, needs or pending
    /// thread is the node's move again (threads-model.ts files his message so), out of his view.
    static func afterHisFollowUp(_ t: OrgThread) -> OrgThread {
        var t = t
        if t.closed != nil { return t }
        if ["answered", "needs", "pending"].contains(t.state) { t.state = "working" }
        t.shown = false
        // The node's move now: never counted (server thread-groups.ts threadsForHim).
        t.counted = false
        return t
    }

    /// In his view: the server's judgement when it sent one (`shown`, made over every thread of
    /// the node, the rule the header counts by), else this phone's port of that rule.
    static func inView(_ t: OrgThread, shared: Set<String>, now: Date) -> Bool {
        if t.closed != nil { return false }
        // A snooze that ran out since the read: the server judged it while it was put aside.
        if let s = t.snoozed, let until = WalnutTask.parseISO(s.until), until <= now {
            return shownToHim(t, shared: shared, now: now)
        }
        return t.shown ?? shownToHim(t, shared: shared, now: now)
    }

    /// Some answer in it came cut by the list read.
    static func hasCutAnswer(_ t: OrgThread) -> Bool {
        t.messages.contains { $0.answer?.clipped == true }
    }

    // MARK: Who wrote each block (the web's `thread-text-source.ts`)
    //
    // A path in a card opens on the machine of whoever wrote the words around it: the summary by
    // its recorded writer, an answer by the session it was read from, an opener by its post.
    // Never the node's current session; a block with no writer recorded is unknown, so its paths
    // ask which machine instead of guessing one.

    static func summarySource(_ t: OrgThread) -> LinkSource {
        if clean(t.reply_by) == "human" { return .primary }
        return session(t.reply_sid, t.reply_host)
    }

    static func answerSource(_ a: OrgThreadMessage.Answer?) -> LinkSource {
        session(a?.sid, a?.host)
    }

    static func openerSource(_ o: OrgThread.Opener) -> LinkSource {
        if clean(o.by) == "human" { return .primary }
        return session(o.sid, o.host)
    }

    /// The block an exchange shows: the node's opening post, else its answer.
    static func source(of x: Exchange) -> LinkSource {
        x.opener.map(openerSource) ?? answerSource(x.answer)
    }

    private static func session(_ sid: String?, _ host: String?) -> LinkSource {
        guard let sid = clean(sid) else { return .unknown }
        return LinkSource(host: clean(host), sessionID: sid)
    }

    private static func clean(_ s: String?) -> String? {
        let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }

    /// An answer as the card draws it: one the server cut for the read (`clipped`) says where the rest is.
    static func answerText(_ a: OrgThreadMessage.Answer) -> String {
        a.clipped == true ? a.text + "\n\n*Shortened here; the whole answer is in the chat.*" : a.text
    }

    /// How many threads for him a read failed to bring, or nil when it brought them all: the
    /// server's count from the same read wins, then the node's own status (`user_status.threads`).
    static func unreadCount(serverCount: Int?, nodeCount: Int?, read: Int) -> Int? {
        let expected = serverCount ?? nodeCount ?? 0
        return read == 0 && expected > 0 ? expected : nil
    }

    static func sections(_ threads: [OrgThread], now: Date) -> Sections {
        let shared = sharedAnswers(threads)
        var s = Sections()
        let shown = threads.filter { inView($0, shared: shared, now: now) }
            .sorted { $0.updatedAt > $1.updatedAt }
        s.watching = watching(threads)
        s.open = shown
        s.snoozed = threads.filter { !inView($0, shared: shared, now: now) && snoozedNow($0, now: now) }
            .sorted { ($0.snoozed?.until ?? "") < ($1.snoozed?.until ?? "") }
        let rest = threads.filter { $0.closed == nil && !snoozedNow($0, now: now) && !inView($0, shared: shared, now: now) }
        s.working = rest.filter { group($0, inView: false, now: now) == .working }
        s.known = rest.filter { group($0, inView: false, now: now) == .known }
        s.waiting = rest.filter { let g = group($0, inView: false, now: now); return g != .working && g != .known }
        // Newest close first, and a closed row's time is its close (`shownAt`), so the list reads in order.
        let closed = threads.filter { $0.closed != nil }.sorted { shownAt($0) > shownAt($1) }
        s.closed = closed.filter { !archivedNow($0, now: now) }
        s.archived = closed.filter { archivedNow($0, now: now) }
        return s
    }

    // MARK: - Groups

    /// The groups a thread is drawn in, in the user's own words (server `src/core/org/thread-groups.ts`
    /// THREAD_GROUP_LABELS; 2026-11-20, the user: "No Need you, Done, waiting / snoozed, Acknowlegde,
    /// closed, archived"; his Acknowledge sends a card to Acknowledged while the AI decides where it
    /// goes). The raw values are the server's group ids.
    enum Group: String, CaseIterable {
        case needs, read, working, waiting, known, done, archived

        var label: String {
            switch self {
            case .needs: return "Needs you"
            case .read: return "Done"
            case .working: return "Working"
            case .waiting: return "Waiting"
            case .known: return "Acknowledged"
            case .done: return "Closed"
            case .archived: return "Archived"
            }
        }
    }

    /// A closed thread is Archived a day after it closed (server thread-groups.ts ARCHIVE_AFTER_MS).
    static let archiveAfter: TimeInterval = 24 * 3600

    static func archivedNow(_ t: OrgThread, now: Date) -> Bool {
        guard let at = t.closed.flatMap({ WalnutTask.parseISO($0.at) }) else { return false }
        return now.timeIntervalSince(at) >= archiveAfter
    }

    /// The group of one thread (server thread-groups.ts threadGroupOf); `inView`: his view lists it.
    static func group(_ t: OrgThread, inView: Bool, now: Date) -> Group {
        if archivedNow(t, now: now) { return .archived }
        if t.closed != nil { return .done }
        if snoozedNow(t, now: now) { return .waiting }
        if t.state == "needs" { return .needs }
        if t.state == "answered" { return inView ? .read : .waiting }
        // He acknowledged it: Acknowledged until the AI (or after 10 minutes the rule) places it.
        if isKnown(t) {
            guard let placed = placedSinceAck(t) else { return .known }
            return placed.to == "working" ? .working : .waiting
        }
        if t.state == "pending" { return .waiting }
        return .working
    }

    /// The groups his Threads always draw open, in order, each under its head with its count (the
    /// web's FOR_HIM_GROUPS). Every other group folds under them to its name and count until he
    /// taps it (`OrgThreadRevealModel.Fold`), with no row of tabs or chips (2026-11-21, the user:
    /// "Needs you first, then Done, and the rest auto collapsed").
    static let openGroups: [Group] = [.needs, .read]

    /// The open cards drawn under `g`, keeping their own order: Needs you's, then the rest under
    /// Done (one listed for another reason with them); none under any other group.
    static func openCards(_ g: Group, _ open: [OrgThread], now: Date) -> [OrgThread] {
        switch g {
        case .needs: return open.filter { group($0, inView: true, now: now) == .needs }
        case .read: return open.filter { group($0, inView: true, now: now) != .needs }
        default: return []
        }
    }

    /// Whether the page says where a thread went after this action. His own Acknowledge says
    /// nothing: the card just goes (2026-11-25, the user, of "Moved to Acknowledged" after his
    /// Acknowledge: "直接消失就好了，不要再显示一个很烦"; the web's thread-moves.ts the same).
    static func tellsWhereItWent(after edit: OrgThreadEdit) -> Bool {
        edit != .acknowledge
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
        if s.working.contains(where: { $0.id == id }) { return "Moved to \(Group.working.label)" }
        if s.waiting.contains(where: { $0.id == id }) { return "Moved to \(Group.waiting.label)" }
        if s.known.contains(where: { $0.id == id }) { return "Moved to \(Group.known.label)" }
        if s.closed.contains(where: { $0.id == id }) { return "Closed. It is under \(Group.done.label)" }
        if s.archived.contains(where: { $0.id == id }) { return "Closed. It is under \(Group.archived.label)" }
        return nil
    }

    /// The time a thread's row shows: its close for a closed one, else its last message.
    static func shownAt(_ t: OrgThread) -> String {
        t.closed?.at ?? t.messages.last?.at ?? t.opener?.at ?? t.updatedAt
    }

    // MARK: - Words

    /// A thread's state as the user reads it: the task-state names where they mean the same.
    /// He acknowledged it while its work ran and it still waits: pending, open, no word of his since
    /// (the server's thread-known.ts isKnown).
    static func isKnown(_ t: OrgThread) -> Bool {
        guard t.closed == nil, t.state == "pending", let acked = t.ackedAt else { return false }
        return !t.messages.contains { $0.at > acked }
    }

    /// Its placement since his last Acknowledge (server thread-known.ts placedSinceAck).
    static func placedSinceAck(_ t: OrgThread) -> OrgThread.AckPlaced? {
        guard let acked = t.ackedAt, let p = t.ackPlaced, p.at >= acked else { return nil }
        return p
    }

    /// The card's one line about his Acknowledge (server thread-known.ts ackCardLine): the AI is
    /// deciding; or where it went and why; nil on any other card.
    static func ackCardLine(_ t: OrgThread) -> String? {
        if isKnown(t) && placedSinceAck(t) == nil { return "AI is deciding where this goes." }
        guard let p = placedSinceAck(t), let acked = t.ackedAt else { return nil }
        let shows = p.to == "closed" ? t.closed != nil && !t.messages.contains { $0.at > acked } : isKnown(t)
        guard shows else { return nil }
        let place = ["working": "Working", "waiting": "Waiting", "closed": "Closed"][p.to] ?? p.to.capitalized
        let why = p.why.map { ": \($0)" } ?? "."
        return "Moved to \(place)\(p.by == "walnut" ? " by Walnut" : "")\(why)"
    }

    /// A card reads the group it is drawn in, the one rule (thread-groups.ts threadGroupOf), so a
    /// closed card reads Closed, never Done or Moved, and a pending one Waiting / Snoozed (2026-11-20,
    /// the user: "why the done here means close"; 2026-11-21, a review: a badge disagreed with its group).
    static func stateLabel(_ t: OrgThread, inView: Bool = true, now: Date = Date()) -> String {
        group(t, inView: inView, now: now).label
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
            // Its time written as the toast and the snoozed row write it ("9:00 AM", r10 review).
            out.append(("Tomorrow, \(nine.formatted(date: .omitted, time: .shortened))", nine))
        }
        if let week = calendar.date(byAdding: .day, value: 7, to: calendar.startOfDay(for: now)),
           let nine = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: week) {
            out.append(("Next week", nine))
        }
        return out
    }
}
