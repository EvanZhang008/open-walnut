import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// Links inside HOSTED SwiftUI timeline content (markdown tables, notification
/// bodies) must reach the timeline's own delegate.
///
/// The defect this covers shipped as the worst possible version of itself: a
/// path in a markdown table cell was accent-coloured and underlined, was a real
/// accessibility link element carrying `walnut-file://preview/…`, and did
/// NOTHING when tapped, four times, at four positions. Hosted content gets
/// SwiftUI's default `openURL`, which hands an unknown scheme to the system
/// opener; the system drops `walnut-file://` silently. The UIKit text cells never
/// had this problem because they intercept in `UITextViewDelegate`.
///
/// What this layer proves: given a URL and a delegate, the routing decision is
/// "hand it to the delegate", for our scheme AND for web URLs (one path for the
/// whole timeline, same as the text cells), and that content built with no
/// delegate leaves SwiftUI's behaviour alone.
/// What it cannot prove: that a real TAP on a table cell reaches `\.openURL`.
/// SwiftUI builds no accessibility tree in a plain XCTest process, so there is
/// nothing to activate; that last inch is the device gate's.
@MainActor
final class TimelineHostedLinkRoutingTests: XCTestCase {

    private final class SpyDelegate: TimelineCellActionDelegate {
        var actions: [TimelineRowAction] = []
        func timelineCell(didRequest action: TimelineRowAction) { actions.append(action) }
    }

    func testFileSchemeLinkIsHandedToTheDelegate() {
        let spy = SpyDelegate()
        let url = FilePreviewLink.url(for: FilePathRef(path: "~/Library/Containers/com.docker.docker"))!
        XCTAssertTrue(TimelineHostedCell.handleHostedLink(url, delegate: spy))
        guard case .openURL(let routed)? = spy.actions.first else {
            return XCTFail("a walnut-file:// link in hosted content never reached the delegate")
        }
        XCTAssertEqual(routed, url)
        // And the controller's own handler turns that into a preview, not Safari.
        XCTAssertEqual(FilePreviewLink.reference(from: routed)?.path,
                       "~/Library/Containers/com.docker.docker")
    }

    func testWebLinkTakesTheSamePathAsTheTextCells() {
        let spy = SpyDelegate()
        let url = URL(string: "https://example.com/x")!
        XCTAssertTrue(TimelineHostedCell.handleHostedLink(url, delegate: spy))
        guard case .openURL(let routed)? = spy.actions.first else {
            return XCTFail("a web link in hosted content must route like any other")
        }
        XCTAssertEqual(routed, url)
        XCTAssertNil(FilePreviewLink.reference(from: routed),
                     "a web URL must not be mistaken for a file reference")
    }

    /// The height-parity gate renders hosted content with no delegate. It must
    /// not silently swallow taps there either.
    func testNoDelegateFallsBackToTheSystemBehaviour() {
        XCTAssertFalse(TimelineHostedCell.handleHostedLink(
            URL(string: "https://example.com/x")!, delegate: nil))
    }

    /// A table row carrying a path renders, and renders as a link. Guards the
    /// path from "the parser linkified it" to "the hosted cell kept the link
    /// attribute" — the step where a `.lineLimit(1)` Text could have dropped it.
    func testTableCellKeepsTheLinkAttributeItWasGiven() {
        var cell = AttributedString("~/Library/Caches")
        MarkdownParser.linkifyPreviewableFilePaths(&cell)
        let links = cell.runs.compactMap { $0.link }
        XCTAssertEqual(links.count, 1, "the table cell's own text must carry a link to route")
        XCTAssertEqual(FilePreviewLink.reference(from: links[0])?.path, "~/Library/Caches")
    }

    // MARK: - The environment install, resolved for real

    /// Apply the REAL routing modifier and open a link from inside it.
    ///
    /// This is the step the pure-function tests take on trust: that the decision
    /// is installed into `\.openURL` where a link can find it. The probe reads
    /// `\.openURL` out of the resolved environment — the same value SwiftUI hands
    /// a `Text` link — and calls it.
    ///
    /// What it still cannot prove: that a FINGER on a table cell reaches
    /// `\.openURL` at all. SwiftUI builds no accessibility tree in a plain
    /// XCTest process (a walk of the hosted hierarchy, including the container
    /// protocol, finds zero elements), so the tap itself is device-only.
    func testTheRoutingModifierInstallsAHandlerLinksCanReach() {
        let spy = SpyDelegate()
        let target = FilePreviewLink.url(for: FilePathRef(path: "~/Library/Caches"))!
        let opened = expectation(description: "openURL resolved from the environment")

        struct Probe: View {
            let url: URL
            let done: XCTestExpectation
            @Environment(\.openURL) private var openURL
            var body: some View {
                Color.clear.task {
                    openURL(url)
                    done.fulfill()
                }
            }
        }

        let controller = UIHostingController(
            rootView: Probe(url: target, done: opened)
                .modifier(TimelineHostedLinkRouting(delegate: spy)))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 200))
        if let scene = UIApplication.shared.connectedScenes
            .first(where: { $0 is UIWindowScene }) as? UIWindowScene {
            window.windowScene = scene
        }
        window.rootViewController = controller
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            window.windowScene = nil
        }
        wait(for: [opened], timeout: 3)

        guard case .openURL(let routed)? = spy.actions.first else {
            return XCTFail("a link opened inside the routing modifier never reached the delegate")
        }
        XCTAssertEqual(FilePreviewLink.reference(from: routed)?.path, "~/Library/Caches")
    }
}
