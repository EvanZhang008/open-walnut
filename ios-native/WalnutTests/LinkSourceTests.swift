import XCTest
@testable import Walnut

@MainActor
final class LinkSourceTests: XCTestCase {
    private let ref = FilePathRef(path: "/tmp/run/report.md")

    private final class ScriptedLookup: LinkSourceLookup {
        var sessions: [WalnutSession] = []
        var known: [String: [String]] = [:]
        var fetchAnswer: [String]?
        var byId: [String: WalnutSession] = [:]
        private(set) var fetches: [String] = []
        private(set) var resolves: [String] = []
        private(set) var resolvedForTask: [String?] = []

        func knownSessionIds(for taskId: String) -> [String]? { known[taskId] }
        func fetchSessionIds(for taskId: String) async -> [String]? {
            fetches.append(taskId)
            return fetchAnswer
        }
        func resolveSession(id: String, task: WalnutTask?) async -> WalnutSession? {
            resolves.append(id)
            resolvedForTask.append(task?.id)
            return byId[id]
        }
    }

    private func task(_ id: String = "mtask001-0a0a", live: String? = nil) -> WalnutTask {
        var t = WalnutTask(
            id: id, title: "Task", status: "in_progress", phase: "IN_PROGRESS", priority: "none", project: "Walnut",
            dueDate: nil, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", completedAt: nil,
            starred: nil, pinned: nil, tags: nil, summary: "See /tmp/run/report.md", parentTaskId: nil, userStatus: nil
        )
        if let live {
            t.liveActivity = WalnutLiveActivity(kind: "tool", since: "2026-11-01T00:00:00Z", sessionId: live)
        }
        return t
    }

    private func session(_ id: String, taskId: String?, host: String, cwd: String?, at: String = "2026-11-01T01:00:00Z") -> WalnutSession {
        WalnutSession(
            id: id, title: "s", taskId: taskId, taskTitle: "Task", project: nil, host: host,
            processStatus: "idle", model: nil, mode: nil, startedAt: "2026-11-01T00:00:00Z", lastActiveAt: at,
            messageCount: 1, cwd: cwd, pinned: nil, focusTier: nil, description: nil
        )
    }

    private func route(explicit: LinkSource = LinkSource(), task: WalnutTask?, lookup: ScriptedLookup?)
        async -> (route: ClickedPathRoute, asked: [LinkSource]) {
        var asked: [LinkSource] = []
        let route = await LinkSourceResolver.route(ref, explicit: explicit, task: task, lookup: lookup) { ref, from in
            asked.append(from)
            return ClickedPath.route(ref, host: from.host, cwd: from.cwd, sessionID: from.sessionID)
        }
        return (route, asked)
    }

    func testNoTaskLooksUpAsBefore() async {
        let lookup = ScriptedLookup()
        let r = await route(task: nil, lookup: lookup)
        XCTAssertEqual(r.asked, [LinkSource()])
        XCTAssertEqual(lookup.fetches, [])
        XCTAssertEqual(lookup.resolves, [])
    }

    func testAPlaceTheCallerNamesWinsOverTheTask() async {
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s1", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me/work")]
        let named = LinkSource(host: "spare", cwd: "/srv", sessionID: "s9")
        let r = await route(explicit: named, task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [named])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }

    /// The case behind this: the same `/tmp` path on the Mac and on the task's dev box.
    func testAListedRemoteSessionNamesItsHostWithNoRequest() async {
        let lookup = ScriptedLookup()
        lookup.sessions = [
            session("s-old", taskId: "mtask001-0a0a", host: "", cwd: "/Users/me", at: "2026-11-01T00:30:00Z"),
            session("s-new", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me/work"),
            session("s-other", taskId: "mother01-0b0b", host: "spare", cwd: "/srv"),
        ]
        let r = await route(task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [LinkSource(host: "devbox", cwd: "/home/me/work", sessionID: "s-new")])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [], "a listed session needs no request")
    }

    func testTheRunningSessionComesFirstAndIsFetchedWhenNotListed() async {
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s-new", taskId: "mtask001-0a0a", host: "", cwd: "/Users/me")]
        lookup.byId = ["s-live": session("s-live", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me")]
        let r = await route(task: task(live: "s-live"), lookup: lookup)
        XCTAssertEqual(lookup.resolves, ["s-live"])
        XCTAssertEqual(r.asked, [LinkSource(host: "devbox", cwd: "/home/me", sessionID: "s-live")])
    }

    func testDrawingAsksNothingAndATapAsksTheTaskOnce() async {
        let lookup = ScriptedLookup()
        lookup.fetchAnswer = ["s1", "s2"]
        lookup.byId = ["s2": session("s2", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me")]
        XCTAssertEqual(LinkSourceResolver.step(for: task(), sessions: [], knownSessionIds: nil),
                       .probe(taskId: "mtask001-0a0a"))
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
        let r = await route(task: task(), lookup: lookup)
        XCTAssertEqual(lookup.fetches, ["mtask001-0a0a"])
        XCTAssertEqual(lookup.resolves, ["s2"], "the newest of the ids the detail reported")
        XCTAssertEqual(r.asked.first?.host, "devbox")
    }

    func testATaskWithNoSessionOpensNothingFromAnyMachine() async {
        for script in [
            { (l: ScriptedLookup) in l.known = ["mtask001-0a0a": []] },
            { (l: ScriptedLookup) in l.fetchAnswer = [] },
        ] {
            let lookup = ScriptedLookup()
            script(lookup)
            let r = await route(task: task(), lookup: lookup)
            XCTAssertEqual(r.asked, [], "the locate closure never ran: no machine is known")
            XCTAssertEqual(lookup.resolves, [])
            guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
            XCTAssertNotNil(target.missing, "the viewer reads nothing")
            XCTAssertNil(target.host)
        }
    }

    func testAnUnreadableSessionOpensNothingFromAnyMachine() async {
        for script in [
            { (l: ScriptedLookup) in l.fetchAnswer = nil },
            { (l: ScriptedLookup) in l.known = ["mtask001-0a0a": ["s-gone"]] },
        ] {
            let lookup = ScriptedLookup()
            script(lookup)
            let r = await route(task: task(), lookup: lookup)
            XCTAssertEqual(r.asked, [], "no lookup on a guessed machine")
            guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
            XCTAssertNotNil(target.missing, "the viewer reads nothing")
            XCTAssertNil(target.host)
        }
    }

    func testWithNoStoreATaskOrANamedSessionOpensNothing() async {
        let cases: [(LinkSource, WalnutTask?)] = [(LinkSource(), task()), (LinkSource(sessionID: "s7"), nil), (LinkSource(sessionID: "s7"), task())]
        for (explicit, t) in cases {
            let r = await route(explicit: explicit, task: t, lookup: nil)
            XCTAssertEqual(r.asked, [], "no lookup on a guessed machine: \(explicit)")
            guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
            XCTAssertNotNil(target.missing)
        }
        let plain = await route(task: nil, lookup: nil)
        XCTAssertEqual(plain.asked, [LinkSource()])
        let primary = await route(explicit: LinkSource(host: ""), task: task(), lookup: nil)
        XCTAssertEqual(primary.asked, [LinkSource(host: "")], "a named machine needs no store")
    }

    // MARK: - Letters

    private func letter(_ sender: String, thread: String = "[]") throws -> Letter {
        try JSONDecoder().decode(Letter.self, from: Data("""
        {"id":"lt-m9x2k1-a4f7","subject":"s","type":"info","sender":\(sender),"thread":\(thread)}
        """.utf8))
    }

    func testALetterNamesItsSendersMachine() throws {
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":"devbox"}"#).linkSource,
                       LinkSource(host: "devbox", sessionID: "s1"))
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":"local"}"#).linkSource,
                       LinkSource(host: "", sessionID: "s1"), "local is the primary, named, not unknown")
        XCTAssertTrue(try letter(#"{"sessionId":"s1","host":"__local__"}"#).linkSource.hostKnown)
        XCTAssertFalse(try letter(#"{"sessionId":"s1"}"#).linkSource.hostKnown, "no host on the letter")
        XCTAssertEqual(try letter(#"{"sessionId":"external"}"#).linkSource, .unknown, "Walnut or a plugin naming no host: not known")
    }

    func testAThreadTurnTakesItsWritingSessionBeforeItsFromLabel() throws {
        let l = try letter(#"{"sessionId":"s1","host":"devbox"}"#, thread: """
        [{"from":"agent","text":"a"},{"from":"human","text":"b"},
         {"from":"human","text":"c","by":{"sessionId":"s7","taskId":"mpeer001-0c0c","name":"Peer"}},
         {"from":"human","text":"d","by":{"sessionId":"s1","taskId":"mtask001-0a0a","name":"Sender"}},
         {"from":"human","text":"e","by":{"sessionId":" "}}]
        """)
        let turns = l.threadEntries
        XCTAssertEqual(turns.count, 5)
        XCTAssertEqual(l.linkSource(for: turns[0]), .unknown, "an old agent turn names no writer: never the letter's sender")
        XCTAssertEqual(l.linkSource(for: turns[1]), LinkSource(host: "__local__"))
        XCTAssertEqual(l.linkSource(for: turns[2]), LinkSource(sessionID: "s7"))
        XCTAssertEqual(l.linkSource(for: turns[3]), LinkSource(host: "devbox", sessionID: "s1"))
        XCTAssertEqual(l.linkSource(for: turns[4]), LinkSource(host: "__local__"))
        for person in [turns[1], turns[4]] {
            let source = l.linkSource(for: person)
            XCTAssertTrue(source.hostKnown, "a person's own words name the primary, not an unknown machine")
            XCTAssertNil(source.host, "the primary, as locate expects it")
            XCTAssertNil(source.sessionID)
        }
        XCTAssertEqual(turns.map(\.isPersonWritten), [false, true, false, false, true])
    }

    func testAPersonsTurnOpensOnThePrimaryWithNoLookup() async throws {
        let l = try letter(#"{"sessionId":"s1","host":"devbox"}"#, thread: #"[{"from":"human","text":"b"}]"#)
        let lookup = ScriptedLookup()
        let r = await route(explicit: l.linkSource(for: l.threadEntries[0]), task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [LinkSource(host: "__local__")], "asked on the primary, not dropped as unknown")
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
        guard case .text(let target) = r.route else { return XCTFail("text") }
        XCTAssertNil(target.missing)
    }

    func testAnAgentTurnOpensFromTheWriterTheServerRecorded() throws {
        let l = try letter(#"{"sessionId":"s1","host":"devbox"}"#, thread: """
        [{"from":"agent","text":"a","sender":{"sessionId":"s9","host":"spare"}},
         {"from":"agent","text":"b","sender":{"sessionId":"s8"}},
         {"from":"agent","text":"c","sender":{"sessionId":"external","host":"local"}},
         {"from":"agent","text":"d","sender":{"sessionId":"s1","host":"local"}},
         {"from":"agent","text":"e","sender":{}}]
        """)
        let turns = l.threadEntries
        XCTAssertEqual(turns.map { l.linkSource(for: $0) }, [
            LinkSource(host: "spare", sessionID: "s9"),
            LinkSource(sessionID: "s8"),
            .primary,
            LinkSource(host: "", sessionID: "s1"),
            .unknown,
        ])
        XCTAssertFalse(l.linkSource(for: turns[1]).hostKnown, "a session with no host is looked up on tap")
    }

    func testOldAgentTurnOpensNothingAndAsksNothing() async throws {
        let l = try letter(#"{"sessionId":"s1","host":"devbox"}"#, thread: #"[{"from":"agent","text":"a"}]"#)
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s1", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me")]
        let r = await route(explicit: l.linkSource(for: l.threadEntries[0]), task: task(live: "s1"), lookup: lookup)
        XCTAssertEqual(r.asked, [])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }

    func testALetterHostLabelNeverCallsAnUnknownMachineTheMac() throws {
        XCTAssertEqual(try letter(#"{"sessionId":"s1"}"#).hostLabel, Letter.unknownHostLabel)
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":""}"#).hostLabel, Letter.unknownHostLabel)
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":"local"}"#).hostLabel, "Mac")
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":"devbox"}"#).hostLabel, "devbox")
        XCTAssertEqual(try letter(#"{"sessionId":"external"}"#).hostLabel, "Mac", "an external agent: as before")
    }

    // MARK: - A session named without its host

    func testAPeerReplyFindsItsSessionsMachineOnTap() async throws {
        let l = try letter(#"{"sessionId":"s1","host":""}"#, thread: #"[{"from":"human","text":"c","by":{"sessionId":"s7","taskId":"mpeer001-0c0c","name":"Peer"}}]"#)
        let lookup = ScriptedLookup()
        lookup.byId = ["s7": session("s7", taskId: "mpeer001-0c0c", host: "devbox", cwd: "/home/me/peer")]
        let r = await route(explicit: l.linkSource(for: l.threadEntries[0]), task: nil, lookup: lookup)
        XCTAssertEqual(lookup.resolves, ["s7"])
        XCTAssertEqual(lookup.resolvedForTask, [nil], "the id alone, no task guessed for it")
        XCTAssertEqual(r.asked, [LinkSource(host: "devbox", cwd: "/home/me/peer", sessionID: "s7")])
    }

    func testANamedCwdIsKeptWhenTheHostIsLookedUp() async {
        let lookup = ScriptedLookup()
        lookup.byId = ["s7": session("s7", taskId: nil, host: "devbox", cwd: "/home/me/peer")]
        let r = await route(explicit: LinkSource(cwd: "/home/me/other", sessionID: "s7"), task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [LinkSource(host: "devbox", cwd: "/home/me/other", sessionID: "s7")])
        XCTAssertEqual(lookup.fetches, [], "the named session wins over the task")
    }

    func testAnUnreadableNamedSessionOpensNothingFromAnyMachine() async {
        let r = await route(explicit: LinkSource(sessionID: "s-gone"), task: nil, lookup: ScriptedLookup())
        XCTAssertEqual(r.asked, [])
        guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
        XCTAssertNotNil(target.missing)
    }

    func testANamedPrimaryNeedsNoLookup() async {
        let lookup = ScriptedLookup()
        let named = LinkSource(host: "local", sessionID: "s1")
        let r = await route(explicit: named, task: task(), lookup: lookup)
        XCTAssertEqual(r.asked, [named])
        XCTAssertNil(r.asked.first?.host, "the primary, as locate expects it")
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }

    // MARK: - The team brief

    private func links(_ s: AttributedString) -> [URL] { s.runs.compactMap(\.link) }

    func testEachTasksFileLinkInTheBriefCarriesItsAsksWriter() throws {
        let letterID = "lt-m9x2k1-a4f7"
        var a = task("ma000001-0a0a", live: "s-now-a"), b = task("mb000002-0b0b")
        a.userStatus = WalnutUserStatus(state: "needs", ask: "Check /tmp/a/report.md.")
        a.userStatus?.source = "session"
        a.userStatus?.askBy = "human"
        b.userStatus = WalnutUserStatus(state: "needs", ask: "Read \(letterID) and https://example.com/x, then /tmp/b/notes.md")
        b.userStatus?.source = "session"
        b.userStatus?.askBy = "self"
        b.userStatus?.askSessionId = "s-old-b"
        b.userStatus?.reportSessionId = "s-now-b"
        var board = TeamStatusBoard()
        board.needs = [a, b].map { TeamStatusRow(task: $0, state: .needs, status: $0.userStatus, depth: 1) }
        let words = TeamStatusSection.briefWords(board)

        XCTAssertEqual(String(words.characters),
                       "Task (Check /tmp/a/report.md); Task (Read \(letterID) and https://example.com/x, then /tmp/b/notes.md).")
        let files = links(words).filter { FilePreviewLink.reference(from: $0) != nil }
        XCTAssertEqual(files.map { FilePreviewLink.reference(from: $0)?.path }, ["/tmp/a/report.md", "/tmp/b/notes.md"])
        // Each from its own ask's writer, never the task's current session.
        XCTAssertEqual(files.map(FilePreviewLink.linkSource(from:)), [.primary, LinkSource(sessionID: "s-old-b")])
        let others = links(words).filter { FilePreviewLink.reference(from: $0) == nil }
        XCTAssertEqual(others.compactMap(LetterMentionLink.letterID(from:)), [letterID])
        XCTAssertTrue(others.contains(URL(string: "https://example.com/x")!))
        XCTAssertTrue(others.allSatisfy { FilePreviewLink.linkSource(from: $0) == nil })
    }

    func testTheTagKeepsTheLineRangeAndIsReplacedNotRepeated() throws {
        let ref = FilePathRef(path: "/tmp/a.ts", line: 12, endLine: 20, column: 3, raw: "/tmp/a.ts:12-20")
        var s = AttributedString("a.ts")
        s.link = try XCTUnwrap(FilePreviewLink.url(for: ref))
        let twice = FilePreviewLink.tagging(FilePreviewLink.tagging(s, source: .primary), source: LinkSource(sessionID: "s-b"))
        let url = try XCTUnwrap(links(twice).first)
        XCTAssertEqual(FilePreviewLink.reference(from: url), ref)
        XCTAssertEqual(FilePreviewLink.linkSource(from: url), LinkSource(sessionID: "s-b"))
        let names = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.map(\.name) ?? []
        XCTAssertEqual(names.filter { $0 == FilePreviewLink.sourceSessionKey }.count, 1)
        XCTAssertFalse(names.contains(FilePreviewLink.sourceHostKey), "the earlier tag is replaced, not kept")
        var bare = AttributedString("notes")
        bare.link = URL(string: "/tmp/b/notes.md")
        let tagged = try XCTUnwrap(links(FilePreviewLink.tagging(bare, source: .primary)).first)
        XCTAssertEqual(FilePreviewLink.reference(from: tagged), FilePathRef(path: "/tmp/b/notes.md"))
        XCTAssertEqual(FilePreviewLink.linkSource(from: tagged), .primary)
    }

    /// A link's own query (an agent can write any) never names the machine, session or task a
    /// plain handler opens from; and tagging strips a forged `sourceTask`.
    func testAForgedQueryIsNeverTrusted() async throws {
        let forgedRef = FilePathRef(path: "/tmp/run/report.md")
        var parts = try XCTUnwrap(URLComponents(url: XCTUnwrap(FilePreviewLink.url(for: forgedRef)), resolvingAgainstBaseURL: false))
        parts.queryItems = (parts.queryItems ?? []) + [
            URLQueryItem(name: FilePreviewLink.sourceTaskKey, value: "mother01-0b0b"),
            URLQueryItem(name: FilePreviewLink.sourceHostKey, value: "elsewhere"),
            URLQueryItem(name: FilePreviewLink.sourceSessionKey, value: "s-forged"),
        ]
        let forged = try XCTUnwrap(parts.url)
        let own = LinkSource(host: "devbox", sessionID: "s1")
        XCTAssertEqual(LinkSourceResolver.explicitSource(for: forged, readsSourceTags: false, own: own), own)
        XCTAssertEqual(LinkSourceResolver.explicitSource(for: forged, readsSourceTags: false, own: LinkSource()), LinkSource(),
                       "an empty handler stays empty: its own task, if any, decides")
        // A plain handler with no task and a forged task id: the generic lookup, never the named task.
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s-other", taskId: "mother01-0b0b", host: "spare", cwd: "/srv")]
        let r = await route(explicit: LinkSourceResolver.explicitSource(for: forged, readsSourceTags: false, own: LinkSource()),
                            task: nil, lookup: lookup)
        XCTAssertEqual(r.asked, [LinkSource()])
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
        // Tagged text: the phone's own tag, the forged ones gone.
        var text = AttributedString("report.md")
        text.link = forged
        let tagged = try XCTUnwrap(links(FilePreviewLink.tagging(text, source: .unknown)).first)
        let names = URLComponents(url: tagged, resolvingAgainstBaseURL: false)?.queryItems?.map(\.name) ?? []
        XCTAssertFalse(names.contains(FilePreviewLink.sourceTaskKey))
        XCTAssertEqual(LinkSourceResolver.explicitSource(for: tagged, readsSourceTags: true, own: own), .unknown)
        var untagged = AttributedString("report.md")
        untagged.link = try XCTUnwrap(FilePreviewLink.url(for: forgedRef))
        XCTAssertEqual(LinkSourceResolver.explicitSource(for: try XCTUnwrap(links(untagged).first), readsSourceTags: true, own: own),
                       .unknown, "a tagging handler reads a link with no tag as unknown")
    }

    func testAnExternalSenderWithNoHostOpensNothingAndAsksNothing() async throws {
        let l = try letter(#"{"sessionId":"external"}"#, thread: #"[{"from":"agent","text":"a","sender":{"sessionId":"external"}}]"#)
        XCTAssertEqual(l.linkSource(for: l.threadEntries[0]), .unknown)
        let lookup = ScriptedLookup()
        lookup.sessions = [session("s1", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me")]
        for source in [l.linkSource, l.linkSource(for: l.threadEntries[0])] {
            let r = await route(explicit: source, task: task(live: "s1"), lookup: lookup)
            XCTAssertEqual(r.asked, [], "an external writer with no host was looked up on a guessed machine")
            guard case .text(let target) = r.route else { return XCTFail("one line in the viewer") }
            XCTAssertNotNil(target.missing, "the viewer reads nothing")
        }
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
        XCTAssertEqual(l.hostLabel, "Mac", "the label stays as it was; only the link's source changed")
    }

    func testALetterWithNoSenderIsUnknownAndExternalKeepsItsHost() throws {
        XCTAssertEqual(try letter("null").linkSource, .unknown)
        XCTAssertEqual(try letter("{}").linkSource, .unknown)
        XCTAssertEqual(try letter(#"{"sessionId":"external","host":"devbox"}"#).linkSource, LinkSource(host: "devbox"))
        XCTAssertEqual(try letter(#"{"sessionId":"external","host":"local"}"#).linkSource, .primary)
        XCTAssertEqual(try letter(#"{"sessionId":"s1","host":""}"#).linkSource, LinkSource(sessionID: "s1"),
                       "an empty host is no host: looked up on tap, never the primary by guess")
        let l = try letter(#"{"sessionId":"s1","host":"devbox"}"#, thread: #"[{"from":"agent","text":"a","sender":{"sessionId":"external","host":"devbox"}}]"#)
        XCTAssertEqual(l.linkSource(for: l.threadEntries[0]), LinkSource(host: "devbox"))
    }

    // MARK: - A Brief's code block

    private static let letterMarkdown = "### Working\n\n```\ncat /p/one.ts **b** `x`\n```\n"

    private func briefCode(_ sources: [OrgBriefReply.Letter.Source]?) throws -> (source: LinkSource?, drawn: AttributedString) {
        let blocks = OrgBriefView.taggedBlocks(OrgBriefReply.Letter(text: Self.letterMarkdown, at: "2026-11-07T00:00:00Z", textSources: sources))
        let (block, code) = try XCTUnwrap(blocks.lazy.compactMap { b -> (MarkdownBlock, String)? in
            if case .code(_, let c) = b.kind { return (b, c) }
            return nil
        }.first, "the Brief's code block became another kind of block")
        let literal = MarkdownParser.literalCode(code)
        let drawn = block.codeSource.map { FilePreviewLink.tagging(literal, source: $0) } ?? literal
        XCTAssertEqual(String(drawn.characters), "cat /p/one.ts **b** `x`", "the Brief's code changed its characters")
        return (block.codeSource, drawn)
    }

    private func briefCodeSource(_ sources: [OrgBriefReply.Letter.Source]?) throws -> LinkSource? {
        let drawn = try briefCode(sources).drawn
        let url = try XCTUnwrap(links(drawn).first, "the code's path is no link")
        return FilePreviewLink.linkSource(from: url)
    }

    private func wholeLetter(by: String, sessionId: String?) -> [OrgBriefReply.Letter.Source] {
        [OrgBriefReply.Letter.Source(start: 0, end: (Self.letterMarkdown as NSString).length, by: by, sessionId: sessionId)]
    }

    func testABriefCodeBlockTakesTheWholeLettersWriter() throws {
        XCTAssertEqual(try briefCodeSource(wholeLetter(by: "task:lead", sessionId: "sid-a")), LinkSource(sessionID: "sid-a"))
        XCTAssertEqual(try briefCodeSource(wholeLetter(by: "human", sessionId: nil)), .primary)
        XCTAssertEqual(try briefCodeSource(nil), .unknown, "an older letter names no writer")
    }

    /// Two writers: the path sits inside one writer's span, and is still unknown, never guessed from it.
    func testABriefCodeBlockOfSeveralWritersIsUnknownAndAsksNothing() async throws {
        let length = (Self.letterMarkdown as NSString).length
        let spans = [OrgBriefReply.Letter.Source(start: 0, end: 12, by: "human", sessionId: nil),
                     OrgBriefReply.Letter.Source(start: 12, end: length, by: "task:lead", sessionId: "sid-a")]
        let source = try XCTUnwrap(try briefCodeSource(spans))
        XCTAssertEqual(source, .unknown)
        let lookup = ScriptedLookup()
        lookup.sessions = [session("sid-a", taskId: "mtask001-0a0a", host: "devbox", cwd: "/home/me")]
        let r = await route(explicit: source, task: task(live: "sid-a"), lookup: lookup)
        XCTAssertEqual(r.asked, [], "a code path of several writers was looked up on a guessed machine")
        XCTAssertEqual(lookup.fetches + lookup.resolves, [])
    }
}
