import SwiftUI
import XCTest
@testable import Walnut

/// The prompts that ask about one object at a time (a rename, a first message) keep their words
/// per object: one object's prompt never opens on, and a take finishing late never writes into,
/// another's words. And the Talk page's mic key holds still for one page and differs between two.
@MainActor
final class DictatedPromptDraftTests: XCTestCase {

    // MARK: - Renames (PromptDrafts)

    func testARenameOpensOnTheTitleThenOnHisWords() {
        var drafts = PromptDrafts()
        drafts.open("chat-rename:a", seed: "Old title")
        XCTAssertEqual(drafts["chat-rename:a"], "Old title")
        drafts["chat-rename:a"] = "Old title edited"
        // A push closed the prompt; opening it again keeps his words, not the title.
        drafts.open("chat-rename:a", seed: "Old title")
        XCTAssertEqual(drafts["chat-rename:a"], "Old title edited")
        drafts.end("chat-rename:a")
        drafts.open("chat-rename:a", seed: "New title")
        XCTAssertEqual(drafts["chat-rename:a"], "New title", "Cancel or the answer starts from the title again")
    }

    func testALateTakeForOneChatNeverWritesAnothersRename() {
        var drafts = PromptDrafts()
        drafts.open(ChatDrawer.renameKey(conversation: "a"), seed: "Chat A")
        // A's prompt is cancelled while its take is still transcribed; B's rename opens.
        drafts.end(ChatDrawer.renameKey(conversation: "a"))
        drafts.open(ChatDrawer.renameKey(conversation: "b"), seed: "Chat B")
        // A's words come back through A's own binding.
        drafts[ChatDrawer.renameKey(conversation: "a")] = "spoken for A"
        XCTAssertEqual(drafts[ChatDrawer.renameKey(conversation: "b")], "Chat B")
        XCTAssertEqual(drafts[ChatDrawer.renameKey(conversation: "a")], "spoken for A", "kept for A, never dropped")
    }

    func testAConversationAndAnAskWithOneIdAreTwoObjects() {
        XCTAssertNotEqual(ChatDrawer.renameKey(conversation: "x"), ChatDrawer.renameKey(ask: "x"))
        XCTAssertNotEqual(ChatView.askFirstMessageKey("x"), ChatView.orgFirstMessageKey("x"))
    }

    // MARK: - First messages (PromptDraft, in the draft store)

    func testFirstMessageDraftsAreKeptPerChat() {
        let store = ComposerDrafts.shared
        let id = UUID().uuidString
        let a = ChatView.askFirstMessageKey("a-\(id)")
        let b = ChatView.askFirstMessageKey("b-\(id)")
        defer { store.clear(a); store.clear(b) }
        let forA = PromptDraft.binding(a, prefix: ChatView.askFirstMessagePrefix)
        let forB = PromptDraft.binding(b, prefix: ChatView.askFirstMessagePrefix)

        forA.wrappedValue = "hello A"
        XCTAssertEqual(forB.wrappedValue, "", "B's prompt never opens on A's words")
        // A's prompt closed (Cancel) and B's opened; a take spoken into A lands late, through A's
        // binding, which the closed prompt still held.
        forB.wrappedValue = "typed for B"
        forA.wrappedValue = "hello A and more"
        XCTAssertEqual(forB.wrappedValue, "typed for B")
        XCTAssertEqual(store.draft(a), "hello A and more")
    }

    func testFirstMessageDraftsAreCapped() {
        let store = ComposerDrafts.shared
        let prefix = "test-prompt-\(UUID().uuidString):"
        let keys = (0..<(PromptDraft.kept + 3)).map { prefix + String(format: "%02d", $0) }
        defer { keys.forEach { store.clear($0) } }
        for key in keys { PromptDraft.binding(key, prefix: prefix).wrappedValue = "words" }
        let left = keys.filter { !store.draft($0).isEmpty }
        XCTAssertLessThanOrEqual(left.count, PromptDraft.kept)
        XCTAssertEqual(store.draft(keys.last!), "words", "the one being written always stays")
    }

    // MARK: - The Talk page's mic key

    func testTheTalkPagesKeyIsItsDictation() {
        XCTAssertEqual(TalkReviewPage.voiceSurface(reviewTake: "take-1"), "talk-review:take-1")
        XCTAssertEqual(
            TalkReviewPage.voiceSurface(reviewTake: "take-1"), TalkReviewPage.voiceSurface(reviewTake: "take-1"),
            "the same dictation gives the same key, so a saved take comes back to its page"
        )
    }

    func testTwoPagesWithNoKeptDictationNeverShareAKey() {
        let one = TalkReviewPage.voiceSurface(reviewTake: nil)
        let two = TalkReviewPage.voiceSurface(reviewTake: nil)
        XCTAssertTrue(one.hasPrefix("talk-review:unsaved-"))
        XCTAssertNotEqual(one, two)
    }
}
