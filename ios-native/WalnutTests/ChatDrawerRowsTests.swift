import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// The drawer's Recents rows: what the list may iterate.
///
/// A `ForEach` over an `Identifiable` collection with a repeated id is undefined
/// behaviour in SwiftUI, not a cosmetic double row — the copies share view
/// identity, so state and animations cross between them. The live server's
/// conversation index carries duplicate ids, so this fold is the thing standing
/// between that data and the list.
final class ChatDrawerRowsTests: XCTestCase {

    private func conversation(
        _ id: String, _ title: String, updatedAt: String = "2026-09-07T00:00:00.000Z"
    ) -> ConversationSummary {
        ConversationSummary(id: id, title: title, updatedAt: updatedAt, messageCount: 0)
    }

    func testAListWithNoDuplicatesIsUntouched() {
        let rows = [conversation("a", "One"), conversation("b", "Two")]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["a", "b"])
    }

    /// FIRST occurrence wins: the server orders this list by recency, so the first
    /// copy is the freshest one.
    func testARepeatedIDKeepsTheFirstCopy() {
        let rows = [
            conversation("a", "Freshest", updatedAt: "2026-09-07T00:00:00.000Z"),
            conversation("b", "Other"),
            conversation("a", "Stale copy", updatedAt: "2026-08-01T00:00:00.000Z"),
        ]
        let out = ChatDrawer.uniqueByID(rows)
        XCTAssertEqual(out.map(\.id), ["a", "b"])
        XCTAssertEqual(out.first?.title, "Freshest")
    }

    /// Order is preserved for everything that survives — the fold must not
    /// resort the list into something the server did not send.
    func testSurvivingRowsKeepTheirOrder() {
        let rows = [
            conversation("c", "Three"), conversation("a", "One"),
            conversation("c", "Three again"), conversation("b", "Two"),
        ]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["c", "a", "b"])
    }

    func testAnEmptyListStaysEmpty() {
        XCTAssertTrue(ChatDrawer.uniqueByID([]).isEmpty)
    }

    /// Every row duplicated: one of each, still in order.
    func testAWhollyDuplicatedListCollapsesToOneOfEach() {
        let rows = [
            conversation("a", "One"), conversation("a", "One"),
            conversation("b", "Two"), conversation("b", "Two"),
        ]
        XCTAssertEqual(ChatDrawer.uniqueByID(rows).map(\.id), ["a", "b"])
    }

    // MARK: - Where New chat sits

    /// THE PILL MUST NOT SHARE A POINT WITH A ROW.
    ///
    /// It shipped twice as a floating overlay over the bottom of the list, and the device
    /// gate lost a tap to it in both rounds: at the drawer's DEFAULT scroll position the
    /// last row's frame and the pill's overlapped by 41pt, so a thumb in that band opened
    /// a new draft instead of the conversation it was aimed at. A bottom content inset
    /// did not fix it — an inset only promises the last row CAN be scrolled clear, and
    /// nothing scrolls when the drawer opens.
    ///
    /// Measured in PIXELS, off two renders of the real view. The previous version of this
    /// test read `accessibilityFrame`s and was worthless: a hosted SwiftUI tree publishes
    /// no accessibility elements unless an assistive technology is running, so it passed
    /// only while maestro happened to have the simulator's accessibility server warm, and
    /// on a clean machine it failed with "this test measured nothing". `ImageRenderer`
    /// depends on nothing outside the process.
    ///
    /// How the two things are located without asking the view where they are:
    ///  - the PILL is the only tint-filled shape in the drawer, so tint pixels are it
    ///    (checked against a capsule's plausible size, so stray ink cannot stand in);
    ///  - the ROWS are what CHANGES between a 1-row drawer and a 24-row one, so the
    ///    差 between the two images is the row band.
    ///
    /// RED PROOF: putting `newChatPill` back in an `.overlay(alignment: .bottom)` — with
    /// or without a bottom inset on the list — moves the tint pixels into the row band
    /// and fails.
    @MainActor
    func testNewChatNeverSharesAPointWithAConversationRow() {
        let width = 329, height = 874
        let tint = UIColor(Theme.tint).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: .light))
        var tintRGB = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
        tint.getRed(&tintRGB.r, green: &tintRGB.g, blue: &tintRGB.b, alpha: &tintRGB.a)
        let target = (UInt8(tintRGB.r * 255), UInt8(tintRGB.g * 255), UInt8(tintRGB.b * 255))

        /// The drawer rendered off-screen, as raw RGBA rows.
        func render(rows: Int) -> [UInt8] {
            let store = ChatStore(transport: MockChatMessagesTransport())
            store.conversations = (0..<rows).map {
                conversation("conv-\($0)", "Conversation number \($0)",
                             updatedAt: "2026-09-1\($0 % 2)T00:00:00.000Z")
            }
            let view = ChatDrawer(suppressTaps: .constant(false), close: {})
                .environment(store)
                .frame(width: CGFloat(width), height: CGFloat(height))
                .background(Color.white)
            // A window, because a drawer is a ScrollView and `ImageRenderer` came back
            // uniformly blank for it; `drawHierarchy` renders what a real window shows.
            let host = UIHostingController(rootView: view)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
            window.rootViewController = host
            window.isHidden = false
            window.makeKeyAndVisible()
            host.view.frame = CGRect(x: 0, y: 0, width: width, height: height)
            host.view.layoutIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
            host.view.layoutIfNeeded()
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            format.opaque = true
            let image = UIGraphicsImageRenderer(
                size: CGSize(width: width, height: height), format: format).image { _ in
                    host.view.drawHierarchy(
                        in: CGRect(x: 0, y: 0, width: width, height: height),
                        afterScreenUpdates: true)
                }
            guard let cg = image.cgImage else { return [] }
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            let ctx = CGContext(data: &bytes, width: width, height: height,
                               bitsPerComponent: 8, bytesPerRow: width * 4,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
            return bytes
        }

        let one = render(rows: 1)
        let many = render(rows: 24)
        guard one.count == width * height * 4, many.count == width * height * 4 else {
            return XCTFail("the drawer did not render — nothing was measured")
        }

        // The pill: tint-coloured pixels.
        var pillMinY = height, pillMaxY = -1, pillMinX = width, pillMaxX = -1
        // The rows: where the 24-row drawer differs from the 1-row one.
        var rowsMinY = height, rowsMaxY = -1
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                if abs(Int(many[i]) - Int(target.0)) < 24,
                   abs(Int(many[i + 1]) - Int(target.1)) < 24,
                   abs(Int(many[i + 2]) - Int(target.2)) < 24 {
                    pillMinY = min(pillMinY, y); pillMaxY = max(pillMaxY, y)
                    pillMinX = min(pillMinX, x); pillMaxX = max(pillMaxX, x)
                }
                if abs(Int(many[i]) - Int(one[i])) > 12
                    || abs(Int(many[i + 1]) - Int(one[i + 1])) > 12
                    || abs(Int(many[i + 2]) - Int(one[i + 2])) > 12 {
                    rowsMinY = min(rowsMinY, y); rowsMaxY = max(rowsMaxY, y)
                }
            }
        }
        var distinct = Set<UInt32>()
        for i in stride(from: 0, to: many.count, by: 4) {
            distinct.insert(UInt32(many[i]) << 16 | UInt32(many[i + 1]) << 8 | UInt32(many[i + 2]))
            if distinct.count > 40 { break }
        }
        print("PROBE-DRAWER pill=[\(pillMinX),\(pillMinY)][\(pillMaxX),\(pillMaxY)] "
              + "rowBand=[\(rowsMinY),\(rowsMaxY)] distinctColours=\(distinct.count) "
              + "first=\(many[0]),\(many[1]),\(many[2]),\(many[3]) "
              + "target=\(target.0),\(target.1),\(target.2)")

        // Both things have to have been FOUND, or the comparison below is vacuous.
        XCTAssertGreaterThan(pillMaxY, 0, "no tint pixels: the pill did not render")
        let pillW = pillMaxX - pillMinX + 1, pillH = pillMaxY - pillMinY + 1
        XCTAssertTrue((90...220).contains(pillW) && (36...70).contains(pillH),
                      "the tint region \(pillW)x\(pillH) is not the New chat capsule")
        XCTAssertGreaterThan(rowsMaxY - rowsMinY, 300,
                            "the 24-row drawer barely differs from the 1-row one, so the "
                                + "row band was not found")

        // THE PROPERTY: the pill's pixels and the rows' band do not overlap, and the pill
        // is above them — which is what makes it hold at every scroll offset, not just
        // this one.
        XCTAssertLessThan(pillMaxY, rowsMinY,
                          "New chat occupies [\(pillMinY),\(pillMaxY)] and rows start at "
                              + "\(rowsMinY) — a tap in the shared band goes to the wrong one")
    }
}
