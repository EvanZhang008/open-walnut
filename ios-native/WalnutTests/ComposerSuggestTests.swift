import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// The `@` and `/` lists every box shares (`ComposerSuggest.swift`,
/// `ComposerSuggestController`): the trigger rules (the web's mention-trigger.ts and
/// slash-trigger.ts), the pick, the `<task-ref/>` markup, the ranking and the `/` loading.
@MainActor
final class ComposerSuggestTests: XCTestCase {
    private func task(_ id: String, _ title: String, project: String = "walnut", pinned: Bool? = nil,
                      done: Bool = false, updated: String = "2026-11-01T00:00:00Z") -> WalnutTask {
        WalnutTask(
            id: id, title: title, status: done ? "done" : "todo", phase: done ? "COMPLETE" : "TODO",
            priority: "none", project: project, dueDate: nil, createdAt: updated, updatedAt: updated,
            completedAt: nil, starred: nil, pinned: pinned, tags: nil, summary: nil
        )
    }

    private func session(_ id: String, title: String?, taskId: String?, status: String = "idle") -> WalnutSession {
        WalnutSession(
            id: id, title: title, taskId: taskId, taskTitle: nil, project: nil, host: "", processStatus: status,
            model: nil, mode: nil, startedAt: "2026-11-01T00:00:00Z", lastActiveAt: "2026-11-02T00:00:00Z",
            messageCount: 0, cwd: "/work/repo", pinned: nil, focusTier: nil, description: nil
        )
    }

    private func end(_ s: String) -> Int { (s as NSString).length }

    // MARK: - Trigger

    func testMentionOpensAtStartOrAfterSpaceOnly() {
        XCTAssertEqual(ComposerTrigger.detect(in: "@", caret: 1), .mention(start: 0, query: ""))
        XCTAssertEqual(ComposerTrigger.detect(in: "ask @log", caret: 8), .mention(start: 4, query: "log"))
        XCTAssertNil(ComposerTrigger.detect(in: "mail a@b", caret: 8), "an address is no mention")
        XCTAssertNil(ComposerTrigger.detect(in: "see @[Fix login] ", caret: 16), "a token already in the box is no lookup")
        XCTAssertNil(ComposerTrigger.detect(in: "", caret: 0))
    }

    func testMentionGrowsAcrossSpacesOnlyWhileOpen() {
        let text = "@login bug"
        XCTAssertNil(ComposerTrigger.detect(in: text, caret: end(text)), "a stray @ never captures the sentence")
        XCTAssertEqual(ComposerTrigger.detect(in: text, caret: end(text), openMentionAt: 0), .mention(start: 0, query: "login bug"))
        XCTAssertNil(ComposerTrigger.detect(in: "@login  bug", caret: 11, openMentionAt: 0), "a double space ends it")
        XCTAssertNil(ComposerTrigger.detect(in: "@a b c d e f g h", caret: 16, openMentionAt: 0), "more than six words is prose")
    }

    func testCommandRules() {
        XCTAssertEqual(ComposerTrigger.detect(in: "/rev", caret: 4), .command(start: 0, query: "rev"))
        XCTAssertNil(ComposerTrigger.detect(in: "then /", caret: 6), "a command runs only at the start of a message")
        XCTAssertNil(ComposerTrigger.detect(in: "Answer: /rev", caret: 12), "a / after words opens no list")
        XCTAssertNil(ComposerTrigger.detect(in: "src/foo", caret: 7), "a path inside a word is no command")
        XCTAssertNil(ComposerTrigger.detect(in: "/Users/me", caret: 9), "a second slash is a path")
        XCTAssertNil(ComposerTrigger.detect(in: "/review it", caret: 10), "the command name ended")
        XCTAssertNil(ComposerTrigger.detect(in: "/rev", caret: 4, commands: false), "a box with no session has no /")
    }

    func testCaretInsideTheTextAndUnicodeOffsets() {
        // UTF-16 offsets: each CJK character is one unit, an emoji two.
        let text = "\u{4F60}\u{597D} \u{1F600} @\u{4EFB}\u{52A1} tail"
        let at = (text as NSString).range(of: "@").location
        let caret = at + 3
        XCTAssertEqual(ComposerTrigger.detect(in: text, caret: caret), .mention(start: at, query: "\u{4EFB}\u{52A1}"))
        XCTAssertNil(ComposerTrigger.detect(in: "@foo\nbar", caret: 8), "a new line ends the lookup")
    }

    func testMayOpenLooksOnlyAtTheEnd() {
        XCTAssertTrue(ComposerTrigger.mayOpen("hello @"))
        XCTAssertTrue(ComposerTrigger.mayOpen("run /"))
        XCTAssertFalse(ComposerTrigger.mayOpen("@start " + String(repeating: "x", count: 200)))
        XCTAssertFalse(ComposerTrigger.mayOpen("plain words"))
    }

    // MARK: - Pick and markup

    func testPickingATaskInsertsItsTokenAndSendsItsTag() {
        let row = ComposerSuggestion(kind: .task, id: "mtask001-0a0a", title: "Fix the \"login\" [bug]")
        let text = "please see @fix and reply"
        let trigger = ComposerTrigger.mention(start: 11, query: "fix")
        let result = ComposerRefs.apply(row, to: text, trigger: trigger)
        XCTAssertEqual(result.text, "please see @[Fix the \"login\" bug] and reply", "a space follows already: no second one")
        XCTAssertEqual(result.caret, (result.text as NSString).range(of: "] ").location + 2)
        let table = [result.entry!.label: result.entry!.tag]
        XCTAssertEqual(
            ComposerRefs.compose(result.text, table: table),
            #"please see <task-ref id="mtask001-0a0a" label="Fix the &quot;login&quot; [bug]"/> and reply"#
        )
        XCTAssertEqual(ComposerRefs.compose("@[Someone else] hi", table: table), "@[Someone else] hi", "an unknown token is the user's text")
    }

    func testPickingASessionAndACommand() {
        let s = ComposerSuggestion(kind: .session, id: "sess-1", title: "Night build")
        let r1 = ComposerRefs.apply(s, to: "@ni", trigger: .mention(start: 0, query: "ni"))
        XCTAssertEqual(r1.text, "@[Night build] ")
        XCTAssertEqual(r1.entry?.tag, #"<session-ref id="sess-1" label="Night build"/>"#)
        let c = ComposerSuggestion(kind: .command, id: "review", title: "/review")
        let r2 = ComposerRefs.apply(c, to: "/rev", trigger: .command(start: 0, query: "rev"))
        XCTAssertEqual(r2.text, "/review ")
        XCTAssertEqual(r2.caret, 8)
        XCTAssertNil(r2.entry)
    }

    func testTwoReferencesWithOneTitleEachSendTheirOwnTag() {
        let a = ComposerSuggestion(kind: .task, id: "mtask001-0a0a", title: "Fix login")
        let b = ComposerSuggestion(kind: .task, id: "mtask002-0b0b", title: "Fix login")
        let r1 = ComposerRefs.apply(a, to: "@fi", trigger: .mention(start: 0, query: "fi"))
        var table = [r1.entry!.label: r1.entry!.tag]
        let t2 = r1.text + "@fi"
        let r2 = ComposerRefs.apply(b, to: t2, trigger: .mention(start: (r1.text as NSString).length, query: "fi"), table: table)
        XCTAssertEqual(r2.entry?.label, "Fix login · 0b0b")
        table[r2.entry!.label] = r2.entry!.tag
        let sent = ComposerRefs.compose(r2.text, table: table)
        XCTAssertTrue(sent.contains(#"id="mtask001-0a0a""#) && sent.contains(#"id="mtask002-0b0b""#), sent)
        let again = ComposerRefs.apply(a, to: "@fi", trigger: .mention(start: 0, query: "fi"), table: table)
        XCTAssertEqual(again.entry?.label, "Fix login", "the same task keeps its own label")
        let split = ComposerRefs.inline(sent)
        XCTAssertEqual(ComposerRefs.compose(split.body, table: split.table), sent, "an edit of both keeps both")
    }

    func testTagsComeBackAsTokensForAnEdit() {
        let sent = #"see <task-ref id="mtask001-0a0a" label="Fix &quot;it&quot;"/> now"#
        let split = ComposerRefs.inline(sent)
        XCTAssertEqual(split.body, "see @[Fix \"it\"] now")
        XCTAssertEqual(ComposerRefs.compose(split.body, table: split.table), sent)
    }

    // MARK: - Ranking

    func testEmptyQueryLeadsWithPinnedThenLiveThenOpenThenNewest() {
        let tasks = [
            task("t-old", "Old one", updated: "2026-10-01T00:00:00Z"),
            task("t-new", "New one", updated: "2026-11-10T00:00:00Z"),
            task("t-done", "Done one", done: true, updated: "2026-11-15T00:00:00Z"),
            task("t-pin", "Pinned one", pinned: true, updated: "2026-09-01T00:00:00Z"),
            task("t-live", "Live one", updated: "2026-08-01T00:00:00Z"),
            task("t-self", "The asking task"),
        ]
        let sessions = [session("s-live", title: nil, taskId: "t-live", status: "running"),
                        session("s-free", title: "Loose session", taskId: nil)]
        let c = MentionRanking.candidates(tasks: tasks, sessions: sessions, selfTaskId: "t-self")
        XCTAssertFalse(c.contains { $0.suggestion.id == "t-self" }, "a box never offers its own task")
        XCTAssertFalse(c.contains { $0.suggestion.id == "s-live" }, "a task's session is its task")
        let ids = MentionRanking.rank("", c).map(\.id)
        XCTAssertEqual(Array(ids.prefix(2)), ["t-pin", "t-live"])
        XCTAssertEqual(ids.last, "t-done")
        XCTAssertTrue(ids.contains("s-free"))
        XCTAssertEqual(c.first { $0.suggestion.id == "t-live" }?.suggestion.live, true)
    }

    func testQueryMatchesTitleWordsAndIds() {
        let tasks = [task("mabc1234-0a0a", "Deploy the login fix"), task("mxyz9999-0b0b", "Login page copy"),
                     task("mqqq0000-0c0c", "Unrelated")]
        let c = MentionRanking.candidates(tasks: tasks, sessions: [], selfTaskId: nil)
        XCTAssertEqual(MentionRanking.rank("login", c).map(\.id), ["mxyz9999-0b0b", "mabc1234-0a0a"], "a title that starts with it leads")
        XCTAssertEqual(MentionRanking.rank("fix deploy", c).map(\.id), ["mabc1234-0a0a"], "every word, any order")
        XCTAssertEqual(MentionRanking.rank("mqqq", c).map(\.id), ["mqqq0000-0c0c"], "an id prefix finds its task")
        XCTAssertTrue(MentionRanking.rank("nothing-like-it", c).isEmpty)
    }

    func testServerHitsReRankWithoutDroppingLocalRows() throws {
        let tasks = [task("t-a", "Alpha"), task("t-b", "Beta"), task("t-c", "OAuth callback 401")]
        let c = MentionRanking.candidates(tasks: tasks, sessions: [], selfTaskId: "t-self")
        let local = MentionRanking.rank("a", c)
        let json = #"[{"type":"session","id":"s-9","taskId":"t-c","title":"x"},{"type":"task","id":"t-b","title":"Beta"},{"type":"task","id":"t-self","title":"Self"}]"#
        let hits = try JSONDecoder().decode([GlobalSearchResult].self, from: Data(json.utf8))
        let merged = MentionRanking.merge(local: local, hits: hits, candidates: c, selfTaskId: "t-self").map(\.id)
        XCTAssertEqual(merged.first, "t-c", "a session hit is its task, and both lists agree on it")
        XCTAssertFalse(merged.contains("t-self"))
        XCTAssertEqual(Set(merged), Set(["t-a", "t-b", "t-c"]))
    }

    func testCommandRanking() {
        let cmds = [SlashCommand(name: "commit", description: "Commit the change"),
                    SlashCommand(name: "review", description: "Review the diff"),
                    SlashCommand(name: "pre-review", description: nil),
                    SlashCommand(name: "deploy", description: "Ship after review")]
        XCTAssertEqual(SlashRanking.rank("rev", cmds).map(\.id), ["review", "pre-review", "deploy"])
        XCTAssertEqual(SlashRanking.rank("", cmds).count, 4)
        XCTAssertEqual(SlashRanking.rank("rev", cmds).first?.title, "/review")
    }

    func testSlashCommandsPathNamesOnlyARemoteHost() {
        XCTAssertEqual(WalnutAPI.slashCommandsPath(cwd: nil, host: ""), "/slash-commands")
        XCTAssertEqual(WalnutAPI.slashCommandsPath(cwd: "/w/repo", host: "__local__"), "/slash-commands?cwd=%2Fw%2Frepo")
        XCTAssertEqual(WalnutAPI.slashCommandsPath(cwd: "/w/repo", host: "devbox"), "/slash-commands?cwd=%2Fw%2Frepo&host=devbox")
    }

    // MARK: - Controller

    /// The controller holds its store weakly (the app owns it), so a case that drops the
    /// helper's store (`let (c, _) = controller(...)`) would see an empty `@` list: the test
    /// case keeps every store it built alive.
    private var heldStores: [TasksStore] = []

    private func controller(tasks: [WalnutTask] = [], commands: [SlashCommand] = [], fail: Bool = false) -> (ComposerSuggestController, TasksStore) {
        ComposerSuggestController.clearCommandCache()
        let store = TasksStore()
        store.feedsTaskMentions = false
        store.tasks = tasks
        let c = ComposerSuggestController()
        c.store = store
        heldStores.append(store)
        c.scope = .init(selfTaskId: nil, commands: true, commandsCwd: "/w/repo", commandsHost: "devbox")
        c.search = { _ in [] }
        c.searchDelay = .milliseconds(1)
        c.loadCommands = { _, _ in
            if fail { throw APIError.badResponse }
            return SlashCommandList(items: commands)
        }
        // No draft attached: the table stays in memory (the cases that keep it attach their own).
        return (c, store)
    }

    func testControllerOpensPicksAndComposes() {
        let (c, _) = controller(tasks: [task("mtask001-0a0a", "Fix the login")])
        c.update(text: "hello", caret: 5)
        XCTAssertFalse(c.isOpen)
        c.update(text: "hello @fi", caret: 9)
        XCTAssertEqual(c.trigger, .mention(start: 6, query: "fi"))
        XCTAssertEqual(c.suggestions.map(\.id), ["mtask001-0a0a"])
        let picked = c.pick(c.suggestions[0], currentText: "hello @fi", caret: 9)
        XCTAssertEqual(picked?.text, "hello @[Fix the login] ")
        XCTAssertFalse(c.isOpen)
        c.update(text: picked!.text, caret: picked!.caret)
        XCTAssertFalse(c.isOpen, "the caret after a pick opens nothing")
        XCTAssertEqual(c.outgoing("hello @[Fix the login] "), #"hello <task-ref id="mtask001-0a0a" label="Fix the login"/> "#)
        c.reset()
        XCTAssertEqual(c.outgoing("@[Fix the login]"), "@[Fix the login]")
    }

    func testAFieldWithNoCaretOpensAtTheEndOnly() {
        let (c, _) = controller(tasks: [task("t1", "One")])
        c.updateAtEnd(String(repeating: "words ", count: 400) + "@on")
        XCTAssertEqual(c.trigger?.query, "on", "a long draft still opens at its end")
        c.updateAtEnd("@on and then much more text that runs on past the lookup")
        XCTAssertFalse(c.isOpen, "an @ far behind the end closes the list")
    }

    func testAClosedListOpensAgainOnceTheWordsMovedOn() {
        let (c, _) = controller(tasks: [task("t1", "One")])
        c.updateAtEnd("@")
        c.dismiss()
        c.updateAtEnd("")
        c.updateAtEnd("@")
        XCTAssertTrue(c.isOpen, "an @ typed after the closed one was erased opens")
    }

    func testClosedListStaysClosedForThatSigilOnly() {
        let (c, _) = controller(tasks: [task("t1", "One")])
        c.update(text: "@o", caret: 2)
        XCTAssertTrue(c.isOpen)
        c.dismiss()
        c.update(text: "@on", caret: 3)
        XCTAssertFalse(c.isOpen, "typing on in the same @ keeps it shut")
        c.update(text: "@on @", caret: 5)
        XCTAssertTrue(c.isOpen, "a new @ opens again")
    }

    func testASendClosesTheListWithoutShuttingTheNextAt() {
        let (c, _) = controller(tasks: [task("t1", "One")])
        c.update(text: "@o", caret: 2)
        c.closeList()
        XCTAssertFalse(c.isOpen)
        c.update(text: "@", caret: 1)
        XCTAssertTrue(c.isOpen, "the emptied box opens on its next @")
    }

    func testCommandsLoadOnceAndFilter() async throws {
        let (c, _) = controller(commands: [SlashCommand(name: "review"), SlashCommand(name: "commit")])
        c.update(text: "/", caret: 1)
        XCTAssertEqual(c.status, .loading)
        for _ in 0..<50 where c.status == .loading { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(c.status, .ready)
        XCTAssertEqual(c.suggestions.map(\.id), ["review", "commit"])
        c.update(text: "/co", caret: 3)
        XCTAssertEqual(c.suggestions.map(\.id), ["commit"], "the cached list filters with no new read")
    }

    func testASlashTypedWhileThePrefetchRunsGetsItsAnswer() async throws {
        let (c, _) = controller()
        c.loadCommands = { _, _ in
            try await Task.sleep(for: .milliseconds(150))
            return SlashCommandList(items: [SlashCommand(name: "review")])
        }
        c.prefetchCommands()
        c.update(text: "/", caret: 1)
        XCTAssertEqual(c.status, .loading)
        for _ in 0..<100 where c.status == .loading { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(c.status, .ready)
        XCTAssertEqual(c.suggestions.map(\.id), ["review"], "the prefetch's answer reaches the open list")
    }

    func testCommandsThatFailSaySo() async throws {
        let (c, _) = controller(fail: true)
        c.update(text: "/", caret: 1)
        for _ in 0..<50 where c.status == .loading { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(c.status, .failed)
        XCTAssertTrue(c.suggestions.isEmpty)
    }

    func testADegradedAnswerIsShownButNeverCached() async throws {
        let (c, _) = controller()
        var reads = 0
        c.loadCommands = { _, _ in
            reads += 1
            return SlashCommandList(items: [], degraded: true)
        }
        c.update(text: "/", caret: 1)
        for _ in 0..<50 where c.status == .loading { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(c.status, .failed, "an empty degraded list says the commands did not load")
        c.update(text: "", caret: 0)
        c.update(text: "/", caret: 1)
        XCTAssertEqual(c.status, .loading, "the next / asks again: nothing was cached")
        for _ in 0..<50 where c.status == .loading { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(reads, 2)
    }

    // MARK: - References survive a rebuilt box

    func testAReferenceSurvivesTheBoxBeingBuiltAgain() {
        let key = "composer-suggest-test:\(UUID().uuidString)"
        defer { ComposerDrafts.shared.setRefs([:], key: key) }
        let (first, store) = controller(tasks: [task("mtask001-0a0a", "Fix the login")])
        first.attach(draftKey: key)
        first.update(text: "see @fi", caret: 7)
        let picked = first.pick(first.suggestions[0], currentText: "see @fi", caret: 7)
        XCTAssertEqual(picked?.text, "see @[Fix the login] ")
        // The draft keeps the words; the box is built again (a row scrolled back, a relaunch).
        let draft = picked!.text + "today"
        let again = ComposerSuggestController()
        again.store = store
        again.attach(draftKey: key)
        XCTAssertEqual(again.outgoing(draft), #"see <task-ref id="mtask001-0a0a" label="Fix the login"/> today"#)
        // Sent and emptied: the next box of this draft sends a token as typed.
        again.reset()
        let third = ComposerSuggestController()
        third.attach(draftKey: key)
        XCTAssertEqual(third.outgoing(draft), draft)
    }

    func testTakenWordsLetOnlyTheirOwnReferencesGo() {
        let key = "composer-suggest-test:\(UUID().uuidString)"
        defer { ComposerDrafts.shared.setRefs([:], key: key) }
        let (c, _) = controller(tasks: [task("t1", "One"), task("t2", "Two")])
        c.attach(draftKey: key)
        c.update(text: "@on", caret: 3)
        let a = c.pick(c.suggestions.first(where: { $0.id == "t1" })!, currentText: "@on", caret: 3)!
        let words = a.text + "@tw"
        c.update(text: words, caret: (words as NSString).length)
        let b = c.pick(c.suggestions.first(where: { $0.id == "t2" })!, currentText: words, caret: (words as NSString).length)!
        XCTAssertEqual(b.text, "@[One] @[Two] ")
        c.forgetRefs(notIn: "@[Two] still here")
        XCTAssertEqual(ComposerDrafts.shared.refs(key).keys.sorted(), ["Two"], "the reference the box still shows stays")
    }

    // MARK: - A pick reads the words as they are now

    func testAPickNeverSwallowsWordsThatCameAfterTheListOpened() {
        let (c, _) = controller(tasks: [task("mtask001-0a0a", "Fix the login")])
        c.update(text: "hi @fi", caret: 6)
        let row = c.suggestions[0]
        // Dictation (or another box of the same draft) added words the caret never reported.
        let now = "hi @fi and the words he just said"
        XCTAssertNil(c.pick(row, currentText: now, caret: (now as NSString).length), "the list no longer stands for the words")
        XCTAssertNil(c.pick(row, currentText: "Note: hi @fi", caret: nil), "the @ moved: nothing is replaced")
        // Still the same words: the pick goes through.
        c.update(text: "hi @fi", caret: 6)
        XCTAssertEqual(c.pick(c.suggestions[0], currentText: "hi @fi", caret: 6)?.text, "hi @[Fix the login] ")
    }

    func testAPickWithNoCaretReadsTheEndOfTheWords() {
        let (c, _) = controller(tasks: [task("mtask001-0a0a", "Fix the login")])
        c.updateAtEnd("hi @fi")
        XCTAssertNil(c.pick(c.suggestions[0], currentText: "hi @fi more", caret: nil), "words came after the @: no pick")
        c.updateAtEnd("hi @fi")
        XCTAssertEqual(c.pick(c.suggestions[0], currentText: "hi @fi", caret: nil)?.text, "hi @[Fix the login] ")
    }

    func testABoxWithNoSessionHasNoCommandList() {
        let (c, _) = controller()
        c.scope = .init(selfTaskId: nil, commands: false)
        c.update(text: "/", caret: 1)
        XCTAssertFalse(c.isOpen)
    }

    // MARK: - The field

    func testReplyFieldReportsTheCaretAndTakesAPick() {
        var reported: [(String, Int)] = []
        var text = ""
        let controller = LetterReplyFieldController()
        let field = LetterReplyField(
            text: Binding(get: { text }, set: { text = $0 }), isFocused: .constant(false), controller: controller,
            onCaretChange: { reported.append(($0, $1)) }
        )
        let coordinator = field.makeCoordinator()
        let view = UITextView()
        view.delegate = coordinator
        controller.attach(view, coordinator: coordinator)
        view.text = "hi @lo"
        view.selectedRange = NSRange(location: 6, length: 0)
        coordinator.textViewDidChange(view)
        XCTAssertEqual(reported.last?.0, "hi @lo")
        XCTAssertEqual(reported.last?.1, 6)
        controller.replace(with: "hi @[Login] ", caret: 12)
        XCTAssertEqual(view.text, "hi @[Login] ")
        XCTAssertEqual(text, "hi @[Login] ")
        XCTAssertEqual(view.selectedRange.location, 12)
        XCTAssertEqual(reported.last?.1, 12)
    }

    // MARK: - Ask card words

    func testEachKindsWordsGoWhereTheWebSends() {
        func item(_ kind: String, question: String? = nil) -> WalnutActionItem {
            var i = WalnutActionItem(kind: kind, id: "i1", summary: "Ship it?")
            i.question = question
            return i
        }
        XCTAssertEqual(ActionNeededModel.words(item("letter"), hasSession: false), .letterReply)
        XCTAssertEqual(ActionNeededModel.words(item("approval"), hasSession: true), .approvalNote)
        XCTAssertEqual(ActionNeededModel.words(item("approval"), hasSession: false), .none)
        XCTAssertEqual(ActionNeededModel.words(item("permission"), hasSession: true), .declineStep)
        XCTAssertEqual(ActionNeededModel.words(item("question", question: "Which?"), hasSession: true), .questionAnswer)
        XCTAssertEqual(ActionNeededModel.words(item("question"), hasSession: true), .none, "several questions answer in the session")
        XCTAssertEqual(ActionNeededModel.words(item("ask"), hasSession: true), .sessionAnswer)
        XCTAssertEqual(ActionNeededModel.words(item("choice"), hasSession: true), .sessionAnswer)
        XCTAssertEqual(ActionNeededModel.answerMessage(summary: "Ship it?", words: "yes, today"), #"Answer to "Ship it?": yes, today"#)
        // A command goes to the session as typed: wrapped, it would never run.
        XCTAssertEqual(ActionNeededModel.sessionMessage(.sessionAnswer, summary: "Ship it?", text: "/review now"), "/review now")
        XCTAssertEqual(ActionNeededModel.sessionMessage(.approvalNote, summary: "Ship it?", text: "/compact"), "/compact")
        XCTAssertEqual(ActionNeededModel.sessionMessage(.sessionAnswer, summary: "Ship it?", text: "yes"), #"Answer to "Ship it?": yes"#)
        XCTAssertEqual(ActionNeededModel.sessionMessage(.approvalNote, summary: "Ship it?", text: "wait"), #"About the approval "Ship it?": wait"#)
        // A tool answer's box lists no commands: none would run there.
        XCTAssertFalse(ActionNeededModel.takesCommands(.declineStep))
        XCTAssertFalse(ActionNeededModel.takesCommands(.questionAnswer))
        XCTAssertTrue(ActionNeededModel.takesCommands(.sessionAnswer))
        XCTAssertTrue(ActionNeededModel.takesCommands(.approvalNote))
    }
}
