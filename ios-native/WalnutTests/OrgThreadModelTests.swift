import XCTest
@testable import Walnut

/// The phone's Threads rules (OrgThreadModel), the port of `src/core/org/thread-view.ts`
/// (tests/core/org/thread-view.test.ts): which answers are news, which threads he sees, and the
/// sections the page draws. Plus the wire shape of `GET /api/v1/tasks/:id/threads`.
final class OrgThreadModelTests: XCTestCase {
    private static let now = WalnutTask.parseISO("2026-11-04T12:00:00Z")!

    private func thread(_ json: String) throws -> OrgThread {
        try JSONDecoder().decode(OrgThread.self, from: Data(json.utf8))
    }

    private func t(
        _ id: String, state: String = "answered", updated: String = "2026-11-04T10:00:00Z",
        messages: String = "[]", extra: String = ""
    ) throws -> OrgThread {
        try thread(#"{"id":"\#(id)","title":"Title \#(id)","state":"\#(state)","messages":\#(messages),"createdAt":"2026-11-04T09:00:00Z","updatedAt":"\#(updated)"\#(extra)}"#)
    }

    private let answeredOnce = #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"Add a Threads view","via":"chat","answer":{"text":"On it, done by noon.","at":"2026-11-04T09:05:00Z"}}]"#

    func testDecodesTheServersThreadShape() throws {
        let json = #"""
        {"threads":[{"id":"th-1a2b3c","title":"Threads on the phone","ask":"Pick a layout","state":"needs",
          "reply":"Two layouts are ready: <task-ref id=\"abcdefg-1234\" label=\"iOS\"/>","tasks":["abcdefg-1234","zzzzzzz-9999"],
          "messages":[{"id":"tm-1","at":"2026-11-04T09:00:00Z","text":"iOS has no threads","via":"chat","images":["/tmp/a.png"],
            "answer":{"text":"Working on it","at":"2026-11-04T09:01:00Z","about":["abcdefg-1234"]}}],
          "createdAt":"2026-11-04T09:00:00Z","updatedAt":"2026-11-04T09:01:00Z",
          "snoozed":{"until":"2026-11-05T09:00:00Z","at":"2026-11-04T09:02:00Z","by":"human"},
          "pinned":{"at":"2026-11-04T09:03:00Z","by":"human"},"known":{"through":"tm-1","by":"node","at":"x"}}],
         "task_id":"lead","title":"Walnut VP","closed_count":0}
        """#
        let reply = try JSONDecoder().decode(OrgThreadsReply.self, from: Data(json.utf8))
        let th = try XCTUnwrap(reply.threads.first)
        XCTAssertEqual(th.state, "needs")
        XCTAssertEqual(th.messages.first?.answer?.about, ["abcdefg-1234"])
        XCTAssertEqual(th.snoozed?.until, "2026-11-05T09:00:00Z")
        XCTAssertEqual(th.pinned?.by, "human")
        XCTAssertEqual(OrgThreadModel.namedTasks(in: th.reply), ["abcdefg-1234"])
    }

    /// His Follow up went in: the card leaves his view at once, before the next read (2026-11-10,
    /// the user: "ios 和web回复thread都要thread自动消失 至少ios没有这样"), as the server files it.
    func testHisFollowUpTakesTheThreadOutOfHisViewAtOnce() throws {
        for state in ["answered", "needs", "pending"] {
            var th = try t("f", state: state, messages: answeredOnce)
            th.shown = true
            let after = OrgThreadModel.afterHisFollowUp(th)
            XCTAssertEqual(after.state, "working", state)
            XCTAssertFalse(OrgThreadModel.inView(after, shared: [], now: Self.now), state)
            let s = OrgThreadModel.sections([after], now: Self.now)
            XCTAssertTrue(s.open.isEmpty, state)
            XCTAssertEqual(s.inProgress.map(\.id), ["f"], state)
        }
        // Pinned: he keeps it in sight whatever its state.
        var pinned = try t("p", extra: #","pinned":{"at":"2026-11-04T08:00:00Z"}"#)
        pinned.shown = true
        XCTAssertTrue(OrgThreadModel.inView(OrgThreadModel.afterHisFollowUp(pinned), shared: [], now: Self.now))
        // Closed: untouched (a Follow up there opens a new thread on the server).
        let closed = try t("c", extra: #","closed":{"how":"acked","at":"2026-11-04T08:00:00Z","by":"human"}"#)
        XCTAssertEqual(OrgThreadModel.afterHisFollowUp(closed), closed)
    }

    func testAnAnswerIsNewsUntilHeReactsAfterIt() throws {
        let fresh = try t("a", messages: answeredOnce)
        XCTAssertEqual(OrgThreadModel.unread(fresh).map(\.n), [1])
        // He wrote again after the answer: it is context now, and only his new message waits.
        let reacted = try t("a", state: "working", messages: #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"x","answer":{"text":"y","at":"2026-11-04T09:05:00Z"}},{"id":"m2","at":"2026-11-04T09:10:00Z","text":"more"}]"#)
        XCTAssertTrue(OrgThreadModel.unread(reacted).isEmpty)
        XCTAssertEqual(OrgThreadModel.exchanges(reacted).map(\.n), [1, 2])
        // The node marked it known after he reacted elsewhere.
        let known = try t("a", messages: answeredOnce, extra: #","known":{"through":"m1"}"#)
        XCTAssertTrue(OrgThreadModel.unread(known).isEmpty)
    }

    func testOneReplyToTwoMessagesInARowIsOneExchange() throws {
        let both = try t("a", messages: #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"one","answer":{"text":"both","at":"2026-11-04T09:05:00Z"}},{"id":"m2","at":"2026-11-04T09:01:00Z","text":"two","answer":{"text":"both","at":"2026-11-04T09:05:00Z"}}]"#)
        let x = OrgThreadModel.exchanges(both)
        XCTAssertEqual(x.count, 1)
        XCTAssertEqual(x.first?.messages.map(\.id), ["m1", "m2"])
        XCTAssertEqual(OrgThreadModel.quote(x[0]), "\u{201C}one / two\u{201D}")
    }

    func testAReplySharedWithAnotherThreadStaysOffTheCards() throws {
        let reply = #"{"text":"one reply","at":"2026-11-04T09:05:00Z"}"#
        let a = try t("a", state: "working", messages: #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"x","answer":\#(reply)}]"#)
        let b = try t("b", state: "working", messages: #"[{"id":"m2","at":"2026-11-04T09:01:00Z","text":"y","answer":\#(reply)}]"#)
        let shared = OrgThreadModel.sharedAnswers([a, b])
        XCTAssertEqual(shared, ["m1", "m2"])
        XCTAssertTrue(OrgThreadModel.unread(a, shared: shared).isEmpty)
        // Working with nothing new for him: out of his sight.
        XCTAssertFalse(OrgThreadModel.shownToHim(a, shared: shared, now: Self.now))
    }

    func testWhatHisViewShows() throws {
        XCTAssertTrue(OrgThreadModel.shownToHim(try t("n", state: "needs"), now: Self.now))
        XCTAssertTrue(OrgThreadModel.shownToHim(try t("a", state: "answered"), now: Self.now))
        XCTAssertFalse(OrgThreadModel.shownToHim(try t("w", state: "working"), now: Self.now))
        XCTAssertFalse(OrgThreadModel.shownToHim(try t("new", state: "new"), now: Self.now))
        // Pending stays out even with an answer on it (the node judged it no news).
        XCTAssertFalse(OrgThreadModel.shownToHim(try t("p", state: "pending", messages: answeredOnce), now: Self.now))
        // A working thread with an answer he has not reacted to shows.
        XCTAssertTrue(OrgThreadModel.shownToHim(try t("wa", state: "working", messages: answeredOnce), now: Self.now))
        // Pinned shows whatever its state; closed never does.
        XCTAssertTrue(OrgThreadModel.shownToHim(try t("pin", state: "pending", extra: #","pinned":{"at":"2026-11-04T08:00:00Z"}"#), now: Self.now))
        XCTAssertFalse(OrgThreadModel.shownToHim(try t("c", state: "needs", extra: #","closed":{"how":"acked","at":"2026-11-04T08:00:00Z","by":"human"}"#), now: Self.now))
    }

    func testASnoozeHoldsUntilItsDateOrNews() throws {
        let snooze = #","snoozed":{"until":"2026-11-05T09:00:00Z","at":"2026-11-04T09:30:00Z"}"#
        let quiet = try t("s", state: "needs", messages: answeredOnce, extra: snooze)
        XCTAssertTrue(OrgThreadModel.snoozedNow(quiet, now: Self.now))
        XCTAssertFalse(OrgThreadModel.shownToHim(quiet, now: Self.now))
        // Its date passed: back in his view.
        XCTAssertFalse(OrgThreadModel.snoozedNow(quiet, now: WalnutTask.parseISO("2026-11-05T10:00:00Z")!))
        // An answer after the snooze ends it early.
        let news = try t("s", state: "answered", messages: #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"x","answer":{"text":"y","at":"2026-11-04T10:00:00Z"}}]"#, extra: snooze)
        XCTAssertFalse(OrgThreadModel.snoozedNow(news, now: Self.now))
    }

    func testSectionsOrderPinnedFirstThenNewest() throws {
        let threads = [
            try t("old", state: "needs", updated: "2026-11-04T08:00:00Z"),
            try t("new", state: "answered", updated: "2026-11-04T11:00:00Z"),
            try t("pin", state: "working", updated: "2026-11-04T07:00:00Z", extra: #","pinned":{"at":"2026-11-04T07:30:00Z"}"#),
            try t("busy", state: "working"),
            try t("zz", state: "needs", extra: #","snoozed":{"until":"2026-11-06T09:00:00Z","at":"2026-11-04T11:00:00Z"}"#),
            try t("done", state: "answered", extra: #","closed":{"how":"acked","at":"2026-11-04T11:00:00Z","by":"human"}"#),
            // Closed earlier but its last message is the newest: a closed row reads its close time.
            try t("done2", state: "answered", messages: #"[{"id":"m9","at":"2026-11-04T11:30:00Z","text":"x","via":"chat"}]"#,
                  extra: #","closed":{"how":"acked","at":"2026-11-04T10:00:00Z","by":"human"}"#),
        ]
        let s = OrgThreadModel.sections(threads, now: Self.now)
        XCTAssertEqual(s.open.map(\.id), ["pin", "new", "old"])
        XCTAssertEqual(s.snoozed.map(\.id), ["zz"])
        XCTAssertEqual(s.inProgress.map(\.id), ["busy"])
        XCTAssertEqual(s.closed.map(\.id), ["done", "done2"])
        XCTAssertEqual(OrgThreadModel.shownAt(threads[6]), "2026-11-04T10:00:00Z")
        XCTAssertEqual(OrgThreadModel.shownAt(threads[1]), "2026-11-04T11:00:00Z")
    }

    func testAThreadTheNodeOpenedLeadsWithItsPost() throws {
        let opened = try t("o", state: "needs", extra: #","opener":{"text":"A mail needs you","at":"2026-11-04T09:00:00Z","from":"mail","ref":"Invoice"}"#)
        let x = OrgThreadModel.exchanges(opened)
        XCTAssertEqual(x.first?.n, 0)
        XCTAssertFalse(x.first?.known ?? true)
        XCTAssertEqual(OrgThreadModel.fromLabel(opened.opener!), "Mail: Invoice")
        XCTAssertEqual(OrgThreadModel.unread(opened).count, 1)
    }

    func testEditsSendTheWebsFields() throws {
        let encode = { (e: OrgThreadEdit) -> String in
            String(data: try JSONEncoder().encode(e.body), encoding: .utf8) ?? ""
        }
        XCTAssertEqual(try encode(.acknowledge), #"{"close":"acked"}"#)
        XCTAssertEqual(try encode(.reopen), #"{"reopen":true}"#)
        XCTAssertEqual(try encode(.pin(false)), #"{"pin":false}"#)
        XCTAssertEqual(try encode(.snooze("")), #"{"snooze":""}"#)
    }

    func testSnoozeChoicesAreAllLater() {
        let choices = OrgThreadModel.snoozeChoices(now: Self.now)
        XCTAssertEqual(choices.map(\.label), [
            "In 3 hours", "Tomorrow, \(choices[1].until.formatted(date: .omitted, time: .shortened))", "Next week",
        ])
        // The menu writes tomorrow's time as the toast and the snoozed row do ("9:00 AM", never "9 AM").
        XCTAssertFalse(choices[1].label.hasSuffix(" 9 AM"))
        XCTAssertTrue(choices.allSatisfy { $0.until > Self.now })
    }

    func testAFoldedTextKeepsWholeParagraphsAndCutsTablesShort() {
        // Short: shown whole, no fold.
        XCTAssertNil(OrgThreadModel.preview("One short answer.", budget: 280))
        // Whole paragraphs while they fit.
        let paras = String(repeating: "a", count: 100) + "\n\n" + String(repeating: "b", count: 100) + "\n\n" + String(repeating: "c", count: 200)
        XCTAssertEqual(OrgThreadModel.preview(paras, budget: 280), String(repeating: "a", count: 100) + "\n\n" + String(repeating: "b", count: 100))
        // A table first keeps its header and two rows.
        let table = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n" + String(repeating: "| x | y |\n", count: 40)
        XCTAssertEqual(OrgThreadModel.preview(table, budget: 100), "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |")
        // A long first paragraph is cut at a word, never inside a task pill.
        let pill = String(repeating: "word ", count: 50) + "<task-ref id=\"abc\" label=\"x\"/> tail"
        let cut = OrgThreadModel.preview(pill, budget: 255) ?? ""
        XCTAssertTrue(cut.hasSuffix("\u{2026}"))
        XCTAssertFalse(cut.contains("<"))
        // A long code block keeps its first lines and is closed again.
        let code = "```\n" + (1...30).map { "line \($0)" }.joined(separator: "\n") + "\n```"
        let shown = OrgThreadModel.preview(code, budget: 50) ?? ""
        XCTAssertTrue(shown.hasPrefix("```\nline 1"))
        XCTAssertTrue(shown.hasSuffix("\n```"))
        // Chinese folds by its width: 120 characters are 240 columns.
        XCTAssertEqual(OrgThreadModel.width("\u{4E2D}a"), 3)
        XCTAssertNotNil(OrgThreadModel.preview(String(repeating: "\u{4E2D}", count: 120), budget: 200))
    }

    func testTwoTaskPillsSideBySideInTheBriefGetADotBetween() {
        let text = #"- <task-ref id="a" label="A"/> <task-ref id="vp" label="VP"/>：words <task-ref id="b" label="B"/>"#
        XCTAssertEqual(OrgBriefView.separatingRefs(text), #"- <task-ref id="a" label="A"/> · <task-ref id="vp" label="VP"/>：words <task-ref id="b" label="B"/>"#)
    }

    func testAnActionSaysWhereItsThreadWent() throws {
        let threads = [
            try t("open", state: "needs"),
            try t("busy", state: "working"),
            try t("zz", state: "needs", extra: #","snoozed":{"until":"2026-11-04T15:00:00Z","at":"2026-11-04T11:00:00Z"}"#),
            try t("done", state: "answered", extra: #","closed":{"how":"acked","at":"2026-11-04T11:00:00Z","by":"human"}"#),
        ]
        XCTAssertNil(OrgThreadModel.movedNotice("open", threads: threads, now: Self.now))
        XCTAssertEqual(OrgThreadModel.movedNotice("busy", threads: threads, now: Self.now), "Moved to In progress")
        XCTAssertEqual(OrgThreadModel.movedNotice("zz", threads: threads, now: Self.now)?.hasPrefix("Snoozed until "), true)
        // The toast and the snoozed row say the time the same way.
        let snoozedRow = threads.first { $0.id == "zz" }!.snoozed!
        XCTAssertEqual(OrgThreadModel.movedNotice("zz", threads: threads, now: Self.now), "Snoozed until \(OrgThreadModel.backAt(snoozedRow.until, now: Self.now))")
        XCTAssertEqual(OrgThreadModel.movedNotice("done", threads: threads, now: Self.now), "Closed. It is under Closed this week")
    }

    func testAPreviewCutAtAListMarkerEndsOnTheItemBefore() {
        // The reviewer's card: the answer's list was cut right after the second item's "-".
        let list = "- " + String(repeating: "a", count: 60) + "\n- " + String(repeating: "b", count: 60)
        let cut = OrgThreadModel.cutAtWord(list, max: 65)
        XCTAssertEqual(cut, "- " + String(repeating: "a", count: 60) + "\u{2026}")
        XCTAssertFalse(cut.contains("\n-"))
        XCTAssertEqual(OrgThreadModel.cutAtWord("1. one two\n2. three", max: 14), "1. one two\u{2026}")
        XCTAssertTrue(OrgThreadModel.isBareListMarker("  3) "))
        XCTAssertFalse(OrgThreadModel.isBareListMarker("- words"))
    }

    // MARK: - The list and the header count agree (2026-11-06: "Threads 4" over an empty page)

    func testTheServersShownDecidesTheListWhenSent() throws {
        // The port alone would show an answered thread and hide a working one with nothing new;
        // the server judged over every thread (an answer shared with a closed one) says otherwise.
        let answered = try t("th-000001", state: "answered", extra: #","shown":false"#)
        let working = try t("th-000002", state: "working", extra: #","shown":true"#)
        let older = try t("th-000003", state: "needs")
        let s = OrgThreadModel.sections([answered, working, older], now: Self.now)
        XCTAssertEqual(Set(s.open.map(\.id)), ["th-000002", "th-000003"])
        XCTAssertEqual(s.inProgress.map(\.id), ["th-000001"])
        XCTAssertTrue(s.snoozed.isEmpty)
    }

    func testAReplyCarriesTheServersCountAndCutAnswers() throws {
        let json = #"""
        {"threads":[{"id":"th-1a2b3c","title":"T","state":"answered","shown":true,
          "messages":[{"id":"tm-1","at":"2026-11-04T09:00:00Z","text":"q","answer":{"text":"long\u2026","at":"2026-11-04T09:01:00Z","clipped":true}}],
          "createdAt":"2026-11-04T09:00:00Z","updatedAt":"2026-11-04T09:01:00Z"}],
         "closed_count":151,"shown_count":4}
        """#
        let reply = try JSONDecoder().decode(OrgThreadsReply.self, from: Data(json.utf8))
        XCTAssertEqual(reply.shown_count, 4)
        XCTAssertEqual(reply.closed_count, 151)
        XCTAssertEqual(reply.threads.first?.shown, true)
        let answer = try XCTUnwrap(reply.threads.first?.messages.first?.answer)
        XCTAssertTrue(OrgThreadModel.answerText(answer).contains("the whole answer is in the chat"))
        let whole = OrgThreadMessage.Answer(text: "short", at: "x")
        XCTAssertEqual(OrgThreadModel.answerText(whole), "short")
        // A cut answer in it: opening its Conversation reads the thread whole.
        XCTAssertTrue(OrgThreadModel.hasCutAnswer(try XCTUnwrap(reply.threads.first)))
        XCTAssertFalse(OrgThreadModel.hasCutAnswer(try t("th-000009", messages: answeredOnce)))
    }

    func testAReadThatBroughtNoneOfTheCountedThreadsIsNotEmpty() {
        // The companion answered an empty list while the node's status counted four.
        XCTAssertEqual(OrgThreadModel.unreadCount(serverCount: nil, nodeCount: 4, read: 0), 4)
        // The server's own count of the same read wins: the last one was just acknowledged.
        XCTAssertNil(OrgThreadModel.unreadCount(serverCount: 0, nodeCount: 1, read: 0))
        XCTAssertEqual(OrgThreadModel.unreadCount(serverCount: 2, nodeCount: 0, read: 0), 2)
        XCTAssertNil(OrgThreadModel.unreadCount(serverCount: nil, nodeCount: 4, read: 3))
        XCTAssertNil(OrgThreadModel.unreadCount(serverCount: nil, nodeCount: nil, read: 0))
    }
    func testTheServersSharedMarkHoldsWhenTheOtherThreadIsNotInTheRead() throws {
        // The thread its reply is shared with is closed and not in this read: only the server can tell.
        let msg = #"[{"id":"m1","at":"2026-11-04T09:00:00Z","text":"q","shared":true,"answer":{"text":"One reply","at":"2026-11-04T09:05:00Z"}}]"#
        let alone = try t("th-000011", state: "working", messages: msg)
        XCTAssertTrue(OrgThreadModel.sharedAnswers([alone]).contains("m1"))
        let plain = try t("th-000012", state: "working", messages: answeredOnce)
        XCTAssertTrue(OrgThreadModel.sharedAnswers([plain]).isEmpty)
    }

    func testASnoozeThatRanOutSinceTheReadIsJudgedNow() throws {
        // The server said hidden while it was put aside; its date has passed since, so it shows.
        let woke = try t("th-000013", state: "answered",
                         extra: #","shown":false,"snoozed":{"until":"2026-11-04T11:00:00Z","at":"2026-11-04T08:00:00Z"}"#)
        XCTAssertTrue(OrgThreadModel.inView(woke, shared: [], now: Self.now))
        let still = try t("th-000014", state: "answered",
                          extra: #","shown":false,"snoozed":{"until":"2026-11-04T13:00:00Z","at":"2026-11-04T08:00:00Z"}"#)
        XCTAssertFalse(OrgThreadModel.inView(still, shared: [], now: Self.now))
        XCTAssertEqual(OrgThreadModel.sections([still], now: Self.now).snoozed.map(\.id), ["th-000014"])
    }
    func testTheJumpBarStaysWhenTheLastCardForHimIsGone() throws {
        let closed = try t("th-000021", extra: #","closed":{"how":"acked","at":"2026-11-04T10:00:00Z","by":"human"}"#)
        let working = try t("th-000022", state: "working")
        // Acknowledging his last card leaves in-progress and closed threads: the bar stays.
        let s = OrgThreadModel.sections([closed, working], now: Self.now)
        XCTAssertTrue(s.open.isEmpty)
        XCTAssertTrue(s.showsJumps(unreadable: false))
        // A read that brought none of the counted threads says so instead.
        XCTAssertFalse(s.showsJumps(unreadable: true))
        XCTAssertFalse(OrgThreadModel.Sections().showsJumps(unreadable: false))
        let open = OrgThreadModel.sections([try t("th-000023", state: "needs")], now: Self.now)
        XCTAssertTrue(open.showsJumps(unreadable: true))
    }
}
