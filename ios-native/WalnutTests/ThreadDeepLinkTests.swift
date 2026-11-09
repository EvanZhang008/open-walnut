import XCTest
@testable import Walnut

/// A tap on a thread push (src/core/push/thread-push.ts) opens its node's page on Threads, at
/// that thread (`ThreadDeepLink`, then `OrgNodeLink`).
///
///  1. Payload → target, from the exact shape the server sends; anything else is not ours,
///     so the tap only opens the app (as an older build does).
///  2. The mailbox: only a tap arms it, it survives until the UI exists (cold launch), it
///     expires, and a duplicate tap is one open.
///  3. The open goes through the one seam, `openThread`, by the node's task, as an
///     `OrgNodeLink` request for the Threads tab at that thread.
@MainActor
final class ThreadDeepLinkTests: XCTestCase {

    // MARK: - Fixtures matching the server exactly

    /// What `apnsPayload(threadPushContent(...))` produces: the data FLAT beside `aps`, and
    /// repeated nested under `data`.
    private func serverPayload(
        type: String = "org_thread", taskId: String? = "mq65z6ch-7937", threadId: String? = "th-0a1b2c3d4e5f"
    ) -> [AnyHashable: Any] {
        var data: [String: Any] = ["type": type, "url": "/org?node=main"]
        if let taskId { data["taskId"] = taskId }
        if let threadId { data["threadId"] = threadId }
        var payload: [AnyHashable: Any] = [
            "aps": [
                "alert": ["title": "Pick the launch date", "body": "Saturday or Sunday?"],
                "sound": "default",
            ],
            "data": data,
        ]
        for (key, value) in data { payload[key] = value }
        return payload
    }

    override func setUp() {
        super.setUp()
        ThreadDeepLink.shared.clear()
        _ = OrgNodeLink.shared.consume()
        _ = ContentActionLink.shared.consumeChat()
    }

    override func tearDown() {
        ThreadDeepLink.shared.clear()
        _ = OrgNodeLink.shared.consume()
        super.tearDown()
    }

    // MARK: - Payload → target

    func testServerPayloadYieldsTheNodeAndTheThread() {
        let target = ThreadDeepLink.target(fromPush: serverPayload())
        XCTAssertEqual(target, ThreadDeepLink.Target(
            taskId: "mq65z6ch-7937", threadId: "th-0a1b2c3d4e5f",
            title: "Pick the launch date", ask: "Saturday or Sunday?"
        ))
    }

    func testNestedOnlyAndExpoBodyShapesParse() throws {
        let nested: [AnyHashable: Any] = [
            "aps": ["alert": "Saturday or Sunday?"],
            "data": ["type": "org_thread", "taskId": "task-1", "threadId": "th-abcdef"],
        ]
        XCTAssertEqual(ThreadDeepLink.target(fromPush: nested)?.threadId, "th-abcdef")
        XCTAssertEqual(ThreadDeepLink.target(fromPush: nested)?.ask, "Saturday or Sunday?", "a bare alert string is the body")
        XCTAssertNil(ThreadDeepLink.target(fromPush: nested)?.title)
        let body = String(decoding: try JSONSerialization.data(withJSONObject: [
            "type": "org_thread", "taskId": "task-1", "threadId": "th-abcdef",
        ]), as: UTF8.self)
        XCTAssertEqual(ThreadDeepLink.target(fromPush: ["body": body])?.taskId, "task-1")
    }

    /// Missing or malformed ids are not a thread push: the tap only opens the app.
    func testMissingOrMalformedIdsAreRefused() {
        XCTAssertNil(ThreadDeepLink.target(fromPush: serverPayload(taskId: nil)))
        XCTAssertNil(ThreadDeepLink.target(fromPush: serverPayload(threadId: nil)))
        for bad in ["../x", "task/1", "", "a b", String(repeating: "a", count: 65), "t\u{00E9}"] {
            XCTAssertNil(ThreadDeepLink.target(fromPush: serverPayload(taskId: bad)), "taskId \(bad)")
        }
        for bad in ["th-ABCDEF", "th-abc", "th-zzzzzz", "lt-m9x2k1-a4f7", "th-" + String(repeating: "a", count: 33), ""] {
            XCTAssertNil(ThreadDeepLink.target(fromPush: serverPayload(threadId: bad)), "threadId \(bad)")
        }
    }

    func testIdRulesMatchTheServer() {
        XCTAssertTrue(ThreadDeepLink.isValidThreadId("th-0a1b2c"))
        XCTAssertTrue(ThreadDeepLink.isValidThreadId("th-" + String(repeating: "f", count: 32)))
        XCTAssertTrue(ThreadDeepLink.isValidTaskId("mq65z6ch-7937"))
        XCTAssertTrue(ThreadDeepLink.isValidTaskId("task_fixture-main"))
    }

    /// An unknown type, a letter or an approval is never mistaken for a thread, and a thread
    /// push is never mistaken for a letter or an approval.
    func testOtherPushTypesAreNotThreads() {
        XCTAssertNil(ThreadDeepLink.target(fromPush: serverPayload(type: "session_result")))
        XCTAssertNil(ThreadDeepLink.target(fromPush: ["aps": ["alert": "hi"]]))
        let letter: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "t", "body": "b"]],
            "type": "human_inbox_letter", "letterId": "lt-m9x2k1-a4f7",
            "taskId": "mq65z6ch-7937", "threadId": "th-0a1b2c3d4e5f",
        ]
        XCTAssertNil(ThreadDeepLink.target(fromPush: letter))
        XCTAssertNil(LetterDeepLink.letterId(fromPush: serverPayload()))
        XCTAssertNil(ApprovalCenter.approvalId(fromPush: serverPayload()))
    }

    // MARK: - The mailbox

    func testOnlyATapArmsIt() {
        let link = ThreadDeepLink.shared
        XCTAssertTrue(link.handle(push: serverPayload(), source: "background"))
        XCTAssertNil(link.pending, "a background delivery is no instruction")
        XCTAssertFalse(link.handle(push: serverPayload(type: "other"), source: ThreadDeepLink.tapSource))
        XCTAssertNil(link.pending)
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource)
        XCTAssertEqual(link.pending?.target.threadId, "th-0a1b2c3d4e5f")
    }

    /// A cold launch arms the mailbox before any view exists; the Chat tab takes it later.
    func testColdLaunchTapWaitsForTheChat() {
        let link = ThreadDeepLink.shared
        let tappedAt = Date(timeIntervalSince1970: 1_800_000_000)
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: tappedAt)
        let taken = link.consume(now: tappedAt.addingTimeInterval(8))
        XCTAssertEqual(taken?.target.taskId, "mq65z6ch-7937")
        XCTAssertNil(link.pending)
        XCTAssertNil(link.consume(now: tappedAt.addingTimeInterval(9)), "taken once")
    }

    func testAStaleTapIsDroppedAndCleared() {
        let link = ThreadDeepLink.shared
        let tappedAt = Date(timeIntervalSince1970: 1_800_000_000)
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: tappedAt)
        XCTAssertNil(link.consume(now: tappedAt.addingTimeInterval(ThreadDeepLink.requestTTL + 1)))
        XCTAssertNil(link.pending, "a stale link is not retried on the next appear")
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: tappedAt)
        XCTAssertNotNil(link.consume(now: tappedAt.addingTimeInterval(ThreadDeepLink.requestTTL)))
    }

    /// Two taps (the same banner twice, or two threads) are one open: the latest.
    func testADuplicateTapIsOneOpen() {
        let link = ThreadDeepLink.shared
        let now = Date()
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: now)
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: now.addingTimeInterval(1))
        XCTAssertNotNil(link.consume(now: now.addingTimeInterval(2)))
        XCTAssertNil(link.consume(now: now.addingTimeInterval(2)))
        link.handle(push: serverPayload(threadId: "th-111111"), source: ThreadDeepLink.tapSource, now: now)
        link.handle(push: serverPayload(threadId: "th-222222"), source: ThreadDeepLink.tapSource, now: now)
        XCTAssertEqual(link.consume(now: now)?.target.threadId, "th-222222")
    }

    // MARK: - Where a tap goes

    /// A fresh tap opens that node's page on Threads, at that thread, through the one seam
    /// (`openThread` -> `OrgNodeLink`), by the node's task. Nothing goes through the CEO's
    /// "Open chat" path, whose "is starting, open it again" line is not for a thread.
    func testATapOpensTheNodesThreadsPageAtTheThread() {
        let link = ThreadDeepLink.shared
        let now = Date()
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: now)
        link.deliverPending(now: now.addingTimeInterval(1))
        XCTAssertEqual(OrgNodeLink.shared.pending?.requestedAt, now.addingTimeInterval(1),
                       "the open is a new request, timed when the tabs took it")
        let open = OrgNodeLink.shared.consume(now: now.addingTimeInterval(2))
        XCTAssertEqual(open?.taskId, "mq65z6ch-7937")
        XCTAssertEqual(open?.threadId, "th-0a1b2c3d4e5f")
        XCTAssertEqual(open?.tab, .threads)
        XCTAssertNil(ContentActionLink.shared.chat, "the CEO's Open chat path is not used")
        XCTAssertNil(link.pending)
        link.deliverPending(now: now.addingTimeInterval(3))
        XCTAssertNil(OrgNodeLink.shared.pending, "one tap, one open")
    }

    /// The seam itself, called directly: the request names the node, the thread and Threads.
    func testOpenThreadAsksForTheThreadsPage() {
        let now = Date()
        ThreadDeepLink.openThread(taskId: "task_fixture-main", threadId: "th-5e5e5e5e")
        let open = OrgNodeLink.shared.consume(now: now)
        XCTAssertEqual(open?.taskId, "task_fixture-main")
        XCTAssertEqual(open?.threadId, "th-5e5e5e5e")
        XCTAssertEqual(open?.tab, .threads)
    }

    /// A stale tap, a background delivery or a payload that is not ours opens nothing; a tap
    /// exactly at the 10 minute limit still opens.
    func testNothingOpensWithoutAFreshTap() {
        let link = ThreadDeepLink.shared
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        link.handle(push: serverPayload(), source: "background", now: at)
        link.handle(push: serverPayload(threadId: nil), source: ThreadDeepLink.tapSource, now: at)
        link.handle(push: serverPayload(taskId: "../x"), source: ThreadDeepLink.tapSource, now: at)
        link.handle(push: serverPayload(threadId: "th-ABCDEF"), source: ThreadDeepLink.tapSource, now: at)
        link.deliverPending(now: at)
        XCTAssertNil(OrgNodeLink.shared.pending, "invalid ids and a background delivery open nothing")
        XCTAssertEqual(ThreadDeepLink.requestTTL, 600, "a tap waits 10 minutes for the tabs")
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: at)
        link.deliverPending(now: at.addingTimeInterval(ThreadDeepLink.requestTTL + 1))
        XCTAssertNil(OrgNodeLink.shared.pending, "a stale tap opens nothing")
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: at)
        let atLimit = at.addingTimeInterval(ThreadDeepLink.requestTTL)
        link.deliverPending(now: atLimit)
        XCTAssertEqual(OrgNodeLink.shared.consume(now: atLimit)?.threadId, "th-0a1b2c3d4e5f")
    }

    /// While a fresh tap waits, a cold launch does not put back the last chat over it
    /// (`ChatView.restorePlace` reads this); a stale or consumed one no longer holds it back.
    func testAWaitingTapHoldsBackTheLaunchRestore() {
        let link = ThreadDeepLink.shared
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(link.waitsToOpen(now: at))
        link.handle(push: serverPayload(), source: "background", now: at)
        XCTAssertFalse(link.waitsToOpen(now: at), "a background delivery holds nothing")
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: at)
        XCTAssertTrue(link.waitsToOpen(now: at.addingTimeInterval(5)))
        XCTAssertFalse(link.waitsToOpen(now: at.addingTimeInterval(ThreadDeepLink.requestTTL + 1)))
        XCTAssertNotNil(link.pending, "reading does not consume")
        _ = link.consume(now: at)
        XCTAssertFalse(link.waitsToOpen(now: at))
    }

    /// Approval pending plus a thread tap (the gate's scenario 9). An approval push neither takes
    /// nor replaces the thread tap, and the tap survives however long the approval sheet holds
    /// the app before the tabs take it: the node page's request is timed when they do, so its own
    /// 120 s limit starts then, and the Chat tab takes it at once (it is always mounted).
    func testAnApprovalSheetNeitherConsumesNorExpiresAThreadTap() {
        let link = ThreadDeepLink.shared
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let approval: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Approve? Run the script", "body": "on this Mac"], "category": "WALNUT_APPROVAL"],
            "type": "approval_request", "approvalId": "apr-nXOVIf86HpED", "mode": "tap",
            "data": ["type": "approval_request", "approvalId": "apr-nXOVIf86HpED", "mode": "tap"],
        ]
        link.handle(push: serverPayload(), source: ThreadDeepLink.tapSource, now: at)
        XCTAssertFalse(link.handle(push: approval, source: ThreadDeepLink.tapSource, now: at.addingTimeInterval(2)),
                       "an approval tap is not a thread tap")
        XCTAssertEqual(link.pending?.requestedAt, at, "the thread tap is still the one waiting")
        // The sheet stays up five minutes; the tap still waits and still holds back the restore.
        XCTAssertTrue(link.waitsToOpen(now: at.addingTimeInterval(300)))
        link.deliverPending(now: at.addingTimeInterval(300))
        XCTAssertEqual(OrgNodeLink.shared.pending?.requestedAt, at.addingTimeInterval(300))
        XCTAssertEqual(OrgNodeLink.shared.consume(now: at.addingTimeInterval(301))?.threadId, "th-0a1b2c3d4e5f")
        // The node page's limit is its own: a request left untaken for over 120 s opens nothing.
        OrgNodeLink.shared.open(taskId: "mq65z6ch-7937", threadId: "th-0a1b2c3d4e5f", now: at)
        XCTAssertNil(OrgNodeLink.shared.consume(now: at.addingTimeInterval(OrgNodeLink.requestTTL + 1)))
    }

    /// The DEBUG launch argument the UI test uses builds the server's payload.
    func testDebugLaunchPayloadParsesLikeAServerPush() {
        let target = ThreadDeepLink.target(fromPush: QuickActionDelegate.debugThreadPush("task-fixture-main th-5e5e5e"))
        XCTAssertEqual(target?.taskId, "task-fixture-main")
        XCTAssertEqual(target?.threadId, "th-5e5e5e")
        XCTAssertNil(ThreadDeepLink.target(fromPush: QuickActionDelegate.debugThreadPush("task-only")))
    }
}
