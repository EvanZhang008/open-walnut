import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// A messages transport whose single page can be held open, and made to fail.
///
/// Its own type rather than the switch tests' mock: what matters here is the
/// WINDOW between selecting a conversation and its first page resolving, and a
/// failing read is half the contract (a skeleton that outlives a failed page is a
/// permanent fake-loading screen).
private final class GatedMessagesTransport: ChatMessagesTransport, @unchecked Sendable {
    let gate = CheckedContinuationGate()
    private let lock = NSLock()
    private var _rows: [ChatMessage] = []
    private var _shouldThrow = false
    private var _calls = 0

    var rows: [ChatMessage] {
        get { lock.lock(); defer { lock.unlock() }; return _rows }
        set { lock.lock(); _rows = newValue; lock.unlock() }
    }

    var shouldThrow: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _shouldThrow }
        set { lock.lock(); _shouldThrow = newValue; lock.unlock() }
    }

    var calls: Int { lock.lock(); defer { lock.unlock() }; return _calls }

    func messages(
        conversationID: String, agentID: String, limit: Int, before: String?
    ) async throws -> [ChatMessage] {
        lock.lock(); _calls += 1; lock.unlock()
        await gate.wait()
        if shouldThrow { throw APIError.badResponse }
        return rows
    }
}

/// Opening a conversation must never show a blank screen or the wrong claim.
///
/// THE GATE'S MEASUREMENT (2026-09-12): a cold open of a 200-row page showed up to
/// 3.23 SECONDS of pure white — no skeleton, no spinner — 1845ms of it the server's
/// first JSONL parse. Nothing can paint sooner, because the rows genuinely do not
/// exist yet; what was missing was telling the truth while waiting.
///
/// Two claims the transcript can make about an empty conversation, and only one of
/// them is honest at a time: "still loading" (skeleton) and "nothing here yet"
/// (the listening empty state). This pins which is which, and that BOTH resolve.
@MainActor
final class ChatFirstPageSkeletonTests: XCTestCase {
    private let conversation = "conv-skeleton"
    private static let activeConversationKey = "walnut.activeConversation.general"
    private var saved: String?

    override func setUp() async throws {
        saved = UserDefaults.standard.string(forKey: Self.activeConversationKey)
        DiskCache.remove(key: "messages-\(conversation)")
    }

    override func tearDown() async throws {
        if let saved {
            UserDefaults.standard.set(saved, forKey: Self.activeConversationKey)
        } else {
            UserDefaults.standard.removeObject(forKey: Self.activeConversationKey)
        }
        DiskCache.remove(key: "messages-\(conversation)")
    }

    private func row(_ index: Int) -> ChatMessage {
        ChatMessage(id: "m\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant",
                    text: "row \(index)", createdAt: "2026-09-12T06:00:00Z", kind: nil)
    }

    private func poll(_ label: String, until condition: @MainActor () -> Bool) async {
        for _ in 0..<400 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for \(label)")
    }

    /// The flag goes up SYNCHRONOUSLY with the selection, not when the fetch task
    /// happens to be scheduled — the gap is a frame in which the transcript is
    /// empty and nothing is loading, which is exactly when the "listening" empty
    /// state used to flash during a conversation switch.
    ///
    /// RED PROOF: moving the flag into `loadMessages` leaves it false at the first
    /// assertion.
    func testTheFirstPageIsAnnouncedSynchronouslyWithTheSelection() async {
        let transport = GatedMessagesTransport()
        transport.rows = (0..<12).map(row)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        XCTAssertTrue(store.firstPageInFlight,
                      "the skeleton has to be up in the SAME frame as the tap")
        XCTAssertTrue(store.messages.isEmpty)

        transport.gate.open()
        await poll("the first page to land") { !store.messages.isEmpty }
        XCTAssertFalse(store.firstPageInFlight, "a landed page retires the skeleton")
    }

    /// A FAILED first page resolves too. A skeleton that outlives it is worse than
    /// the blank it replaced: the blank at least stops claiming to be busy.
    ///
    /// RED PROOF: clearing the flag only on the success path hangs this test.
    func testAFailedFirstPageStillRetiresTheSkeleton() async {
        let transport = GatedMessagesTransport()
        transport.shouldThrow = true
        let store = ChatStore(transport: transport)

        store.select(conversation)
        XCTAssertTrue(store.firstPageInFlight)
        transport.gate.open()
        await poll("the failed page to resolve") { !store.firstPageInFlight }
        XCTAssertTrue(store.messages.isEmpty,
                      "and it leaves the transcript alone rather than inventing rows")
    }

    /// New chat is not "loading" anything — it is the resting state, and its empty
    /// transcript is the honest claim.
    func testNewChatShowsNoSkeleton() async {
        let transport = GatedMessagesTransport()
        transport.rows = (0..<12).map(row)
        let store = ChatStore(transport: transport)
        store.select(conversation)
        transport.gate.open()
        await poll("the first page to land") { !store.messages.isEmpty }

        store.startNewConversation()
        XCTAssertFalse(store.firstPageInFlight)
        XCTAssertTrue(store.messages.isEmpty)
    }

    /// …and the skeleton PAINTS. The flag is only half the fix: a placeholder that
    /// lays out but draws nothing is the same white screen with more code behind it,
    /// and on a warm server the whole window is ~100ms (measured against live prod:
    /// a 200-row page in 53-119ms), far too short to catch in a screenshot. So the
    /// ink is asserted here rather than by eye.
    ///
    /// RED PROOF: dropping the bars' `.background` (or giving them zero height)
    /// takes the coverage to 0.
    func testTheSkeletonPaintsInkRatherThanLayingOutNothing() {
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 640)
        // `ImageRenderer`, not `UIHostingController` + `layer.render(in:)`: measured,
        // a hosting controller that was never in a window renders 0 ink, so that
        // route would have needed a real (briefly visible) UIWindow to prove
        // anything. This renders the same view tree off-screen.
        let renderer = ImageRenderer(
            content: ChatTimelineSkeleton().frame(width: bounds.width, height: bounds.height))
        renderer.scale = 1
        guard let drawn = renderer.cgImage else { return XCTFail("nothing rendered at all") }

        let width = Int(bounds.width), height = Int(bounds.height)
        var pixels = [UInt8](repeating: 255, count: width * height)
        pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(
                data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return XCTFail("no bitmap context") }
            context.setFillColor(gray: 1, alpha: 1)
            context.fill(bounds)
            context.draw(drawn, in: bounds)
        }
        let inked = pixels.reduce(into: 0) { total, value in total += value < 250 ? 1 : 0 }
        let coverage = Double(inked) / Double(width * height)
        XCTAssertGreaterThan(coverage, 0.02,
                             "the skeleton drew \(coverage) of the page — a placeholder "
                                 + "nobody can see is the blank screen it replaced")
        // …and it is a HINT, not a fake transcript: a page of solid grey would read
        // as content that failed to render.
        XCTAssertLessThan(coverage, 0.5, "coverage \(coverage) is a wall, not a skeleton")
    }

    /// THE GATE'S OTHER SMALL FINDING: a brand-new empty chat offered "Load earlier
    /// messages" at the top of nothing. `hasOlder` belonged to the conversation that
    /// had just been on screen and NOTHING reset it on selection, so opening New
    /// chat after a long conversation inherited its true.
    ///
    /// RED PROOF: removing `hasOlder = false` from `select` fails the second
    /// assertion — with a full first page behind it, which is the real shape (the
    /// flag is only true after a page that filled).
    func testNewChatDoesNotInheritLoadEarlierFromTheLastConversation() async {
        let transport = GatedMessagesTransport()
        // A page that FILLS is what sets `hasOlder`; anything shorter proves nothing.
        transport.rows = (0..<200).map(row)
        let store = ChatStore(transport: transport)

        store.select(conversation)
        transport.gate.open()
        await poll("a full first page") { store.messages.count >= 200 }
        XCTAssertTrue(store.hasOlder, "a full page means there is more behind it")

        store.startNewConversation()
        XCTAssertFalse(store.hasOlder,
                       "an empty new chat must not offer to load earlier messages")
        XCTAssertNil(store.activeID)
    }
}
