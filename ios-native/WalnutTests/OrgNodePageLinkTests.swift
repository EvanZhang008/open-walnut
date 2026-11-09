import SwiftUI
import XCTest
@testable import Walnut

/// A thread push reaches the node's page through `OrgNodePageLink`, never as a value handed to a
/// page already shown (2026-11-06 gate, round 4: with the VP's page up, a tap changed nothing on
/// screen, because SwiftUI did not pass the new request into the presented page).
///
///  1. The mailbox: who takes a request (the chat with no page pushes one, the page on screen
///     applies it itself), freshness, a newer request replacing an older one, withdraw and drop.
///  2. The real delivery path, hosted: a node chat's `OrgNodePageHost` in a `NavigationStack`
///     pushes the page for a first request, and the page already on screen (on Tasks) takes the
///     next ones itself: its view comes to Threads, the thread is focused, a repeated tap of the
///     same thread is applied again.
///  3. What the page opened over itself (a task's session, a Follow up composer) goes down for a
///     request the page takes, so the view it brought forward is in sight; another node's request
///     leaves it up.
@MainActor
final class OrgNodePageLinkTests: XCTestCase {
    private let t0 = Date()
    private let node = OrgNodeIdentity(id: "vp-growth", name: "Growth VP", isMain: false)

    private func request(
        _ tab: OrgNodeTab = .threads, thread: String? = "th-aaaaaa", session: String = "s-1", at: Date
    ) -> OrgNodePageLink.Request {
        .init(nodeId: "vp-growth", sessionId: session, tab: tab, threadId: thread, at: at)
    }

    // MARK: - 1. The mailbox

    func testTheChatWithNoPagePushesOneAndThePageOnScreenTakesItItself() {
        let r = request(at: t0)
        XCTAssertEqual(OrgNodePageLinkModel.hostAction(
            r, follows: true, sessionId: "s-1", nodeId: "vp-growth", presentedNodeId: nil), .pushPage)
        XCTAssertEqual(OrgNodePageLinkModel.hostAction(
            r, follows: true, sessionId: "s-1", nodeId: "vp-growth", presentedNodeId: "vp-growth"), .leaveToPage,
            "with the page up the chat leaves the request to it, it never pushes a second page")
        XCTAssertTrue(OrgNodePageLinkModel.pageTakes(r, follows: true, nodeId: "vp-growth", sessionId: "s-1"))
    }

    func testOnlyTheChatTheRequestWasMatchedToFollowsIt() {
        let r = request(at: t0)
        XCTAssertEqual(OrgNodePageLinkModel.hostAction(
            r, follows: false, sessionId: "s-1", nodeId: "vp-growth", presentedNodeId: nil), .none,
            "a copy of the chat outside the Chat tab never follows a push")
        XCTAssertEqual(OrgNodePageLinkModel.hostAction(
            r, follows: true, sessionId: "s-other", nodeId: "vp-growth", presentedNodeId: nil), .none)
        XCTAssertEqual(OrgNodePageLinkModel.hostAction(
            r, follows: true, sessionId: "s-1", nodeId: nil, presentedNodeId: nil), .none,
            "a chat that does not know its node yet waits")
        XCTAssertFalse(OrgNodePageLinkModel.pageTakes(r, follows: true, nodeId: "vp-other", sessionId: "s-1"))
        XCTAssertFalse(OrgNodePageLinkModel.pageTakes(r, follows: false, nodeId: "vp-growth", sessionId: "s-1"))
        XCTAssertFalse(OrgNodePageLinkModel.pageTakes(nil, follows: true, nodeId: "vp-growth", sessionId: "s-1"))
    }

    func testARequestIsTakenOnceAndOnlyByItsChat() {
        let link = OrgNodePageLink()
        link.post(request(at: t0))
        XCTAssertNil(link.take(nodeId: "vp-growth", sessionId: "s-other", now: t0))
        XCTAssertNotNil(link.pending, "another chat's take leaves it waiting")
        XCTAssertEqual(link.take(nodeId: "vp-growth", sessionId: "s-1", now: t0), request(at: t0))
        XCTAssertNil(link.pending)
        XCTAssertNil(link.take(nodeId: "vp-growth", sessionId: "s-1", now: t0), "taken once")
    }

    func testAStaleRequestIsDroppedNotApplied() {
        let link = OrgNodePageLink()
        link.post(request(at: t0))
        XCTAssertNil(link.take(nodeId: "vp-growth", sessionId: "s-1", now: t0 + OrgNodePageLink.requestTTL + 1))
        XCTAssertNil(link.pending)
        link.post(request(at: t0))
        XCTAssertNotNil(link.take(nodeId: "vp-growth", sessionId: "s-1", now: t0 + OrgNodePageLink.requestTTL))
    }

    func testANewerRequestReplacesTheOneStillWaiting() {
        let link = OrgNodePageLink()
        link.post(request(thread: "th-aaaaaa", at: t0))
        link.post(request(thread: "th-bbbbbb", at: t0 + 1))
        XCTAssertEqual(link.take(nodeId: "vp-growth", sessionId: "s-1", now: t0 + 1)?.threadId, "th-bbbbbb")
    }

    func testWithdrawRemovesOnlyItsOwnRequest() {
        let link = OrgNodePageLink()
        let older = request(thread: "th-aaaaaa", at: t0)
        link.post(older)
        link.post(request(thread: "th-bbbbbb", at: t0 + 1))
        link.withdraw(older)
        XCTAssertEqual(link.pending?.threadId, "th-bbbbbb", "a failed older open never takes the newer one with it")
        link.withdraw(request(thread: "th-bbbbbb", at: t0 + 1))
        XCTAssertNil(link.pending)
    }

    func testLeavingForAnotherChatDropsTheRequest() {
        let link = OrgNodePageLink()
        link.post(request(at: t0))
        link.drop(unlessSession: "s-1")
        XCTAssertNotNil(link.pending, "the chat the request is for keeps it")
        link.drop(unlessSession: nil)
        XCTAssertNil(link.pending, "back to the chat list: the same chat opened later opens on the chat")
    }

    func testThePageAppliesARequestByItsTimeOnce() throws {
        let opened = OrgNodePageFocusModel.State(tab: .tasks, focus: nil, appliedAt: nil)
        let first = try XCTUnwrap(OrgNodePageFocusModel.apply(request(at: t0), to: opened))
        XCTAssertEqual(first.tab, .threads, "a push while Tasks is in front brings Threads forward")
        XCTAssertEqual(first.focus, OrgThreadFocus(threadId: "th-aaaaaa", at: t0))
        XCTAssertNil(OrgNodePageFocusModel.apply(request(at: t0), to: first), "the same request is no news")
        let again = try XCTUnwrap(OrgNodePageFocusModel.apply(request(at: t0 + 2), to: first))
        XCTAssertEqual(again.focus?.at, t0 + 2, "a repeated tap is a new reveal")
        XCTAssertNil(OrgNodePageFocusModel.apply(request(thread: "", at: t0 + 3), to: again)?.focus,
                     "an empty thread id focuses nothing")
    }

    func testARequestThePageAppliesTakesDownWhatIsOverIt() throws {
        let opened = OrgNodePageFocusModel.State(tab: .tasks, focus: nil, appliedAt: nil)
        let task = OrgNodePageCover.task(TaskOpenTarget(id: "t-ship", title: "Ship it"))
        let applied = try XCTUnwrap(OrgNodePageFocusModel.apply(request(at: t0), to: opened))
        XCTAssertNil(OrgNodePageFocusModel.cover(task, after: applied),
                     "a task opened from Tasks goes down, so the Threads view the push brought is in sight")
        XCTAssertNil(OrgNodePageFocusModel.cover(.followUp(threadId: "th-aaaaaa", title: "Pricing"), after: applied))
        XCTAssertEqual(OrgNodePageFocusModel.cover(task, after: nil), task,
                       "a request the page did not apply (the same one again) leaves it up")
        XCTAssertNil(OrgNodePageFocusModel.cover(nil, after: applied))
    }

    // MARK: - 2. The real delivery path, hosted

    private var window: UIWindow?

    override func tearDown() {
        window?.rootViewController = nil
        window = nil
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        super.tearDown()
    }

    /// A node's chat as the Chat tab shows it: the page host over a stand-in for the chat.
    private struct NodeChat: View {
        @State var route: OrgNodeRoute?
        let node: OrgNodeIdentity
        let link: OrgNodePageLink
        var body: some View {
            NavigationStack {
                Color.clear
                    .modifier(OrgNodePageHost(route: $route, node: node, sessionId: "s-1", follows: true, link: link))
            }
        }
    }

    private func host(link: OrgNodePageLink) {
        let root = NodeChat(route: nil, node: node, link: link)
            .environment(TasksStore(transport: MockTaskTransport()))
        let controller = UIHostingController(rootView: root)
        let w = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        w.rootViewController = controller
        w.isHidden = false
        controller.view.frame = w.bounds
        window = w
    }

    private func spin(until done: () -> Bool, timeout: TimeInterval = 5) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if done() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return done()
    }

    func testThePageAlreadyOnScreenTakesTheNextPushItself() throws {
        let link = OrgNodePageLink()
        host(link: link)
        _ = spin(until: { false }, timeout: 0.3) // let the stack lay out

        // No page up: the chat pushes one, here on Tasks (as if he had tapped the bar's Tasks).
        let first = request(.tasks, thread: nil, at: Date())
        link.post(first)
        XCTAssertTrue(spin { link.lastDelivery?.request == first }, "the chat pushed the page for the first request")
        XCTAssertEqual(link.lastDelivery?.by, .newPage)
        XCTAssertEqual(link.lastDelivery?.tab, .tasks)
        XCTAssertNil(link.pending)

        // The page is up on Tasks; a thread push for the same node arrives.
        let second = request(.threads, thread: "th-bbbbbb", at: Date().addingTimeInterval(0.01))
        link.post(second)
        XCTAssertTrue(spin { link.lastDelivery?.request == second },
                      "the page on screen took the request (the round 4 failure: nothing took it)")
        let delivered = try XCTUnwrap(link.lastDelivery)
        XCTAssertEqual(delivered.by, .livePage, "taken by the page already shown, not a second page")
        XCTAssertEqual(delivered.tab, .threads, "its view came to Threads")
        XCTAssertEqual(delivered.focus?.threadId, "th-bbbbbb")
        XCTAssertNil(link.pending)

        // The same thread tapped again: applied again, with its own time.
        let third = request(.threads, thread: "th-bbbbbb", at: Date().addingTimeInterval(0.02))
        link.post(third)
        XCTAssertTrue(spin { link.lastDelivery?.request == third }, "a repeated tap reaches the page too")
        XCTAssertEqual(link.lastDelivery?.by, .livePage)
        XCTAssertEqual(link.lastDelivery?.focus?.at, third.at)
    }

    /// The node's page as the chat pushed it, with something already opened over it.
    private func hostPage(link: OrgNodePageLink, cover: OrgNodePageCover) -> UIViewController {
        let route = OrgNodeRoute(nodeId: node.id, name: node.name, isMain: false, sessionId: "s-1", tab: .tasks)
        let root = NavigationStack { OrgNodePage(route: route, followsLinks: true, link: link, cover: cover) }
            .environment(TasksStore(transport: MockTaskTransport()))
        let controller = UIHostingController(rootView: root)
        let w = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        w.rootViewController = controller
        w.isHidden = false
        controller.view.frame = w.bounds
        window = w
        return controller
    }

    /// Whether anything is presented over `controller` or one of its children.
    private func presented(_ controller: UIViewController) -> Bool {
        if controller.presentedViewController != nil { return true }
        return controller.children.contains { presented($0) }
    }

    func testAPushForThePageOnScreenTakesDownTheTaskOpenedFromIt() throws {
        let link = OrgNodePageLink()
        let controller = hostPage(link: link, cover: .task(TaskOpenTarget(id: "t-ship", title: "Ship it")))
        XCTAssertTrue(spin { self.presented(controller) }, "the task opened from Tasks is over the page")

        let r = request(.threads, thread: "th-bbbbbb", at: Date())
        link.post(r)
        XCTAssertTrue(spin { link.lastDelivery?.request == r }, "the page on screen took the request")
        let delivered = try XCTUnwrap(link.lastDelivery)
        XCTAssertEqual(delivered.tab, .threads)
        XCTAssertEqual(delivered.focus?.threadId, "th-bbbbbb")
        XCTAssertFalse(delivered.covered, "nothing the page opened stays over it")
        XCTAssertTrue(spin { !self.presented(controller) },
                      "the task's sheet went down: the Threads view is what he sees (the gate's predicted failure)")
    }

    func testAPushForThePageOnScreenClosesAFollowUpComposer() throws {
        let link = OrgNodePageLink()
        let controller = hostPage(link: link, cover: .followUp(threadId: "th-aaaaaa", title: "Pricing"))
        XCTAssertTrue(spin { self.presented(controller) })
        let r = request(.threads, thread: "th-aaaaaa", at: Date())
        link.post(r)
        XCTAssertTrue(spin { link.lastDelivery?.request == r })
        XCTAssertEqual(link.lastDelivery?.covered, false)
        XCTAssertTrue(spin { !self.presented(controller) })
    }

    func testAnotherNodesRequestLeavesWhatIsOverThePage() {
        let link = OrgNodePageLink()
        let controller = hostPage(link: link, cover: .followUp(threadId: "th-aaaaaa", title: "Pricing"))
        XCTAssertTrue(spin { self.presented(controller) })
        link.post(.init(nodeId: "vp-other", sessionId: "s-9", tab: .threads, threadId: "th-cccccc", at: Date()))
        _ = spin(until: { false }, timeout: 0.5)
        XCTAssertNil(link.lastDelivery, "another node's request is not this page's")
        XCTAssertNotNil(link.pending)
        XCTAssertTrue(presented(controller), "what he opened here stays up")
    }

    func testARequestForAnotherChatLeavesThePageAlone() {
        let link = OrgNodePageLink()
        host(link: link)
        let first = request(.threads, thread: "th-aaaaaa", at: Date())
        link.post(first)
        XCTAssertTrue(spin { link.lastDelivery?.request == first })
        link.post(request(.threads, thread: "th-cccccc", session: "s-other", at: Date().addingTimeInterval(0.01)))
        _ = spin(until: { false }, timeout: 0.5)
        XCTAssertEqual(link.lastDelivery?.request, first, "another chat's request is not this page's")
        XCTAssertNotNil(link.pending, "it waits for its own chat")
    }
}
