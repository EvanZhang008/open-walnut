import XCTest
@testable import Walnut

/// A task's texts open a path from the machine each was written on (`LinkSource.forTaskText`),
/// never from the session the task runs now.
@MainActor
final class TaskTextSourceTests: XCTestCase {
    private let ref = FilePathRef(path: "/tmp/run/report.md")

    private final class ScriptedLookup: LinkSourceLookup {
        var sessions: [WalnutSession] = []
        var byId: [String: WalnutSession] = [:]
        private(set) var fetches: [String] = []
        private(set) var resolves: [String] = []

        func knownSessionIds(for taskId: String) -> [String]? { nil }
        func fetchSessionIds(for taskId: String) async -> [String]? {
            fetches.append(taskId)
            return ["s-newest"]
        }
        func resolveSession(id: String, task: WalnutTask?) async -> WalnutSession? {
            resolves.append(id)
            return byId[id]
        }
    }

    private func session(_ id: String, host: String) -> WalnutSession {
        WalnutSession(
            id: id, title: "s", taskId: "mtask001-0a0a", taskTitle: "Task", project: nil, host: host,
            processStatus: "idle", model: nil, mode: nil, startedAt: "2026-11-01T00:00:00Z",
            lastActiveAt: "2026-11-01T01:00:00Z", messageCount: 1, cwd: "/home/me/\(id)", pinned: nil,
            focusTier: nil, description: nil
        )
    }

    /// A task running in `s-live` now, so any fallback to its current session would show.
    private func task(status: WalnutUserStatus? = nil) -> WalnutTask {
        var t = WalnutTask(
            id: "mtask001-0a0a", title: "Task", status: "in_progress", phase: "NEED_ACTION", priority: "none",
            project: "Walnut", dueDate: nil, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
            completedAt: nil, starred: nil, pinned: nil, tags: nil, summary: "See /tmp/run/report.md",
            parentTaskId: nil, userStatus: status
        )
        t.liveActivity = WalnutLiveActivity(kind: "tool", since: "2026-11-01T00:00:00Z", sessionId: "s-live")
        return t
    }

    private func needs(by: String? = nil, sid: String? = nil, source: String? = "session") -> WalnutUserStatus {
        var s = WalnutUserStatus(state: "needs", ask: "Check /tmp/run/report.md")
        s.source = source
        s.now = "Reading /tmp/run/report.md"
        s.reportBy = by
        s.reportSessionId = sid
        // The ask written in the same report as its now line.
        s.askBy = by
        s.askSessionId = sid
        return s
    }

    private func route(_ explicit: LinkSource, task: WalnutTask, lookup: ScriptedLookup) async -> (route: ClickedPathRoute, asked: [LinkSource]) {
        var asked: [LinkSource] = []
        let r = await LinkSourceResolver.route(ref, explicit: explicit, task: task, lookup: lookup) { ref, from in
            asked.append(from)
            return ClickedPath.route(ref, host: from.host, cwd: from.cwd, sessionID: from.sessionID)
        }
        return (r, asked)
    }

    // MARK: - Old records

    func testAnOldRecordWithNoWriterIsUnknownNotTheCurrentSession() async {
        let t = task(status: needs(by: "self", sid: nil))
        for field: LinkSource.TaskTextField in [.needs, .now, .next, .waiting, .line, .summary, .result, .partial] {
            XCTAssertEqual(LinkSource.forTaskText(t, field), .unknown, "\(field)")
        }
        let lookup = ScriptedLookup()
        lookup.byId = ["s-live": session("s-live", host: "devbox")]
        let r = await route(.forTaskText(t, .needs), task: t, lookup: lookup)
        XCTAssertEqual(r.asked, [], "no lookup on any machine")
        XCTAssertEqual(lookup.fetches + lookup.resolves, [], "not the task's current or newest session")
        guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
        XCTAssertTrue(target.unknownSource, "the viewer offers the user's machines")
        XCTAssertNil(target.host)
        XCTAssertTrue(target.missing?.contains("not recorded") == true, target.missing ?? "")
        XCTAssertFalse(target.missing?.contains("online") == true, "an unknown writer is no network problem")
    }

    func testAnUnknownSourceNamesNothingAndIsNotEmpty() {
        let unknown = LinkSource(host: "devbox", cwd: "/srv", sessionID: "s1", unknownSource: true)
        XCTAssertEqual(unknown, .unknown)
        XCTAssertFalse(unknown.isEmpty, "never read as 'no source named', which falls back to the task")
        XCTAssertFalse(unknown.hostKnown)
        XCTAssertNil(unknown.sessionID)
    }

    // MARK: - Recorded writers

    func testAStoredSessionOpensThatSessionNotTheCurrentOne() async {
        let t = task(status: needs(by: "self", sid: "s-old"))
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), LinkSource(sessionID: "s-old"))
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s-live", host: "devbox")]
        lookup.byId = ["s-old": session("s-old", host: "spare"), "s-live": session("s-live", host: "devbox")]
        let r = await route(.forTaskText(t, .now), task: t, lookup: lookup)
        XCTAssertEqual(lookup.resolves, ["s-old"])
        XCTAssertEqual(lookup.fetches, [])
        XCTAssertEqual(r.asked.map(\.host), ["spare"])
    }

    func testAPersonsReportOpensOnThePrimaryWithNoLookup() async {
        let t = task(status: needs(by: "human", sid: nil))
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), .primary)
        let lookup = ScriptedLookup()
        let r = await route(.forTaskText(t, .next), task: t, lookup: lookup)
        XCTAssertEqual(r.asked, [.primary])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }

    func testMainAnsweringAWorkerOpensTheAnswerFromMain() {
        var s = WalnutUserStatus(state: "waiting", waitingOn: "Its lead answered: see /tmp/run/report.md")
        s.reportBy = "self"
        s.reportSessionId = "s-worker"
        s.answeredFor = WalnutAnsweredFor(by: "mmain001-0e0e", byTitle: "Main", sessionId: "s-main")
        let t = task(status: s)
        XCTAssertEqual(LinkSource.forTaskText(t, .waiting), LinkSource(sessionID: "s-main"))
        XCTAssertEqual(LinkSource.forTaskText(t, .now), LinkSource(sessionID: "s-worker"), "its own words stay its own")
        s.answeredFor = WalnutAnsweredFor(by: "human")
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), .primary)
        s.answeredFor = WalnutAnsweredFor(by: "mmain001-0e0e")
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), .unknown, "an answer with no session is not known")
    }

    func testWaitingWordsOpenOnlyFromTheirOwnWriter() {
        var s = WalnutUserStatus(state: "waiting", kind: "task", waitingOn: "Another task: /tmp/run/report.md")
        s.now = "Waiting for the review of /tmp/run/report.md"
        s.reportBy = "self"
        s.reportSessionId = "s-report"
        // Walnut's own waiting words beside a report's now: the report's writer is not theirs.
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), .unknown)
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .now), LinkSource(sessionID: "s-report"))
        s.waitingBy = "self"
        s.waitingSessionId = "s-wait"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), LinkSource(sessionID: "s-wait"))
        s.waitingBy = "human"
        s.waitingSessionId = nil
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), .primary)
        s.waitingBy = "self"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), .unknown, "an older record with no session id")
        s.answeredFor = WalnutAnsweredFor(by: "mmain001-0e0e", sessionId: "s-main")
        s.waitingSessionId = "s-wait"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .waiting), LinkSource(sessionID: "s-main"), "the answer's own writer first")
    }

    func testTwoFieldsOfOneTaskOpenFromTheirOwnWriters() {
        var s = needs(by: "self", sid: "s-report")
        s.line = WalnutStatusLine(text: "Next: /tmp/run/report.md", by: "human")
        var t = task(status: s)
        t.summarySessionID = "s-summary"
        t.resultReport = WalnutResultReport(notDone: ["/tmp/run/report.md"], result: "Done", by: "task:mlead001-0f0f", sessionId: "s-lead")
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), LinkSource(sessionID: "s-report"))
        XCTAssertEqual(LinkSource.forTaskText(t, .line), .primary)
        XCTAssertEqual(LinkSource.forTaskText(t, .summary), LinkSource(sessionID: "s-summary"))
        XCTAssertEqual(LinkSource.forTaskText(t, .result), LinkSource(sessionID: "s-lead"))
        XCTAssertEqual(LinkSource.forTaskText(t, .partial), LinkSource(sessionID: "s-lead"))
        // An older `human` with no host may be a session caller Walnut could not resolve.
        t.resultReport?.by = "human"
        t.resultReport?.sessionId = nil
        XCTAssertEqual(LinkSource.forTaskText(t, .result), .unknown)
        XCTAssertEqual(LinkSource.forTaskText(t, .partial), .unknown)
        t.resultReport?.host = "local"
        XCTAssertEqual(LinkSource.forTaskText(t, .result), .primary)
        XCTAssertEqual(LinkSource.forTaskText(t, .partial), .primary)
        // The generic writer rule is unchanged: a status writer `human` is still the primary.
        XCTAssertEqual(LinkSource.writer(by: "human", sessionId: nil), .primary)
    }

    func testAResultHostIsDecodedAndKept() throws {
        let local = try JSONDecoder().decode(WalnutResultReport.self, from: Data(
            #"{"not_done":["x"],"by":"human","host":"local"}"#.utf8))
        XCTAssertEqual(local.host, "local")
        let back = try JSONDecoder().decode(WalnutResultReport.self, from: JSONEncoder().encode(local))
        XCTAssertEqual(back.host, "local")
        let old = try JSONDecoder().decode(WalnutResultReport.self, from: Data(#"{"not_done":["x"],"by":"human"}"#.utf8))
        XCTAssertNil(old.host)
    }

    func testANeedsLineFollowsWhatItShows() {
        var s = WalnutUserStatus(state: "read", waitingOn: "Its last words: /tmp/run/report.md")
        s.toRead = "turn"
        s.reportBy = "self"
        s.reportSessionId = "s-report"
        var t = task(status: s)
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), .unknown, "last words never read: not known")
        t.lastWords = WalnutLastWords(text: "x", at: "2026-11-01T00:00:00Z", sessionId: "s-last")
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), LinkSource(sessionID: "s-last"))
        s.toRead = "answer"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .needs), .unknown,
                       "an answer shows its waiting words: never the report's now writer")
        s.waitingBy = "task:mlead001-0f0f"
        s.waitingSessionId = "s-quoted"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .needs), LinkSource(sessionID: "s-quoted"))
        for source in ["letter", "choice", "prompt", "error"] {
            XCTAssertEqual(LinkSource.forTaskText(task(status: needs(by: "self", sid: "s-report", source: source)), .needs),
                           .unknown, "Walnut's own words for \(source)")
        }
    }

    // MARK: - Each text, its own writer

    func testAnAskFromAnOlderWriterIsUnknownWhileTheNewNowIsKnown() {
        var s = WalnutUserStatus(state: "needs", ask: "Check /tmp/run/report.md")
        s.source = "session"
        s.now = "Building /tmp/run/report.md"
        s.reportBy = "self"
        s.reportSessionId = "s-b"
        let t = task(status: s)
        XCTAssertEqual(LinkSource.forTaskText(t, .needs), .unknown, "the ask's writer is not recorded")
        XCTAssertEqual(LinkSource.forTaskText(t, .now), LinkSource(sessionID: "s-b"))
        s.askBy = "self"
        s.askSessionId = "s-a"
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .needs), LinkSource(sessionID: "s-a"), "the ask's own writer")
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .now), LinkSource(sessionID: "s-b"))
        s.askBy = "human"
        s.askSessionId = nil
        XCTAssertEqual(LinkSource.forTaskText(task(status: s), .needs), .primary)
    }

    func testANotDoneListFromAnUnknownWriterIsUnknownWhileTheResultIsKnown() {
        var t = task()
        t.resultReport = WalnutResultReport(notDone: ["/tmp/run/report.md"], result: "/tmp/run/out.md",
                                            by: "task:mb000002-0b0b", sessionId: "s-b", notDoneBy: "unknown")
        XCTAssertEqual(LinkSource.forTaskText(t, .partial), .unknown)
        XCTAssertEqual(LinkSource.forTaskText(t, .result), LinkSource(sessionID: "s-b"))
        t.resultReport?.notDoneBy = nil
        XCTAssertEqual(LinkSource.forTaskText(t, .partial), LinkSource(sessionID: "s-b"), "one writer for both")
    }

    func testOldRowsMissingTheWriterFieldsReadUnknown() throws {
        let row = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"mtask001-0a0a","title":"T","status":"todo","phase":"NEED_ACTION","priority":"none","project":"",
         "result_report":{"at":"2026-11-01T00:00:00Z","not_done":["/tmp/x"],"result":"r"},
         "user_status":{"state":"needs","source":"session","ask":"/tmp/x","now":"n","reportBy":"self","reportSessionId":"s-rep",
           "waitingOn":"w","toRead":null}}
        """.utf8))
        XCTAssertNil(row.userStatus?.askSessionId)
        XCTAssertNil(row.resultReport?.notDoneBy)
        XCTAssertEqual(LinkSource.forTaskText(row, .needs), .unknown, "no ask writer: never the report's")
        XCTAssertEqual(LinkSource.forTaskText(row, .waiting), .unknown, "no waiting writer: never the report's")
        XCTAssertEqual(LinkSource.forTaskText(row, .now), LinkSource(sessionID: "s-rep"))
        XCTAssertEqual(LinkSource.forTaskText(row, .result), .unknown)
        XCTAssertEqual(LinkSource.forTaskText(row, .partial), .unknown)
        let fresh = try JSONDecoder().decode(WalnutResultReport.self, from: Data(
            #"{"not_done":["x"],"by":"task:m1","sessionId":"s1","not_done_by":"unknown"}"#.utf8))
        XCTAssertEqual(fresh.notDoneBy, "unknown")
    }

    // MARK: - Tags on links built from several writers

    func testTagsCarryEachWritersSourceAndReplaceAnAgentsOwn() throws {
        // A non-ASCII directory, written as escapes.
        let path = "/tmp/\u{6587}\u{4EF6}/report.md"
        var forged = AttributedString("report.md")
        var parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(FilePreviewLink.url(for: FilePathRef(path: path))), resolvingAgainstBaseURL: false))
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: FilePreviewLink.sourceHostKey, value: "elsewhere")]
        forged.link = try XCTUnwrap(parts.url)
        XCTAssertEqual(FilePreviewLink.linkSource(from: try XCTUnwrap(forged.runs.first?.link)), LinkSource(host: "elsewhere"),
                       "a tag in agent markup parses, which is why only a tagging handler reads tags")

        for source in [LinkSource.primary, LinkSource(sessionID: "s-old"), LinkSource(host: "devbox", sessionID: "s1"), .unknown, LinkSource()] {
            let tagged = FilePreviewLink.tagging(forged, source: source)
            let url = try XCTUnwrap(tagged.runs.first?.link)
            XCTAssertEqual(FilePreviewLink.reference(from: url)?.path, path)
            let read = try XCTUnwrap(FilePreviewLink.linkSource(from: url), "every tagged link names a source")
            XCTAssertEqual(read, source.isEmpty ? .unknown : source, "\(source)")
            XCTAssertNotEqual(read.host, "elsewhere", "the agent's own tag is gone")
        }
    }

    func testAnUnknownTagRoutesWithNoLookup() async throws {
        var s = AttributedString("report.md")
        s.link = try XCTUnwrap(FilePreviewLink.url(for: ref))
        let url = try XCTUnwrap(FilePreviewLink.tagging(s, source: .unknown).runs.first?.link)
        let lookup = ScriptedLookup()
        let r = await route(try XCTUnwrap(FilePreviewLink.linkSource(from: url)), task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }

    func testWritersThatDisagreeAreUnknown() {
        XCTAssertEqual(LinkSource.agreed([.primary, .primary]), .primary)
        XCTAssertEqual(LinkSource.agreed([.primary, LinkSource(sessionID: "s1")]), .unknown)
        XCTAssertEqual(LinkSource.agreed([]), .unknown)
    }

    // MARK: - The class: a task's text never routes through the task's current session

    /// A handler given only a task (`handlingFilePathLinks(task: x)`) or a `sourceTask` tag opens a
    /// path from the task's current session, which wrote none of its older words. Every app site
    /// names the text's field or its writer instead; a new one fails here.
    func testNoAppSiteRoutesATasksTextThroughItsCurrentSession() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        let taskOnly = try NSRegularExpression(pattern: #"\.handlingFilePathLinks\(\s*task:\s*[\w.?]+\s*\)"#)
        var scanned = 0
        var offenders: [String] = []
        for case let url as URL in files where url.pathExtension == "swift" {
            let source = try String(contentsOf: url, encoding: .utf8)
            scanned += 1
            let name = url.lastPathComponent
            if taskOnly.firstMatch(in: source, range: NSRange(source.startIndex..., in: source)) != nil {
                offenders.append("\(name): handlingFilePathLinks(task:) with no field")
            }
            if name != "LinkSource.swift", source.contains("sourceTask:") {
                offenders.append("\(name): a sourceTask tag")
            }
        }
        XCTAssertGreaterThan(scanned, 100, "the scan read almost no app files")
        XCTAssertEqual(offenders, [])
    }

    func testPlanLinksUseThePlanWriterRatherThanTheExecutionSession() throws {
        let own = try JSONDecoder().decode(SessionPlanPayload.self, from: Data(#"{"content":"Read /tmp/run/report.md"}"#.utf8))
        let prior = try JSONDecoder().decode(SessionPlanPayload.self, from: Data(#"{"content":"Read /tmp/run/report.md","sourceSessionId":"plan-writer"}"#.utf8))
        XCTAssertEqual(own.linkSource(requestedSessionID: "execution"), LinkSource(sessionID: "execution"))
        XCTAssertEqual(prior.linkSource(requestedSessionID: "execution"), LinkSource(sessionID: "plan-writer"))
        XCTAssertEqual(MarkdownImagePlan.plan(raw: "/tmp/run/plan.png", source: prior.linkSource(requestedSessionID: "execution")), .link)
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let view = try String(contentsOf: root.appendingPathComponent("Walnut/Views/Sessions/SessionExtrasSheets.swift"), encoding: .utf8)
        XCTAssertTrue(view.contains("linkSource: plan.linkSource(requestedSessionID: sessionId)"))
    }

    // MARK: - Images in words from a known or unknown writer

    func testAMarkdownImageLoadsAPathOnlyFromAKnownPrimary() throws {
        let path = "/tmp/run/chart.png"
        let plan = MarkdownImagePlan.plan
        XCTAssertEqual(plan(path, LinkSource()), .load(onPrimary: false), "a note with no source: as before")
        XCTAssertEqual(plan(path, .primary), .load(onPrimary: true))
        XCTAssertEqual(plan(path, LinkSource(host: "local", sessionID: "s1")), .load(onPrimary: true))
        XCTAssertEqual(plan(path, .unknown), .link, "an unknown writer: no bytes read")
        XCTAssertEqual(plan(path, LinkSource(sessionID: "s1")), .link, "a session not looked up yet")
        XCTAssertEqual(plan(path, LinkSource(host: "devbox", sessionID: "s1")), .link,
                       "another machine: never the primary's file of that name")
        XCTAssertEqual(plan("~/out/chart.png", .unknown), .link)
        XCTAssertEqual(plan("~/out/chart.png", .primary), .link, "the primary's raw read takes an absolute path")
        XCTAssertEqual(plan("https://example.com/a.png", .unknown), .load(onPrimary: false))
        XCTAssertEqual(plan("_attachment/a.png", .unknown), .load(onPrimary: false))

        let link = MarkdownImagePlan.link(raw: path, alt: "Chart")
        XCTAssertEqual(String(link.characters), "Image: Chart")
        let url = try XCTUnwrap(link.runs.first?.link)
        XCTAssertEqual(FilePreviewLink.reference(from: url)?.path, path)
        XCTAssertNil(FilePreviewLink.linkSource(from: url), "the handler's own source decides")
        XCTAssertEqual(String(MarkdownImagePlan.link(raw: "/tmp/\u{56FE}.png", alt: " ").characters), "Image: \u{56FE}.png")
    }

    /// A picked machine's image file is read from that machine only, and cached per machine.
    func testAFileImageIsReadFromItsNamedMachineAndCachedPerMachine() throws {
        let base = try XCTUnwrap(URL(string: "http://127.0.0.1:41234"))
        let path = "/tmp/run/\u{56FE}.png"
        func items(_ host: String) throws -> [String: String] {
            let url = try XCTUnwrap(AttachmentLoader.fileImageURL(base: base, path: path, host: host))
            XCTAssertEqual(url.path, "/api/v1/file-content", "never the media route, which reads the primary's copy first")
            let list = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            return Dictionary(list.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        }
        XCTAssertEqual(try items("devbox"), ["path": path, "raw": "1", "host": "devbox"])
        for primary in ["", "local", "__local__"] {
            XCTAssertEqual(try items(primary), ["path": path, "raw": "1"], "the primary names no host")
        }
        let server = base.absoluteString, token = "fixture-device-token-a"
        func key(_ host: String, server other: String? = nil, token otherToken: String? = nil) -> String {
            AttachmentLoader.fileImageKey(server: other ?? server, token: otherToken ?? token, path: path, host: host)
        }
        let onDevbox = key("devbox")
        XCTAssertNotEqual(onDevbox, key(""))
        XCTAssertNotEqual(onDevbox, key("spare"))
        XCTAssertNotEqual(onDevbox, key("devbox", server: "http://127.0.0.1:9"))
        XCTAssertNotEqual(onDevbox, key("devbox", token: "fixture-device-token-b"), "another account never reads this one's picture")
        XCTAssertEqual(key("local"), key(""))
        XCTAssertEqual(key("__local__"), key(""))
        XCTAssertFalse(onDevbox.contains(token), "the key holds no token")
        let disk = AttachmentLoader.fileImageDiskName(onDevbox)
        XCTAssertFalse(disk.contains(token) || disk.contains("devbox") || disk.contains("run"), "the disk name shows nothing of the key")
        XCTAssertNotEqual(disk, AttachmentLoader.fileImageDiskName(key("devbox", token: "fixture-device-token-b")))
        XCTAssertEqual(disk, AttachmentLoader.fileImageDiskName(onDevbox), "stable")
        for name in ["a.png", "a.JPG", "a.jpeg", "a.gif", "a.webp", "a.heic"] {
            XCTAssertTrue(AttachmentLoader.isFileImage("/tmp/\(name)"), name)
        }
        for name in ["a.svg", "a.mp4", "a.txt", "a"] {
            XCTAssertFalse(AttachmentLoader.isFileImage("/tmp/\(name)"), name)
        }
    }

    func testAnOldAgentTurnsImageIsALink() throws {
        let l = try JSONDecoder().decode(Letter.self, from: Data("""
        {"id":"lt-m9x2k1-a4f7","subject":"s","type":"info","sender":{"sessionId":"s1","host":"local"},
         "thread":[{"from":"agent","text":"![c](/tmp/run/chart.png)"}]}
        """.utf8))
        XCTAssertEqual(MarkdownImagePlan.plan(raw: "/tmp/run/chart.png", source: l.linkSource(for: l.threadEntries[0])), .link)
        XCTAssertEqual(MarkdownImagePlan.plan(raw: "/tmp/run/chart.png", source: l.linkSource), .load(onPrimary: true))
    }

    // MARK: - The wire and the copies

    func testTheProvenanceFieldsDecodeAndOldRowsReadNil() throws {
        let row = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"mtask001-0a0a","title":"T","status":"todo","phase":"NEED_ACTION","priority":"none","project":"",
         "summary":"s","summary_session_id":"s-sum","last_words":{"text":"w","at":"2026-11-01T00:00:00Z","session_id":"s-last"},
         "result_report":{"at":"2026-11-01T00:00:00Z","not_done":["x"],"by":"task:m1","sessionId":"s-res"},
         "user_status":{"state":"needs","source":"session","ask":"a","reportBy":"self","reportSessionId":"s-rep",
           "waitingBy":"task:m3","waitingSessionId":"s-wait",
           "line":{"text":"l","by":"task:m2","sessionId":"s-line","at":"2026-11-01T00:00:00Z"},
           "answeredFor":{"by":"human","byTitle":"You","at":"2026-11-01T00:00:00Z","ask":"a"}}}
        """.utf8))
        XCTAssertEqual(row.summarySessionID, "s-sum")
        XCTAssertEqual(row.lastWords?.sessionId, "s-last")
        XCTAssertEqual(row.resultReport?.sessionId, "s-res")
        XCTAssertEqual(row.resultReport?.by, "task:m1")
        XCTAssertEqual(row.userStatus?.reportSessionId, "s-rep")
        XCTAssertEqual(row.userStatus?.waitingBy, "task:m3")
        XCTAssertEqual(row.userStatus?.waitingSessionId, "s-wait")
        XCTAssertEqual(row.userStatus?.line?.sessionId, "s-line")
        XCTAssertEqual(row.userStatus?.answeredFor?.by, "human")

        let snake = try JSONDecoder().decode(WalnutResultReport.self, from: Data(#"{"not_done":["x"],"session_id":"s-snake"}"#.utf8))
        XCTAssertEqual(snake.sessionId, "s-snake")
        let odd = try JSONDecoder().decode(WalnutUserStatus.self, from: Data(#"{"state":"needs","line":"text","answeredFor":7}"#.utf8))
        XCTAssertNil(odd.line?.sessionId, "an odd shape reads as no writer, never a failed list")
        let old = try JSONDecoder().decode(WalnutTask.self, from: Data("""
        {"id":"m","title":"T","status":"todo","phase":"TODO","priority":"none","project":""}
        """.utf8))
        XCTAssertNil(old.summarySessionID)
        XCTAssertNil(old.userStatus?.waitingSessionId)
        XCTAssertNil(old.lastWords)
    }

    func testAnEditOrAPinKeepsWhoWroteTheWords() {
        var t = task(status: needs(by: "self", sid: "s-rep"))
        t.summarySessionID = "s-sum"
        t.lastWords = WalnutLastWords(text: "w", sessionId: "s-last")
        t.resultReport = WalnutResultReport(result: "r", by: "human", sessionId: nil, host: "local")
        for copy in [TasksStore.applyEdit(TasksStore.TaskEdit(title: "Renamed"), to: t), TasksStore.withPinned(t, true)] {
            XCTAssertEqual(copy.summarySessionID, "s-sum")
            XCTAssertEqual(copy.lastWords, t.lastWords)
            XCTAssertEqual(copy.userStatus, t.userStatus)
            XCTAssertEqual(copy.resultReport, t.resultReport)
            for field: LinkSource.TaskTextField in [.needs, .summary, .result, .now] {
                XCTAssertEqual(LinkSource.forTaskText(copy, field), LinkSource.forTaskText(t, field), "\(field)")
            }
        }
    }
}
