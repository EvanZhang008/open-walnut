import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// The 2026-09-12 gate's remaining findings on the activity drawer and its chips:
/// a 21pt tap target with a 14pt dead zone, a drag-to-dismiss-only sheet, and a
/// drawer that could only ever show the server's clipped excerpt.
///
/// Pure logic and real UIKit hit testing — no simulator UI driving.
@MainActor
final class ActivityDrawerPolishTests: XCTestCase {
    private let pageWidth: CGFloat = 393

    override func tearDown() {
        TimelineTextStyler.adopt(.unspecified)
        super.tearDown()
    }

    private func chipRow(height: CGFloat = 27) -> TimelineRow {
        TimelineRow(id: "m0#0", revision: 0,
                    content: .toolChip(name: "Bash", detail: "npm test", inputPreview: nil,
                                       resultPreview: nil, agent: nil, phase: .transcript,
                                       detailRef: nil, stacked: false),
                    height: height)
    }

    private func textRow() -> TimelineRow {
        TimelineRow(id: "m1#0", revision: 0,
                    content: .chip(icon: "clock", text: "a plain capsule"),
                    height: 27)
    }

    // MARK: - Tap target

    /// A chip's capsule is ~21pt of ink in a ~27pt cell on a ~37pt pitch
    /// (`TimelineLayout.rowSpacing` is 10), so ~14pt between two chips belonged to
    /// no cell and a thumb landing there did nothing at all. HIG asks for 44pt,
    /// which is TALLER THAN THE PITCH — so the outset is what the cell claims from
    /// the gap, and the total has to reach 44.
    ///
    /// RED PROOF: reverting the cell to a plain `UICollectionViewCell` (or the chip
    /// to `.contentShape(Capsule())`) leaves the mid-gap point unhit.
    func testChipCellsAcceptATapAtLeastFortyFourPointsTall() {
        let cell = TimelineHostedRowCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 27))
        TimelineHostedCell.configure(cell, row: chipRow(), delegate: nil)
        XCTAssertGreaterThan(cell.verticalHitOutset, 0,
                             "a chip row has to claim part of the inter-row gap")
        let total = cell.bounds.height + cell.verticalHitOutset * 2
        XCTAssertGreaterThanOrEqual(total, TimelineHostedCell.minimumTapHeight,
                                    "tappable height came out \(total)pt")

        // Every point in that band is accepted, including the ones that used to be
        // dead: the middle of the gap above and below the cell.
        let x = pageWidth / 2
        for y in [-cell.verticalHitOutset + 0.5, 0, 13.5, 27, 27 + cell.verticalHitOutset - 0.5] {
            XCTAssertTrue(cell.point(inside: CGPoint(x: x, y: y), with: nil),
                          "y=\(y) must be a tap on this row")
        }
        // …and nothing beyond it, or a chip would swallow the row after next.
        XCTAssertFalse(cell.point(inside: CGPoint(x: x, y: -cell.verticalHitOutset - 2), with: nil))
        XCTAssertFalse(cell.point(inside: CGPoint(x: x, y: 27 + cell.verticalHitOutset + 2), with: nil))
    }

    /// The outset is for CHIPS only. A text or capsule row expanding into the gap
    /// would steal touches from the chip under it, which is a worse bug than the
    /// dead zone: the tap would land on something that does nothing.
    func testOnlyChipRowsClaimTheGap() {
        let cell = TimelineHostedRowCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 27))
        TimelineHostedCell.configure(cell, row: textRow(), delegate: nil)
        XCTAssertEqual(cell.verticalHitOutset, 0)
        XCTAssertFalse(cell.point(inside: CGPoint(x: 10, y: 30), with: nil),
                       "a non-chip row keeps strictly to its own bounds")
    }

    /// A row that is ALREADY 44pt or taller (an accessibility text size) needs no
    /// outset — and must not get a negative one, which would shrink its own target.
    func testATallChipRowNeedsNoOutset() {
        let cell = TimelineHostedRowCell(frame: CGRect(x: 0, y: 0, width: pageWidth, height: 52))
        TimelineHostedCell.configure(cell, row: chipRow(height: 52), delegate: nil)
        XCTAssertEqual(cell.verticalHitOutset, 0,
                       "the row already exceeds the minimum; the gap stays neutral")
    }

    // MARK: - Dynamic Type

    /// The chevron was a literal `.font(.system(size: 8))`, so at XXXL the caption
    /// beside it had nearly doubled while the one glyph carrying the row's
    /// affordance stayed 8pt and all but vanished.
    ///
    /// MEASURED OFF THE RENDERED VIEW, not off the sizing helper.
    ///
    /// The version of this test that shipped called `TimelineTextStyler.adopt(...)`
    /// itself and then asserted `TimelineTextStyler.scaled(8, relativeTo: .caption2)`.
    /// It was green for a full round while the SHIPPED APP drew the same 4x7pt glyph at
    /// every text size, because the app never adopts a category on the path that
    /// renders the chevron and the helper then fell back to a `UITraitCollection.current`
    /// that is not the window's. Priming a global and asking it what it was primed with
    /// is not a test of anything.
    ///
    /// So: render `TimelineChipChevron` at two text sizes through the same environment
    /// the cell gives it, and compare what SwiftUI lays out.
    ///
    /// RED PROOF: reverting the view to `.font(.system(size: 8))` — or to the helper —
    /// makes both sizes identical and fails the growth assertion.
    @MainActor
    func testTheRenderedChevronGrowsWithTheEnvironmentsTextSize() {
        func rendered(_ size: DynamicTypeSize) -> CGSize {
            let host = UIHostingController(
                rootView: TimelineChipChevron().dynamicTypeSize(size))
            return host.sizeThatFits(in: CGSize(width: CGFloat(200),
                                               height: CGFloat.greatestFiniteMagnitude))
        }
        let base = rendered(.large)
        let huge = rendered(.accessibility5)
        XCTAssertGreaterThan(base.height, 0, "the glyph has to render at all")
        XCTAssertGreaterThan(huge.height, base.height * 1.5,
                             "the one glyph that says the row OPENS must grow with the "
                                 + "line it sits on — base \(base), XXXL \(huge)")
        XCTAssertGreaterThan(huge.width, base.width)
    }

    /// The stacking rule has TWO spellings — the builder reserves height from a
    /// `UIContentSizeCategory`, the cell draws from SwiftUI's `DynamicTypeSize` — and a
    /// row measured for one line while drawn as two is ink shaved off by the cell's
    /// clip. They have to agree for every category, not just the ones I thought of.
    func testBothSpellingsOfTheStackingRuleAgreeEverywhere() {
        let pairs: [(UIContentSizeCategory, DynamicTypeSize)] = [
            (.extraSmall, .xSmall), (.small, .small), (.medium, .medium),
            (.large, .large), (.extraLarge, .xLarge), (.extraExtraLarge, .xxLarge),
            (.extraExtraExtraLarge, .xxxLarge),
            (.accessibilityMedium, .accessibility1),
            (.accessibilityLarge, .accessibility2),
            (.accessibilityExtraLarge, .accessibility3),
            (.accessibilityExtraExtraLarge, .accessibility4),
            (.accessibilityExtraExtraExtraLarge, .accessibility5),
        ]
        for (category, size) in pairs {
            XCTAssertEqual(TimelineChipLayout.stacksDetail(category),
                           TimelineChipLayout.stacksDetail(size),
                           "\(category.rawValue) and \(size) must answer the same")
        }
        // And the rule itself: ordinary sizes keep one line, accessibility sizes stack.
        XCTAssertFalse(TimelineChipLayout.stacksDetail(UIContentSizeCategory.extraExtraExtraLarge))
        XCTAssertTrue(TimelineChipLayout.stacksDetail(UIContentSizeCategory.accessibilityMedium))
        // `.unspecified` is not an accessibility size, so a build that never adopted a
        // category behaves like an ordinary one rather than stacking every chip.
        XCTAssertFalse(TimelineChipLayout.stacksDetail(UIContentSizeCategory.unspecified))
    }

    /// THE VISIBLE CHARACTERS HAVE TO BE THE INFORMATIVE ONES. Stacking gave the detail
    /// its own line, and on the phone at XXXL that line still only fits about a dozen
    /// glyphs — so a middle ellipsis spent them on both ends at once and the gate read
    /// "Chec…sk note" off a chip whose detail is "Check walnut CLI session tools and
    /// latest CMES task note".
    ///
    /// Measured, not asserted against a literal: rasterise the clipped line and the
    /// same string with no width limit, then count how many leading pixel columns the
    /// two agree on. That count IS the readable head, in pixels, and it is the number
    /// the reader's eye gets. Both modes are measured in the same run, so this compares
    /// two renderings rather than restating the setting.
    ///
    /// RED PROOF: putting `.middle` back on the stacked detail collapses the head to the
    /// `.middle` figure and fails the first assertion.
    @MainActor
    func testTheStackedDetailShowsItsHeadRatherThanBothEnds() {
        let detail = "Check walnut CLI session tools and latest CMES task note"
        let lineWidth: CGFloat = 256   // the stacked line's width on the phone, measured
        let scale = 2

        /// Per-column ink counts for one rendering.
        func columns(_ view: some View, width: CGFloat?) -> [Int] {
            let sized = width.map {
                AnyView(view.frame(width: $0, alignment: .leading))
            } ?? AnyView(view.fixedSize())
            let renderer = ImageRenderer(content: sized
                .dynamicTypeSize(.accessibility5)
                .background(Color.white))
            renderer.scale = CGFloat(scale)
            renderer.isOpaque = true
            guard let cg = renderer.uiImage?.cgImage else { return [] }
            let w = cg.width, h = cg.height
            var bytes = [UInt8](repeating: 0, count: w * h)
            guard let ctx = CGContext(data: &bytes, width: w, height: h, bitsPerComponent: 8,
                                      bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return [] }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return (0..<w).map { x in
                (0..<h).reduce(0) { $0 + (bytes[$1 * w + x] < 200 ? 1 : 0) }
            }
        }

        func line(_ mode: Text.TruncationMode) -> some View {
            Text(detail).font(.caption).lineLimit(1).truncationMode(mode)
        }
        let whole = columns(line(.tail), width: nil)   // no width limit ⇒ nothing elided
        XCTAssertGreaterThan(whole.count, Int(lineWidth) * scale,
                             "the unbounded reference must be wider than the clipped line")

        /// Leading columns the clipped line shares with the whole string.
        func head(_ mode: Text.TruncationMode) -> Int {
            let clipped = columns(line(mode), width: lineWidth)
            var i = 0
            while i < min(clipped.count, whole.count), abs(clipped[i] - whole[i]) <= 1 { i += 1 }
            return i
        }
        let tail = head(.tail)
        let middle = head(.middle)
        print("[chip] readable head at AX5: tail=\(tail)px middle=\(middle)px "
              + "of \(Int(lineWidth) * scale)px")
        XCTAssertGreaterThan(
            Double(tail), Double(middle) * 1.8,
            "the stacked detail has to show more of its beginning than a middle ellipsis "
                + "does — tail \(tail)px vs middle \(middle)px")
        XCTAssertGreaterThan(
            Double(tail), Double(Int(lineWidth) * scale) * 0.5,
            "over half the line should be real text before the ellipsis, got \(tail)px")
    }

    // MARK: - Show more

    /// SHOW MORE IS THE ONLY WAY PAST 20,000 CHARACTERS, and it shipped as a 61x14pt
    /// hit area — the smallest control in the app guarding the most content.
    ///
    /// Measures the REAL control: `TimelineActivityButton` is the view the sheet uses,
    /// hosted here on its own and asked what size it lays out at. The previous version
    /// of this test read the button's `accessibilityFrame` out of the hosted sheet and
    /// was WORTHLESS: a hosted SwiftUI tree publishes no accessibility elements unless
    /// an assistive technology is running, so it passed only while maestro happened to
    /// have the simulator's accessibility server warm, and failed on a clean machine
    /// with "nothing was measured". Nothing here depends on ambient state.
    ///
    /// RED PROOF: dropping `.frame(minHeight:)` from `TimelineActivityButton` puts the
    /// height back to 43.33pt and fails the first assertion.
    @MainActor
    func testTheDrawersControlsOfferAFullSizedTarget() {
        for title in ["Show more", "Try again"] {
            let host = UIHostingController(
                rootView: TimelineActivityButton(title, identifier: "x", action: {}))
            let size = host.sizeThatFits(
                in: CGSize(width: CGFloat(402), height: CGFloat.greatestFiniteMagnitude))
            XCTAssertGreaterThanOrEqual(
                size.height, TimelineHostedCell.minimumTapHeight,
                "\(title) came out \(size.height)pt tall")
            XCTAssertGreaterThanOrEqual(size.width, 44, "…and \(size.width)pt wide")
        }
    }

    /// THE STATUS BAR IS OUTSIDE THE SCROLLING TEXT, which is the whole point of it.
    ///
    /// Under its section, the footer and its button were unreachable at accessibility
    /// sizes: the same reasoning block that is 11 scroll pages at default type is 216 at
    /// XXXL, and the gate still had 112 pages left after 12 swipes. Pinned as a bottom
    /// safe-area inset, it is on screen at every text size and every offset.
    ///
    /// Measured on the real hosted sheet through the ONE handle that exists without
    /// accessibility: a `UIScrollView`. Content the scroll view has to scroll past is in
    /// `contentSize`; room reserved OUTSIDE that content is `adjustedContentInset`. So
    /// the assertion is not "a bar exists somewhere" but "a control's worth of room is
    /// held outside the text", which is exactly the property that failed.
    ///
    /// RED PROOF: moving `statusBar` back inside the `ScrollView`'s `VStack` drops the
    /// bottom inset to 0 and fails.
    @MainActor
    func testTheStatusBarIsPinnedOutsideTheScrollingText() {
        /// The sheet's scroll view, plus how much room is held below its content.
        func scrollView(withheldChars: Int) -> UIScrollView? {
            let detail = TimelineActivityDetail(
                id: "m0#0", kind: .thinking, title: "Thinking", subtitle: nil, input: nil,
                body: String(repeating: "reasoning-", count: withheldChars / 10),
                agent: nil, phase: .transcript, detailRef: nil)
            let host = UIHostingController(rootView: TimelineActivitySheet(detail: detail))
            let size = CGSize(width: 402, height: 874)
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.isHidden = false
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.frame = CGRect(origin: .zero, size: size)
            host.view.layoutIfNeeded()
            // Wait for the sheet's own `.task` to seed the section rather than guessing a
            // sleep: an empty body lays out to ~50pt ("No reasoning recorded" plus its
            // padding), which would make every assertion below vacuous.
            let deadline = Date().addingTimeInterval(4)
            func tallest() -> UIScrollView? {
                var all: [UIScrollView] = []
                func walk(_ v: UIView) {
                    if let sv = v as? UIScrollView { all.append(sv) }
                    v.subviews.forEach(walk)
                }
                walk(host.view)
                return all.max { $0.contentSize.height < $1.contentSize.height }
            }
            while Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
                host.view.layoutIfNeeded()
                if (tallest()?.contentSize.height ?? 0) > 874 { break }
            }
            print("PROBE-SHEET chars=\(withheldChars) content=\(tallest()?.contentSize.height ?? -1) "
                  + "inset=\(tallest()?.adjustedContentInset.bottom ?? -1)")
            // The TALLEST scroll view is the text. A sheet has more than one (the
            // navigation bar contributes a short one), and taking the first match found
            // a 50pt-tall one that never carried the body.
            var all: [UIScrollView] = []
            func walk(_ v: UIView) {
                if let sv = v as? UIScrollView { all.append(sv) }
                v.subviews.forEach(walk)
            }
            walk(host.view)
            return all.max { $0.contentSize.height < $1.contentSize.height }
        }

        // 30,000 characters: past the render window, so the bar carries the numbers AND
        // a Show more.
        guard let withheld = scrollView(withheldChars: 30_000) else {
            return XCTFail("no scroll view in the hosted sheet — nothing was measured")
        }
        XCTAssertGreaterThan(withheld.contentSize.height, 874,
                            "the text has to be long enough to scroll, or the bar's "
                                + "position is not being tested at all")
        XCTAssertGreaterThanOrEqual(
            withheld.adjustedContentInset.bottom, TimelineHostedCell.minimumTapHeight,
            "the pinned bar must hold a control's worth of room outside the text; "
                + "inset was \(withheld.adjustedContentInset.bottom)pt")

        // A short, complete section says nothing, so no room is held.
        guard let whole = scrollView(withheldChars: 40) else {
            return XCTFail("no scroll view for the complete row")
        }
        XCTAssertLessThan(
            whole.adjustedContentInset.bottom, TimelineHostedCell.minimumTapHeight,
            "a complete row must open onto plain text with no status bar; inset was "
                + "\(whole.adjustedContentInset.bottom)pt")
    }

    /// A WITHHELD SECTION WITH NOTHING TO PRESS RENDERS THE NUMBERS AND NO CONTROL.
    ///
    /// This is a real server state, not a hypothetical: an unreachable row answers with
    /// a true `resultChars`, `resultTruncated: true` and NO cursor, so there is more text
    /// and no way to ask for it. The numbers are a fact to state; a button would be a
    /// control that cannot do anything.
    ///
    /// Measured on the RENDERED row, not by asking `offersShowMore`: the row is hosted
    /// and its laid-out height compared. A row carrying the button cannot be shorter than
    /// the 44pt target; a row of caption2 words alone cannot reach it. So the height
    /// answers "is there a control here" without touching accessibility.
    ///
    /// The fixture is DECODED from the response JSON rather than built in Swift, so the
    /// measurement runs from the wire bytes all the way to a laid-out height — the shape
    /// is exactly what the route answers for an unreachable row, field names included.
    @MainActor
    func testAWithheldSectionWithNoWayOnwardRendersNoControl() throws {
        func height(_ section: TimelineDrawerSection) -> CGFloat {
            let host = UIHostingController(rootView: TimelineActivityWithheldRow(
                label: nil, section: section, widen: {}))
            return host.sizeThatFits(
                in: CGSize(width: CGFloat(370), height: CGFloat.greatestFiniteMagnitude)).height
        }

        // Unreachable remainder: 19 characters of a 24,291-character source, the section's
        // own flag set, and NO `resultNextOffset` anywhere in the payload.
        let json = """
        {"version":1,"kind":"tool","toolName":"Bash","offset":0,
         "result":"the first part only","resultChars":24291,"resultTruncated":true,
         "truncated":true}
        """
        let wire = try XCTUnwrap(
            try JSONDecoder().decode(TimelineActivityFullText.Payload.self,
                                     from: Data(json.utf8)).detail.result)
        XCTAssertNil(wire.nextOffset, "the fixture must carry no cursor")
        XCTAssertTrue(wire.truncated, "…and the section's own flag has to survive decoding")
        let unreachable = TimelineActivitySheet.drawerSection(wire)
        XCTAssertTrue(unreachable.withholding, "the fixture has to be a withheld section")
        XCTAssertEqual(unreachable.total, 24_291, "the true source length is stated")
        XCTAssertFalse(TimelineActivitySheet.offersShowMore(unreachable),
                       "nothing to press: no cursor, and the 19 characters already fit")
        let mute = height(unreachable)
        XCTAssertGreaterThan(mute, 0, "the row still states the numbers")
        XCTAssertLessThan(mute, TimelineHostedCell.minimumTapHeight,
                          "a row with no control cannot be as tall as a tap target; "
                              + "got \(mute)pt")

        // The same section once the text IS here and only the window is small.
        let advanceable = TimelineActivitySheet.drawerSection(
            .init(text: String(repeating: "o", count: 30_000), totalChars: 30_000,
                  nextOffset: nil, truncated: true))
        let withControl = height(advanceable)
        XCTAssertGreaterThanOrEqual(
            withControl, TimelineHostedCell.minimumTapHeight,
            "this one CAN advance, so the row carries the button; got \(withControl)pt")
        print("PROBE-WITHHELD mute=\(mute)pt withControl=\(withControl)pt")
    }

    /// THE DEVICE CAN REACH THE WITHHELD STATE AT ALL. A live server clips a
    /// reasoning excerpt to 2,001 characters and a tool result to 700, both far under
    /// the render window, so on real data the footer says nothing and no control
    /// appears — measured on the running Mac: `GET /api/v1/activity/detail` answers
    /// 404 there and 0 of 641 activity rows across 20 conversations carry a
    /// `detailRef`. The DEBUG harness row is therefore the only way a device pass
    /// (or the gate) can look at the pinned footer and its button.
    ///
    /// So the fixture's own length is the thing to pin: shrink it under the window and
    /// the state it exists to show quietly stops existing, while every flow that taps
    /// it still passes.
    func testTheHarnessOffersARowTheDrawerHasToWithhold() throws {
        let store = TimelineHarnessStore()
        let before = store.messages.count
        store.appendWithheldMessages()
        let added = Array(store.messages.dropFirst(before))
        XCTAssertFalse(added.isEmpty, "the control has to append something")

        let window = TimelineDrawerSection.renderWindow
        let thinking = try XCTUnwrap(added.first { $0.kind == .thinking })
        let reasoning = TimelineDrawerSection(try XCTUnwrap(thinking.thinkingText))
        XCTAssertGreaterThan(reasoning.total, window,
                             "the reasoning fixture has to exceed the render window")
        XCTAssertTrue(reasoning.withholding, "…so the drawer must state the numbers")
        XCTAssertTrue(TimelineActivitySheet.offersShowMore(reasoning),
                      "…and carry the control the gate could not reach")

        let tool = try XCTUnwrap(added.first { $0.kind == .tool })
        let result = TimelineDrawerSection(try XCTUnwrap(tool.resultPreview))
        XCTAssertGreaterThan(result.total, window, "the result fixture too")
        XCTAssertTrue(TimelineActivitySheet.offersShowMore(result))
    }

    // MARK: - The drawer's two-stage text

    /// The excerpt is on screen from the first frame and the full text replaces it.
    /// Never a spinner where text already is.
    func testTheDrawerSeedsFromTheRowThenReplacesWithWhatItFetched() {
        let excerpt = String(repeating: "a", count: 2_000) + "…"
        var section = TimelineDrawerSection(excerpt)
        XCTAssertEqual(section.visible.count, min(2_001, TimelineDrawerSection.renderWindow))
        XCTAssertFalse(section.withholding, "2,001 characters fit the window with room to spare")

        section = TimelineDrawerSection(String(repeating: "b", count: 4_380))
        XCTAssertEqual(section.total, 4_380)
        XCTAssertFalse(section.withholding)
    }

    /// NEVER A SILENT TRUNCATION. Whenever anything is withheld — by the server's
    /// own page cut or by the drawer's render window — the sheet says so with both
    /// numbers.
    func testWithheldTextIsAlwaysStatedWithItsNumbers() {
        let window = TimelineDrawerSection.renderWindow
        // Cut by the render window: we hold more than we draw.
        let big = TimelineDrawerSection(String(repeating: "c", count: window + 500))
        XCTAssertTrue(big.withholding)
        XCTAssertEqual(big.visible.count, window)
        XCTAssertEqual(TimelineActivitySheet.withheldText(shown: window, total: big.total),
                       "Showing the first \(window.formatted()) of \((window + 500).formatted()) characters.")

        // Cut by the SERVER: everything it sent is drawn, but it has more.
        let paged = TimelineDrawerSection("short", serverChars: 918_273, cut: true)
        XCTAssertTrue(paged.withholding, "a server-side page cut is withheld text too")
        XCTAssertEqual(paged.visible, "short")
        XCTAssertEqual(paged.total, 918_273)

        // Nothing withheld ⇒ nothing said.
        XCTAssertFalse(TimelineDrawerSection("all of it").withholding)

        // A TOTAL THAT IS ONLY A LOWER BOUND still cannot undercut what is drawn.
        // The server's `*Chars` is exact for every section EXCEPT a cut input, where
        // it counts what the renderer measured and nothing has measured the
        // remainder — so it can arrive smaller than the text that came with it. The
        // footer would then read "Showing the first 5,000 of 900 characters", which
        // is nonsense rather than an understatement.
        //
        // RED PROOF: dropping the `max` in `total` makes this 900.
        let understated = TimelineDrawerSection(String(repeating: "x", count: 5_000),
                                                serverChars: 900, cut: true)
        XCTAssertEqual(understated.total, 5_000,
                       "a lower-bound total is raised to what we actually hold")
        XCTAssertTrue(understated.withholding, "the server still says there is more")
    }

    /// A SECTION WITH NO CURSOR CAN STILL BE SHORT. The server sends less than the row
    /// holds, with no way to fetch the rest, when the row has slid out of a huge
    /// transcript's read window or its host is unreachable — and it reports the true
    /// source length regardless. Reading withheld-ness off the cursor alone made that
    /// case say nothing at all, which is the silent truncation this drawer exists to
    /// avoid.
    ///
    /// RED PROOF: `cut: s.nextOffset != nil` (what shipped) makes the first assertion
    /// false while the numbers sit right there in the payload.
    func testASectionShorterThanItsSourceIsStatedEvenWithNoCursorToFollow() {
        let unfetchable = TimelineActivitySheet.drawerSection(
            .init(text: "the first part only", totalChars: 24_291, nextOffset: nil))
        XCTAssertTrue(unfetchable.withholding,
                      "M > N with no cursor is still withheld text")
        XCTAssertEqual(unfetchable.total, 24_291, "…and the footer prints the true total")
        XCTAssertEqual(
            TimelineActivitySheet.withheldText(shown: unfetchable.chars,
                                               total: unfetchable.total),
            "Showing the first 19 of 24,291 characters.")

        // …and it offers NO button, because pressing one could not advance: there is no
        // cursor, and the 19 characters we hold already fit the render window. A control
        // that cannot do anything is worse than no control.
        XCTAssertFalse(TimelineActivitySheet.offersShowMore(unfetchable),
                       "nothing to press when the remainder is unreachable")

        // Complete and exact ⇒ nothing said, no matter that a total came with it.
        let whole = TimelineActivitySheet.drawerSection(
            .init(text: "all of it", totalChars: 9, nextOffset: nil))
        XCTAssertFalse(whole.withholding)
        XCTAssertFalse(TimelineActivitySheet.offersShowMore(whole))
    }

    /// A SECTION'S OWN `<name>Truncated` FLAG IS BELIEVED, and the payload-wide
    /// `truncated` is never applied to a section.
    ///
    /// Decoded from real response JSON so the wire NAMES are pinned: a typo in
    /// `inputTruncated` would otherwise be invisible — the section would just report
    /// itself whole, which is the silent-footer bug all over again.
    ///
    /// This is the server's own split case: a Write whose input was clipped while its
    /// result ("wrote 202000 bytes") is complete. The input's total is a LOWER BOUND
    /// equal to the text it came with, so arithmetic cannot see the clip — only the
    /// flag can. And the payload says `truncated: true` for the row, which must not
    /// reach the result: a complete section may never claim it was elided.
    func testASectionsOwnTruncatedFlagIsBelievedAndTheRowWideOneIsNotApplied() throws {
        let clipped = String(repeating: "x", count: 202)
        let json = """
        {"version":1,"kind":"tool","toolName":"Write","offset":0,
         "input":"\(clipped)","inputChars":202,"inputTruncated":true,
         "result":"wrote 202000 bytes","resultChars":18,
         "truncated":true}
        """
        let payload = try JSONDecoder().decode(
            TimelineActivityFullText.Payload.self, from: Data(json.utf8))
        let detail = payload.detail

        let input = try XCTUnwrap(detail.input)
        XCTAssertTrue(input.truncated, "the section's own flag has to survive decoding")
        XCTAssertNil(input.nextOffset, "no cursor in this shape")
        XCTAssertEqual(input.totalChars, input.text.count,
                       "…and the total is a lower bound equal to the text, so the "
                           + "arithmetic path is blind here — the flag is the only witness")
        XCTAssertTrue(TimelineActivitySheet.drawerSection(input).withholding,
                      "a clipped input must still be stated")

        let result = try XCTUnwrap(detail.result)
        XCTAssertFalse(result.truncated,
                       "the row-wide truncated:true must not become the result's flag")
        XCTAssertFalse(TimelineActivitySheet.drawerSection(result).withholding,
                       "the result is whole; saying otherwise is the lie we removed")
    }

    /// A LONG RESULT BEHAVES LIKE A LONG REASONING BLOCK. The server lifted the
    /// 5,000-character cap on tool results, so a result can now be the thing that
    /// exceeds the 20,000-character render window — a path only reasoning used to take.
    ///
    /// Measured rather than asserted by reading the code: the same 30,000 characters go
    /// through both section slots and every visible consequence has to match.
    func testALongResultIsWindowedExactlyLikeLongReasoning() {
        let long = String(repeating: "o", count: 30_000)
        let reasoning = TimelineActivitySheet.drawerSection(
            .init(text: long, totalChars: 30_000, nextOffset: nil))
        let result = TimelineActivitySheet.drawerSection(
            .init(text: long, totalChars: 30_000, nextOffset: nil))

        XCTAssertEqual(result.visible.count, reasoning.visible.count)
        XCTAssertEqual(result.visible.count, TimelineDrawerSection.renderWindow)
        XCTAssertEqual(result.total, reasoning.total)
        XCTAssertEqual(result.withholding, reasoning.withholding)
        XCTAssertTrue(result.withholding)
        XCTAssertEqual(TimelineActivitySheet.offersShowMore(result),
                       TimelineActivitySheet.offersShowMore(reasoning))
        XCTAssertTrue(TimelineActivitySheet.offersShowMore(result),
                      "this one CAN advance: the text is here, only the window is small")
        XCTAssertEqual(
            TimelineActivitySheet.withheldText(shown: min(result.chars, result.window),
                                               total: result.total),
            "Showing the first 20,000 of 30,000 characters.")

        // One press covers the rest, and then the footer stops.
        var widened = result
        widened.window += TimelineDrawerSection.renderWindow
        XCTAssertEqual(widened.visible.count, 30_000)
        XCTAssertFalse(widened.withholding)
        XCTAssertFalse(TimelineActivitySheet.offersShowMore(widened))
    }

    /// EXACTLY ONE failure earns words, and it is the one the server states
    /// unambiguously (410 `detail_gone`). An OLD SERVER (404) must stay mute: it is
    /// the common answer while the Mac and the replica catch up, and wording it would
    /// announce "the text is gone" on nearly every drawer with the excerpt sitting
    /// right there.
    ///
    /// RED PROOF: mapping 404 back onto `.gone` (which is what shipped before the
    /// server grew the typed code) makes `explains` true for an old server, and the
    /// second assertion fails.
    func testOnlyTheTypedGoneOutcomeEarnsWords() {
        XCTAssertTrue(TimelineActivitySheet.explains(.gone),
                      "410 is the server saying the row is really unreachable")
        XCTAssertFalse(TimelineActivitySheet.explains(.unsupported),
                       "404 means this box predates the route — not a missing row")
        XCTAssertFalse(TimelineActivitySheet.explains(.rejected))
        XCTAssertFalse(TimelineActivitySheet.explains(.unavailable),
                       "a stall the reader cannot act on is not worth a line")
        // …and the one sentence names what IS on screen, without asking for an
        // action nobody can take.
        XCTAssertTrue(TimelineActivitySheet.goneText.contains("excerpt"))
        for nudge in ["try again", "retry", "check your"] {
            XCTAssertFalse(TimelineActivitySheet.goneText.lowercased().contains(nudge),
                           "a compacted transcript cannot be retried into existence")
        }
    }

    /// Retrying is a separate question from wording, and only the unreachable
    /// outcome answers yes to it.
    func testOnlyAnUnreachableFetchIsRetried() {
        XCTAssertTrue(TimelineActivitySheet.shouldRetry(.unavailable),
                      "unreachable is the one outcome another attempt can fix")
        XCTAssertFalse(TimelineActivitySheet.shouldRetry(.gone))
        XCTAssertFalse(TimelineActivitySheet.shouldRetry(.unsupported),
                       "a box with no route will not grow one on the second call")
        XCTAssertFalse(TimelineActivitySheet.shouldRetry(.rejected),
                       "a 400 is a bug on one side; hammering it is not a fix")
    }

    /// The seam's real transport, not a mock: a unit-test process is pointed at the
    /// discard port, so this is a genuine refused connection, and it must come back
    /// as the RETRYABLE outcome rather than as "gone".
    func testAnUnreachableServerIsTheRetryableOutcome() async {
        do {
            _ = try await TimelineActivityFullText.fetch(ref: "s/abc#3")
            XCTFail("a dead server cannot have answered")
        } catch let error as TimelineActivityFullText.Failure {
            XCTAssertEqual(error, .unavailable)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// Status → outcome. None of these becomes visible copy (see above); the mapping
    /// exists so the retry decision and the paging caller can tell them apart.
    func testHttpStatusMapsToTheRightOutcome() {
        func failure(_ status: Int) -> TimelineActivityFullText.Failure {
            TimelineActivityFullText.failure(for: .server(
                status: status, code: "x", message: "y", serverHash: nil, serverContent: nil))
        }
        XCTAssertEqual(failure(410), .gone, "the typed detail_gone is the only real \"row is missing\"")
        XCTAssertEqual(failure(404), .unsupported, "no such route — an older build, not a missing row")
        XCTAssertEqual(failure(400), .rejected)
        XCTAssertEqual(failure(503), .unavailable)
        XCTAssertEqual(TimelineActivityFullText.failure(for: .badResponse), .unavailable,
                       "a transport error is the retryable shape")
    }

    /// The ref is OPAQUE, so every character that could re-partition a URL has to
    /// survive encoding.
    func testAnOpaqueRefSurvivesTheQueryString() {
        let ref = "s/abc+def=ghi&jkl?mno#pqr /xyz"
        let encoded = TimelineActivityFullText.encode(ref)
        for character in ["&", "=", "?", "#", "+", "/", " "] {
            XCTAssertFalse(encoded.contains(character),
                           "\(character) must be escaped, not passed through: \(encoded)")
        }
        XCTAssertEqual(encoded.removingPercentEncoding, ref)
    }

    /// A row with no ref is the NORMAL case (every older server, and the cloud
    /// replica until it catches up). It must not look like an error, and the seam
    /// must not be called at all.
    func testAMissingRefIsNotAFailure() async {
        let row = ChatMessage(id: "m0", role: "assistant", text: "line",
                              createdAt: "2026-09-12T06:00:00Z", kind: .thinking,
                              thinkingText: "the excerpt")
        XCTAssertNil(row.activityDetailRef)
        XCTAssertNil(ChatMessage(id: "m1", role: "assistant", text: "line",
                                 createdAt: "2026-09-12T06:00:00Z", kind: .thinking,
                                 detailRef: "   ").activityDetailRef,
                     "whitespace is not a ref")
        XCTAssertEqual(ChatMessage(id: "m2", role: "assistant", text: "line",
                                   createdAt: "2026-09-12T06:00:00Z", kind: .thinking,
                                   detailRef: "s/abc").activityDetailRef, "s/abc")

        // An empty ref never reaches the network.
        do {
            _ = try await TimelineActivityFullText.fetch(ref: "")
            XCTFail("an empty ref must be rejected locally")
        } catch let error as TimelineActivityFullText.Failure {
            XCTAssertEqual(error, .rejected)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    /// The ref reaches the row, and therefore the drawer.
    func testTheRefTravelsFromTheWireToTheDrawerPayload() async throws {
        let json = """
        [{"id":"m0","role":"assistant","text":"a collapsed line",
          "createdAt":"2026-09-12T06:00:00Z","kind":"thinking",
          "thinkingText":"the clipped excerpt…","detailRef":"s/abc#3"},
         {"id":"m1","role":"assistant","text":"Bash","createdAt":"2026-09-12T06:00:01Z",
          "kind":"tool","detail":"npm test","resultPreview":"ok…","detailRef":"s/abc#4"},
         {"id":"m2","role":"assistant","text":"short thought",
          "createdAt":"2026-09-12T06:00:02Z","kind":"thinking"}]
        """
        let decoded = try JSONDecoder().decode([ChatMessage].self, from: Data(json.utf8))
        XCTAssertEqual(decoded[0].detailRef, "s/abc#3")
        XCTAssertNil(decoded[2].detailRef, "an absent field decodes to nil, never a throw")

        let rows = await TimelineLayoutActor().buildSnapshot(TimelineInput(
            messages: decoded, streaming: false, liveText: "", liveTextTruncated: false,
            activity: nil, showLoadEarlier: false, width: pageWidth,
            expandedRowIDs: [])).rows
        guard case .thinking(_, _, _, _, let reasoningRef, _) = rows[0].content,
              case .toolChip(_, _, _, _, _, _, let toolRef, _) = rows[1].content,
              case .thinking(_, _, _, _, let noRef, _) = rows[2].content else {
            return XCTFail("unexpected row kinds: \(rows.map(\.content.reuseKind))")
        }
        XCTAssertEqual(reasoningRef, "s/abc#3")
        XCTAssertEqual(toolRef, "s/abc#4")
        XCTAssertNil(noRef)
    }
}
