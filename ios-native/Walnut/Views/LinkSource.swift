import Foundation

/// A tapped path opens from the machine its words were written on, never the primary by guess.
struct LinkSource: Equatable {
    var host: String?
    /// Separates "the primary" (host nil, known) from "not known".
    var hostKnown: Bool
    var cwd: String?
    var sessionID: String?
    /// The words' writer is not known (an older record, a writer Walnut could not name): a tap
    /// opens nothing, never the task's current session or the primary by guess.
    var unknownSource: Bool

    init(host: String? = nil, cwd: String? = nil, sessionID: String? = nil, unknownSource: Bool = false) {
        let named = host?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.unknownSource = unknownSource
        // An unknown source names nothing, whatever else was passed.
        self.hostKnown = !unknownSource && named != nil
        self.host = unknownSource || named == "local" || named == "__local__" ? nil : Self.clean(named)
        self.cwd = unknownSource ? nil : Self.clean(cwd)
        self.sessionID = unknownSource ? nil : Self.clean(sessionID)
    }

    static func of(_ session: WalnutSession) -> LinkSource {
        LinkSource(host: session.host, cwd: session.cwd, sessionID: session.id)
    }

    /// The primary (the Mac): where a person's own words were typed.
    static let primary = LinkSource(host: "__local__")
    static let unknown = LinkSource(unknownSource: true)

    /// No place named and not marked unknown: the caller may fall back to a task's session.
    var isEmpty: Bool { !unknownSource && !hostKnown && cwd == nil && sessionID == nil }

    /// The one source several writers of the same words share, else unknown: when they disagree
    /// no writer is picked at random.
    static func agreed(_ sources: [LinkSource]) -> LinkSource {
        guard let first = sources.first, sources.allSatisfy({ $0 == first }) else { return .unknown }
        return first
    }

    private static func clean(_ s: String?) -> String? {
        let t = s?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return t.isEmpty ? nil : t
    }
}

@MainActor
protocol LinkSourceLookup: AnyObject {
    var sessions: [WalnutSession] { get }
    func knownSessionIds(for taskId: String) -> [String]?
    func fetchSessionIds(for taskId: String) async -> [String]?
    func resolveSession(id: String, task: WalnutTask?) async -> WalnutSession?
}

extension TasksStore: LinkSourceLookup {}

/// Asks the server only on a tap, so drawing a row costs no request.
enum LinkSourceResolver {
    enum Step: Equatable {
        case known(LinkSource)
        case resolve(sessionId: String)
        case probe(taskId: String)
        case none
    }

    enum Answer: Equatable {
        case source(LinkSource)
        case noSession
        case unreachable
    }

    static func step(for task: WalnutTask, sessions: [WalnutSession], knownSessionIds: [String]?) -> Step {
        let live = task.liveActivity?.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !live.isEmpty {
            if let session = sessions.first(where: { $0.id == live }) { return .known(.of(session)) }
            return .resolve(sessionId: live)
        }
        // The same order a tap on the task's row takes to its session.
        let row = BoardModel.row(for: task, sessions: sessions, knownSessionIds: knownSessionIds)
        switch BoardModel.tapRoute(row) {
        case .open(let session): return .known(.of(session))
        case .resolve(let id, _): return .resolve(sessionId: id)
        case .probe(let id, _): return .probe(taskId: id)
        case .draft: return .none
        }
    }

    @MainActor
    static func source(for task: WalnutTask, lookup: LinkSourceLookup) async -> Answer {
        var next = step(for: task, sessions: lookup.sessions, knownSessionIds: lookup.knownSessionIds(for: task.id))
        if case .probe(let taskId) = next {
            guard let ids = await lookup.fetchSessionIds(for: taskId) else { return .unreachable }
            guard let id = BoardModel.newestSessionId(ids) else { return .noSession }
            next = .resolve(sessionId: id)
        }
        switch next {
        case .known(let source): return .source(source)
        case .none: return .noSession
        case .probe: return .unreachable
        case .resolve(let id):
            guard let session = await lookup.resolveSession(id: id, task: task) else { return .unreachable }
            return .source(.of(session))
        }
    }

    @MainActor
    static func route(_ ref: FilePathRef, explicit: LinkSource, task: WalnutTask?, lookup: LinkSourceLookup?,
                      locate: @MainActor (FilePathRef, LinkSource) async -> ClickedPathRoute) async -> ClickedPathRoute {
        // Every unknown machine below ends unreachable: guessing the primary opens another machine's file of that name.
        // A writer nobody recorded: no lookup at all, and never the task's current session.
        if explicit.unknownSource { return ClickedPath.unreachableSource(ref, notRecorded: true) }
        if !explicit.hostKnown, let sid = explicit.sessionID {
            guard let lookup, let session = await lookup.resolveSession(id: sid, task: nil) else {
                return ClickedPath.unreachableSource(ref)
            }
            var found = LinkSource.of(session)
            found.cwd = explicit.cwd ?? found.cwd
            found.sessionID = sid
            return await locate(ref, found)
        }
        guard explicit.isEmpty, let task else { return await locate(ref, explicit) }
        guard let lookup else { return ClickedPath.unreachableSource(ref) }
        switch await source(for: task, lookup: lookup) {
        case .source(let source): return await locate(ref, source)
        // A task whose session the phone cannot name has no known machine: the generic lookup would guess one.
        case .noSession: return ClickedPath.unreachableSource(ref, notRecorded: true)
        case .unreachable: return ClickedPath.unreachableSource(ref)
        }
    }
}

extension Letter {
    var linkSource: LinkSource {
        // A letter with no recorded sender names no machine.
        guard let sender else { return .unknown }
        return Self.linkSource(of: sender)
    }

    func linkSource(for entry: LetterThreadEntry) -> LinkSource {
        // A turn a task wrote (from "human" when it answered in the user's place): its host is looked up from its session.
        if let by = entry.writingSessionID { return by == sender?.sessionId ? linkSource : LinkSource(sessionID: by) }
        // The person typed it on the primary (the Mac), so its own files are there and nowhere else.
        if entry.isHuman { return .primary }
        // An agent turn: the writer the server recorded on it. An older turn names none, and its
        // writer is not known: it is never taken to be the letter's own sender.
        guard let writer = entry.sender else { return .unknown }
        return Self.linkSource(of: writer)
    }

    /// A recorded writer (a letter's sender or a turn's): a named host is where it ran ("local" the
    /// primary); "external" (Walnut itself or a plugin) with no host is unknown, as on the web; a
    /// session with no host is looked up on tap; nothing named is unknown.
    static func linkSource(of writer: LetterSender) -> LinkSource {
        let sid = writer.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let host = writer.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if sid == "external" { return host.isEmpty ? .unknown : LinkSource(host: host) }
        if !host.isEmpty { return LinkSource(host: host, sessionID: sid) }
        return sid.isEmpty ? .unknown : LinkSource(sessionID: sid)
    }
}

extension LetterThreadEntry {
    var writingSessionID: String? {
        let sid = by?.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return sid.isEmpty ? nil : sid
    }

    var isPersonWritten: Bool { isHuman && writingSessionID == nil }
}

/// One line can hold several writers' words, so each file link carries the machine its words came
/// from (`tagging(_:source:)`). `sourceTask` is no longer written or read: it named a task, which
/// opened the path from that task's CURRENT session; tagging still strips it from agent markup.
extension FilePreviewLink {
    static let sourceTaskKey = "sourceTask"
    static let sourceSessionKey = "sourceSession"
    static let sourceHostKey = "sourceHost"
    static let sourceUnknownKey = "sourceUnknown"
    private static let sourceKeys: Set<String> = [sourceTaskKey, sourceSessionKey, sourceHostKey, sourceUnknownKey]

    /// Tags EVERY file link in `links` with the machine its words were written on, replacing any
    /// source an agent's own markup put there. Built by the phone from its own records (the
    /// status's writer fields), never read from agent text; read back only by a handler that
    /// asked for it (`handlingTaggedFilePathLinks`).
    static func tagging(_ links: AttributedString, source: LinkSource) -> AttributedString {
        var items: [URLQueryItem] = []
        if source.unknownSource {
            items.append(URLQueryItem(name: sourceUnknownKey, value: "1"))
        } else {
            if source.hostKnown { items.append(URLQueryItem(name: sourceHostKey, value: source.host ?? "__local__")) }
            if let sid = source.sessionID { items.append(URLQueryItem(name: sourceSessionKey, value: sid)) }
            // Nothing named: unknown, so the tag never reads as "no tag" and falls back to a guess.
            if items.isEmpty { items.append(URLQueryItem(name: sourceUnknownKey, value: "1")) }
        }
        return retag(links, with: items)
    }

    /// The source `tagging(_:source:)` wrote, nil when the link carries none.
    static func linkSource(from url: URL) -> LinkSource? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? {
            let v = items.first(where: { $0.name == name })?.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return v.isEmpty ? nil : v
        }
        if value(sourceUnknownKey) != nil { return .unknown }
        let host = value(sourceHostKey), sid = value(sourceSessionKey)
        guard host != nil || sid != nil else { return nil }
        return LinkSource(host: host, sessionID: sid)
    }

    private static func retag(_ links: AttributedString, with items: [URLQueryItem]) -> AttributedString {
        var out = links
        for run in links.runs {
            guard let url = run.link, reference(from: url) != nil,
                  var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { continue }
            parts.queryItems = (parts.queryItems ?? []).filter { !sourceKeys.contains($0.name) } + items
            if let tagged = parts.url { out[run.range].link = tagged }
        }
        return out
    }
}

extension LinkSourceResolver {
    /// The source a tapped file link opens from. A handler that asked for tags
    /// (`handlingTaggedFilePathLinks`) reads the ones the phone wrote, a link without one being
    /// unknown; every other handler uses its own source. Nothing else in a link's query (an agent
    /// can write any) ever names a machine, a session or a task.
    static func explicitSource(for url: URL, readsSourceTags: Bool, own: LinkSource) -> LinkSource {
        readsSourceTags ? (FilePreviewLink.linkSource(from: url) ?? .unknown) : own
    }
}

/// Which of a task's own texts a link sits in. Each text has its own writer, often an older
/// session than the one running now, so each is opened from where it was written.
extension LinkSource {
    enum TaskTextField: Equatable {
        /// The Needs you / To read line (`TeamStatusModel.needLine`).
        case needs
        /// The Waiting line (`TeamStatusModel.waitingLine`).
        case waiting
        case now
        case next
        /// `user_status.line`, the task's own line.
        case line
        case summary
        /// `result_report.result`.
        case result
        /// `result_report.not_done`, the Partial list.
        case partial
    }

    /// The machine a task text was written on, from the writer fields the server records with it
    /// (the web's twin). Never the task's current session: a status from an older session, or a
    /// record from before the fields existed, would open the wrong machine's file of that name.
    static func forTaskText(_ task: WalnutTask, _ field: TaskTextField) -> LinkSource {
        let s = task.userStatus
        switch field {
        case .now, .next:
            return report(s)
        case .waiting:
            if let answered = s?.answeredFor { return writer(by: answered.by, sessionId: answered.sessionId) }
            // Only the writer of the waiting words themselves: Walnut's own wait words, or a report
            // whose now / next someone else wrote, name no writer of them.
            return writer(by: s?.waitingBy, sessionId: s?.waitingSessionId)
        case .needs:
            let toRead = TeamStatusModel.isToRead(s) ? s?.toRead?.trimmingCharacters(in: .whitespaces) : nil
            // Its last words, which Walnut read from the session that wrote them.
            if toRead == "turn" { return writer(by: nil, sessionId: task.lastWords?.sessionId) }
            // An answer to read shows its waiting words, whose own writer is recorded with them.
            if toRead == "answer" { return writer(by: s?.waitingBy, sessionId: s?.waitingSessionId) }
            // A session's ask: the writer of the ask itself, never the report's now / next writer.
            if s?.source == "session" { return writer(by: s?.askBy, sessionId: s?.askSessionId) }
            // Walnut's own words (a prompt, a letter, a choice, an error) or a writer it did not record.
            return .unknown
        case .line:
            return writer(by: s?.line?.by, sessionId: s?.line?.sessionId)
        case .summary:
            return writer(by: nil, sessionId: task.summarySessionID)
        case .result:
            return resultWriter(task.resultReport)
        case .partial:
            // The not-done list may have another writer than the result; one Walnut could not name is unknown.
            if task.resultReport?.notDoneBy?.trimmingCharacters(in: .whitespaces) == "unknown" { return .unknown }
            return resultWriter(task.resultReport)
        }
    }

    /// A result's writer: a person's only with `host: local` recorded (an older `human` may be a
    /// session caller Walnut could not resolve), else its session. Kept apart from `writer`, whose
    /// other callers' `human` is recorded by Walnut itself.
    private static func resultWriter(_ r: WalnutResultReport?) -> LinkSource {
        if r?.by?.trimmingCharacters(in: .whitespaces) == "human" {
            return r?.host?.trimmingCharacters(in: .whitespaces) == "local" ? .primary : .unknown
        }
        return writer(by: r?.by, sessionId: r?.sessionId)
    }

    private static func report(_ s: WalnutUserStatus?) -> LinkSource {
        writer(by: s?.reportBy, sessionId: s?.reportSessionId)
    }

    /// A person typed it on the primary; a session wrote it where that session runs; anything
    /// else (an older record with no session id, `unknown`) is not known.
    static func writer(by: String?, sessionId: String?) -> LinkSource {
        if by?.trimmingCharacters(in: .whitespaces) == "human" { return .primary }
        let sid = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return sid.isEmpty ? .unknown : LinkSource(sessionID: sid)
    }
}
