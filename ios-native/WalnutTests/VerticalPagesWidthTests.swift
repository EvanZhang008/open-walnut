import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// EVERY PAGE THAT SCROLLS UP AND DOWN IS NO WIDER THAN THE SCREEN.
///
/// 2026-11-15 the user asked why the Org page's Threads moved left and right; 2026-11-20 he asked
/// again, for all of them: "pages that scroll up and down, why do they have to move sideways? These
/// are all bugs, find every one and fix it." A page drags sideways in two ways: iOS 26's content pop
/// (`ReadingPageSwipe.swift`, `VerticalPagesSidewaysDragUITests` drags each page with a finger), or
/// content wider than the screen, which its scroll view then scrolls to. This test is the second.
///
/// Each real page (Org Threads with every fold open, Org Tasks, Org Brief with its freshness head, the Inbox list, a letter,
/// a session's chat, the Notes list, a note, Settings, a task) is laid out in windows 375, 402 and
/// 440 pt wide with `WideText`'s shapes of his longest texts, and its page scrollers must hold
/// nothing wider than themselves (`VerticalPageHarness`). The parts a page is made of are measured
/// too (a thread card, the whole summary its Expand shows, its conversation, a task row, the
/// Brief's text, a letter's body, a note row), each no wider than the column it is given, so their
/// words wrap inside it and a page that did scroll sideways would have no wider content to show.
@MainActor
final class VerticalPagesWidthTests: XCTestCase {
    private typealias H = VerticalPageHarness
    private typealias F = VerticalPagesWidthFixtures

    private var restoreFolds: String?
    private var savedNoteKey: String?

    override func tearDown() {
        if let restoreFolds { AppPrefs.defaults.set(restoreFolds, forKey: "org.threads.openFolds") }
        restoreFolds = nil
        if let savedNoteKey { DiskCache.remove(key: savedNoteKey) }
        savedNoteKey = nil
        super.tearDown()
    }

    // MARK: - Org Threads

    /// The page with Snoozed, In progress and Closed all open, so every card it can list is laid out.
    func testThreadsPageWithEveryFoldOpenNeverScrollsSideways() throws {
        let threads = try F.threads()
        restoreFolds = AppPrefs.defaults.string(forKey: "org.threads.openFolds") ?? ""
        // Snoozed and In progress open from the kept folds; Closed opens for a request to show a closed thread.
        AppPrefs.defaults.set("\(F.vpTaskId)/snoozed \(F.vpTaskId)/inProgress", forKey: "org.threads.openFolds")
        for width in H.widths + [1024] {
            let stores = H.Stores()
            let store = OrgThreadsStore(taskId: F.vpTaskId, threads: threads, cache: nil,
                                        read: { throw URLError(.notConnectedToInternet) })
            for focus in [nil, OrgThreadFocus(threadId: F.closedThreadId, at: Date())] {
                let page = OrgThreadsView(store: store, name: F.name, sessionId: "sess-fixture-vp", focus: focus, cover: .constant(nil))
                let hosted = H.host(H.provided(page, stores), width: width)
                H.assertPageFits(focus == nil ? "Threads" : "Threads with Closed open", hosted)
                hosted.close()
            }
        }
    }

    /// What a card shows once opened fits too: the summary whole (its Expand) and the whole
    /// conversation. His 2026-11-15 screenshot was of an opened summary.
    func testOpenedSummaryAndConversationFitTheColumn() throws {
        let threads = try F.threads()
        let stores = H.Stores()
        for width in H.widths {
            let inner = width - 32 - 28
            for t in threads {
                H.assertFits("at \(width) pt, thread \(t.id)'s whole summary",
                             H.provided(LetterMarkdownBody(markdown: t.reply ?? "").markdownBodyFont(.subheadline), stores), width: inner)
                H.assertFits("at \(width) pt, thread \(t.id)'s conversation",
                             H.provided(OrgThreadConversation(thread: t, shared: [], name: F.name, now: Date()), stores), width: inner)
            }
        }
    }

    /// Each card fits the width it is given, folded or not: the page staying put must not come
    /// from cutting off a card wider than the page.
    func testEachCardFitsTheColumn() throws {
        let threads = try F.threads()
        let stores = H.Stores()
        for width in H.widths {
            for t in threads {
                for snoozed in [false, true] {
                    let card = OrgThreadCard(thread: t, all: threads, shared: [], name: F.name, now: Date(), snoozed: snoozed,
                                             busy: false, canFollowUp: true, onEdit: { _ in }, onOpenTask: { _ in }, onFollowUpOpen: {})
                    H.assertFits("at \(width) pt, card \(t.id)\(snoozed ? " (snoozed)" : "")", H.provided(card, stores), width: width - 32)
                }
            }
        }
    }

    // MARK: - Org Tasks and Brief

    func testOrgTasksPageNeverScrollsSideways() throws {
        let tree = try F.tree()
        for width in H.widths {
            let stores = H.Stores()
            stores.tasks.tasks = F.teamTasks()
            let page = OrgNodeTasksView(nodeId: "vp", isMain: false, onOpenTask: { _ in }, givenTree: tree)
            let hosted = H.host(H.provided(page, stores), width: width)
            H.assertPageFits("Org Tasks", hosted)
            H.assertFits("at \(width) pt, the Org Tasks page", H.provided(page, stores), width: width)
            for t in stores.tasks.tasks {
                H.assertFits("at \(width) pt, task row \(t.id)", H.provided(OrgTaskRow(task: t), stores), width: width - 32)
            }
            hosted.close()
        }
    }

    func testOrgBriefPageNeverScrollsSideways() throws {
        let reply = F.brief()
        let letter = try XCTUnwrap(reply.brief)
        for width in H.widths {
            let stores = H.Stores()
            let page = OrgBriefView(taskId: F.vpTaskId, name: F.name, givenReply: reply)
            let hosted = H.host(H.provided(page, stores), width: width)
            H.assertPageFits("Org Brief", hosted)
            H.assertFits("at \(width) pt, the Org Brief page", H.provided(page, stores), width: width)
            H.assertFits("at \(width) pt, the Brief's text",
                         H.provided(MarkdownView(blocks: OrgBriefView.taggedBlocks(letter), readsSourceTags: true), stores), width: width - 32)
            hosted.close()
        }
    }

    // MARK: - Inbox and a letter

    private func inboxStores() throws -> H.Stores {
        let letters = try F.letters()
        var stores = H.Stores()
        stores.inbox = InboxStore(transport: MockInboxTransport(letters), defaults: UserDefaults(suiteName: "VerticalPagesWidthTests")!)
        stores.inbox.letters = letters
        return stores
    }

    func testInboxListNeverScrollsSideways() throws {
        for width in H.widths {
            let stores = try inboxStores()
            let hosted = H.host(H.provided(InboxView(), stores), width: width)
            H.assertPageFits("Inbox", hosted)
            for letter in stores.inbox.letters {
                H.assertFits("at \(width) pt, the Inbox row of \(letter.id)", H.provided(LetterEnvelopeRow(letter: letter), stores), width: width - 40)
            }
            hosted.close()
        }
    }

    func testLetterReaderNeverScrollsSideways() throws {
        for width in H.widths {
            let stores = try inboxStores()
            let page = NavigationStack { LetterReaderView(letterId: F.letterId) }
            let hosted = H.host(H.provided(page, stores), width: width, settle: 2)
            H.assertPageFits("Letter", hosted)
            for letter in stores.inbox.letters {
                H.assertFits("at \(width) pt, letter \(letter.id)'s body",
                             H.provided(LetterMarkdownBody(markdown: letter.body ?? ""), stores), width: width - 32)
                for (i, turn) in letter.threadEntries.enumerated() {
                    H.assertFits("at \(width) pt, letter \(letter.id)'s turn \(i)",
                                 H.provided(LetterMarkdownBody(markdown: turn.text ?? ""), stores), width: width - 32 - 24)
                }
            }
            hosted.close()
        }
    }

    // MARK: - A session

    /// The chat is a collection view whose layout always reports its own width, so the views in
    /// its cells are checked: none may reach past its sides, a screen at a time down the transcript.
    func testSessionChatNeverReachesPastTheScreen() throws {
        for width in H.widths {
            let stores = H.Stores()
            let store = SessionConversationStore(session: ScriptedSSE.session())
            store.reconcile(F.transcript())
            let page = NavigationStack { SessionConversationView(session: ScriptedSSE.session(), store: store) }
            let hosted = H.host(H.provided(page, stores), width: width, settle: 2)
            H.assertPageFits("Session chat", hosted)
            let timelines = H.pageScrollers(hosted).compactMap { $0 as? UICollectionView }
            XCTAssertFalse(timelines.isEmpty, "at \(width) pt the session page has no timeline")
            for cv in timelines {
                XCTAssertGreaterThan(cv.visibleCells.count, 0, "at \(width) pt the timeline shows no rows")
                let worst = H.widestOverflowScrolling(cv)
                XCTAssertLessThanOrEqual(worst.over, 0.5, "at \(width) pt the session chat reaches \(worst.over) pt past the screen: \(worst.describe)")
            }
            hosted.close()
        }
    }

    // MARK: - Notes

    func testNotesListNeverScrollsSideways() {
        for width in H.widths {
            let stores = H.Stores()
            stores.notes.tree = F.noteTree()
            stores.notes.pinned = [F.notePath]
            for node in F.noteTree() + (F.noteTree().first?.children ?? []) {
                stores.notes.rowMeta[node.path] = .init(preview: WideText.plain, updatedAt: Date())
            }
            let hosted = H.host(H.provided(NotesView(), stores), width: width)
            H.assertPageFits("Notes", hosted)
            H.assertFits("at \(width) pt, a note row",
                         H.provided(NoteCellContent(path: F.notePath, title: WideText.threadTitle), stores), width: width - 72)
            hosted.close()
        }
    }

    /// A note read from its saved copy (the test process reaches no server).
    func testNoteNeverScrollsSideways() {
        let key = "note-\(F.notePath)"
        savedNoteKey = key
        DiskCache.save(F.noteContent, key: key)
        for width in H.widths {
            let stores = H.Stores()
            let page = NavigationStack { NoteDetailView(path: F.notePath) }
            let hosted = H.host(H.provided(page, stores), width: width, settle: 2)
            H.assertPageFits("Note", hosted)
            hosted.close()
        }
    }

    // MARK: - Settings and a task

    func testSettingsNeverScrollsSideways() {
        for width in H.widths {
            let stores = H.Stores()
            stores.connection.serverURL = "https://walnut-someone.example.com/" + WideText.unbrokenPath
            stores.connection.deviceName = "someone's phone " + WideText.cjkThreadVideo + WideText.unbrokenPath
            let hosted = H.host(H.provided(SettingsView(), stores), width: width)
            H.assertPageFits("Settings", hosted)
            hosted.close()
        }
    }

    func testTaskDetailNeverScrollsSideways() {
        let detail = F.taskDetail()
        for width in H.widths {
            let stores = H.Stores()
            let task = F.task(WideText.taskId, user: .init(state: "working", now: WideText.plain))
            stores.tasks.tasks = [task]
            let page = TaskDetailSheet(task: task, detail: detail)
            let hosted = H.host(H.provided(page, stores), width: width)
            H.assertPageFits("Task", hosted)
            hosted.close()
        }
    }
}
