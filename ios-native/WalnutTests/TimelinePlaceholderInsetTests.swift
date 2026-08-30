import XCTest
import SwiftUI
@testable import Walnut

/// The keyboard-safety rule for the transcript placeholders (P0, 2026-08-29).
///
/// ## What was measured
///
/// With the keyboard up in the main chat, `chat.send` sat at [358,512][390,544]
/// while the keyboard's own view (predictive/QuickType bar included) began at
/// y=528. The lower half of the send button was therefore under the predictive bar,
/// and a tap on it typed a predicted word into the draft instead of sending: silent
/// draft corruption on the app's primary send path.
///
/// Across 14 hierarchy dumps the send button's clearance below the keyboard was
/// exactly **-24pt whenever a transcript placeholder was on screen and exactly 0pt
/// whenever it was not**, with the same composer, the same paddings, the same
/// keyboard and the same `safeAreaInset`. That correlation is what ruled out the two
/// things originally blamed (the composer's own paddings, and `safeAreaInset` as the
/// hosting choice), and it is why the session composer looked healthy in the
/// refuter's run: that session had a real transcript.
///
/// ## Why the arithmetic is worth asserting
///
/// A placeholder that asks for more height than the page was offered overflows, the
/// stack's reported height grows with it, and the inset composer is placed relative
/// to that — so the composer's push tracks the overflow. The rule below removes the
/// overflow itself, which is why it is stated as "the padding must fit" rather than
/// as a smaller constant.
///
/// ## The numbers here are MEASURED, not modelled
///
/// Every constant below comes from the broken build's own hierarchy dump, and the
/// first draft of this file got that wrong in a way worth recording: it asserted a
/// "push = overflow / 2" model on a guessed 470pt page, and both halves were
/// invented. Reading the real dump instead: the slot between the nav bar (bottom
/// y=116) and the composer (top y=440) was **324pt**, the placeholder's text
/// measured **106pt** (glyph top 214 to subheadline bottom 320), so the fixed 120pt
/// padding wanted 346pt and overflowed by **22** against a **measured 24pt** push.
/// So the push is the overflow roughly 1:1, and the 470 never existed.
///
/// These cases drive `TimelinePlaceholderInset.padding` (the real decision) rather
/// than a hosted view, because the decision is pure arithmetic and a hosted-window
/// test could only re-measure SwiftUI. The end-to-end proof is by BOUNDS on the
/// simulator, in both composers.
final class TimelinePlaceholderInsetTests: XCTestCase {

    private typealias Inset = TimelinePlaceholderInset

    /// Height the transcript slot had in the reproduced defect (nav bar bottom to
    /// composer top, keyboard up, iPhone 16 Pro).
    private static let measuredSlot: CGFloat = 324

    /// The chat empty state's own text, measured in the same dump. Note this is well
    /// under `Inset.baseContentAllowance` (200) on purpose: the allowance is a
    /// deliberate over-estimate covering the tallest placeholder, so the padding
    /// starts yielding sooner than strictly necessary. Being generous there is safe;
    /// being stingy would let the overflow back.
    private static let measuredContentHeight: CGFloat = 106

    /// Dynamic Type multipliers the `@ScaledMetric` allowance actually produces,
    /// smallest to largest. `.headline` is 17pt at the default size and 53pt at
    /// accessibility-XXXL, so the allowance runs from roughly 0.9x to 3.1x of the
    /// 200pt base. The flat 200 was the round-2 defect: at the top of this range the
    /// copy needs three times what the estimate claimed, so the padding took the room
    /// the text needed and the headline came out as "Your Personal…".
    private static let typeScales: [CGFloat] = [0.9, 1.0, 1.2, 1.5, 1.9, 2.4, 3.1]

    /// What the placeholder actually occupies for a given padding choice, and hence
    /// how much of it spills past the page and onto the composer.
    private func overflow(
        vertical: CGFloat, availableHeight: CGFloat, contentHeight: CGFloat,
        allowance: CGFloat = Inset.baseContentAllowance
    ) -> CGFloat {
        let padding = Inset.padding(vertical: vertical, availableHeight: availableHeight,
                                    contentAllowance: allowance)
        return max(0, (contentHeight + 2 * padding) - availableHeight)
    }

    private func padding(
        vertical: CGFloat, availableHeight: CGFloat,
        allowance: CGFloat = Inset.baseContentAllowance
    ) -> CGFloat {
        Inset.padding(vertical: vertical, availableHeight: availableHeight,
                      contentAllowance: allowance)
    }

    // MARK: - The page has room: nothing changes

    /// A full-height page (no keyboard) must keep the generous spacing the
    /// placeholder was designed with. A fix that quietly tightened the empty state
    /// everywhere would be a regression dressed as a repair.
    func testFullHeightPageKeepsTheRequestedPadding() {
        XCTAssertEqual(padding(vertical: 120, availableHeight: 700), 120)
        XCTAssertEqual(padding(vertical: 100, availableHeight: 700), 100)
    }

    // MARK: - The keyboard-shrunk page: the padding yields

    /// The reproduced defect, at its measured geometry. The old fixed 120 did not fit
    /// in the 324pt slot; the rule must shrink it rather than overflow.
    func testTheMeasuredDefectGeometryNoLongerOverflows() {
        let capped = padding(vertical: 120, availableHeight: Self.measuredSlot)
        XCTAssertLessThan(capped, 120,
            "120 top + 120 bottom + 106pt of text cannot fit in a 324pt slot")
        XCTAssertEqual(
            overflow(vertical: 120, availableHeight: Self.measuredSlot,
                     contentHeight: Self.measuredContentHeight),
            0,
            "no overflow means nothing left to push the composer under the keyboard"
        )
    }

    /// The old behaviour, pinned as the thing that must never come back: the FIXED
    /// 120pt padding overflowed the measured slot, and that overflow is the push the
    /// dumps recorded on `chat.send`. Derived from the two measured heights rather
    /// than copied, so the mechanism claim is checkable and not just prose.
    func testTheOldFixedPaddingIsWhatPushedTheSendButtonUnderTheKeyboard() {
        let fixedOverflow = (Self.measuredContentHeight + 2 * 120) - Self.measuredSlot
        XCTAssertGreaterThan(fixedOverflow, 0, "the old padding genuinely did not fit")
        XCTAssertEqual(fixedOverflow, 24, accuracy: 3,
            "the overflow IS the composer's push: the measured -24pt clearance")
    }

    /// The actual acceptance criterion, generalised: for every page height a keyboard
    /// can leave behind, for each of the three placeholders' requested spacings, and
    /// for every Dynamic Type size (the allowance scales with it), the placeholder
    /// must not overflow, so nothing is ever pushed onto the send button.
    ///
    /// The content sweep runs up to each size's OWN allowance, which is the point of
    /// making the allowance scale: at accessibility sizes the copy really is ~3x
    /// taller, and the round-2 defect was a sweep like this one that only ever
    /// considered content up to a flat 200.
    func testNoPageHeightCanOverflowForAnyPlaceholderAtAnyContentSize() {
        for scale in Self.typeScales {
            let allowance = Inset.baseContentAllowance * scale
            for available in stride(from: CGFloat(120), through: 900, by: 10) {
                for wanted in [CGFloat(100), 120, 240] {
                    for content in stride(from: CGFloat(60),
                                          through: max(Inset.baseContentAllowance, allowance),
                                          by: 20) {
                        // A page too short for the text itself is the documented
                        // degrade-to-scroll case, not a clearance case: there is no
                        // composer room to protect at that size.
                        guard available >= content + 2 * Inset.minimumVertical else { continue }
                        XCTAssertEqual(
                            overflow(vertical: wanted, availableHeight: available,
                                     contentHeight: content, allowance: allowance),
                            0,
                            "at \(scale)x, wanted \(wanted) around \(content)pt of text in \(available)pt overflowed"
                        )
                    }
                }
            }
        }
    }

    // MARK: - Accessibility sizes: the copy gets the room, not the padding

    /// The round-2 defect, stated as arithmetic. On the measured keyboard-shrunk slot
    /// the flat 200pt allowance left 62pt of padding top and bottom, so the copy was
    /// offered 200pt, and at accessibility-XXXL the chat empty state needs roughly
    /// 430pt, which is how "Your Personal AI is listening" rendered as "Your
    /// Personal…". With a scaled allowance the padding collapses to its minimum and
    /// the copy is offered the whole slot instead.
    func testAccessibilitySizesSpendTheSlotOnTheCopyNotOnPadding() {
        let flat = padding(vertical: 120, availableHeight: Self.measuredSlot)
        XCTAssertEqual(flat, 62, accuracy: 0.5, "the shipped behaviour at the default size")

        let ax5 = padding(vertical: 120, availableHeight: Self.measuredSlot,
                          allowance: Inset.baseContentAllowance * 3.1)
        XCTAssertEqual(ax5, Inset.minimumVertical,
            "at AX5 every point of the slot belongs to the text")
        XCTAssertLessThan(ax5, flat, "a larger type size must yield MORE room, not the same")
    }

    /// The allowance is monotonic in the type size, so the room handed to the copy
    /// never falls as the text grows. A rule that granted more padding at a larger
    /// size would be the defect with extra steps.
    func testRoomForTheCopyNeverShrinksAsTheTypeSizeGrows() {
        for available in stride(from: CGFloat(200), through: 900, by: 20) {
            var previousRoom = -CGFloat.infinity
            for scale in Self.typeScales {
                let pad = padding(vertical: 120, availableHeight: available,
                                  allowance: Inset.baseContentAllowance * scale)
                let room = available - 2 * pad
                XCTAssertGreaterThanOrEqual(room, previousRoom,
                    "room for the copy fell going up to \(scale)x on a \(available)pt page")
                previousRoom = room
            }
        }
    }

    /// `@ScaledMetric` scales DOWN as well (xSmall returns ~180 for a 200pt base), and
    /// a smaller estimate would grant MORE padding than the size the constant was
    /// validated at. The allowance is floored at the shipped over-estimate.
    func testTheAllowanceIsNeverSmallerThanTheValidatedBase() {
        let small = padding(vertical: 120, availableHeight: Self.measuredSlot,
                            allowance: Inset.baseContentAllowance * 0.7)
        let base = padding(vertical: 120, availableHeight: Self.measuredSlot,
                           allowance: Inset.baseContentAllowance)
        XCTAssertEqual(small, base, "a shrunken allowance must not buy the padding more room")
    }

    // MARK: - Degrading, not clipping

    /// A page too short for the text itself keeps a minimum of breathing room and is
    /// allowed to overflow again. The placeholders live in a scrollable container so
    /// that degrades to a scroll, and a page that short has no composer clearance
    /// left to protect anyway.
    func testAPageShorterThanTheTextKeepsMinimumBreathingRoom() {
        XCTAssertEqual(padding(vertical: 120, availableHeight: 40), Inset.minimumVertical)
        XCTAssertEqual(padding(vertical: 120, availableHeight: 0), Inset.minimumVertical)
    }

    /// Monotonic in the page height: a taller page never gets LESS breathing room.
    /// A non-monotonic rule would make the empty state jitter as the keyboard
    /// animates, which is the sort of churn this app bounds elsewhere.
    func testPaddingNeverShrinksAsThePageGrows() {
        for scale in Self.typeScales {
            let allowance = Inset.baseContentAllowance * scale
            var previous = padding(vertical: 120, availableHeight: 0, allowance: allowance)
            for available in stride(from: CGFloat(0), through: 900, by: 5) {
                let pad = padding(vertical: 120, availableHeight: available, allowance: allowance)
                XCTAssertGreaterThanOrEqual(pad, previous,
                    "padding fell as the page grew, at \(available)pt and \(scale)x")
                previous = pad
            }
        }
    }

    /// Padding is never negative and never exceeds what was asked for: the rule is a
    /// cap on a preference, not a second layout system.
    func testPaddingStaysWithinItsBounds() {
        for available in stride(from: CGFloat(0), through: 1200, by: 7) {
            for scale in Self.typeScales {
                let pad = padding(vertical: 120, availableHeight: available,
                                  allowance: Inset.baseContentAllowance * scale)
                XCTAssertGreaterThanOrEqual(pad, 0)
                XCTAssertLessThanOrEqual(pad, 120, "the cap must never inflate the request")
            }
        }
    }

    // MARK: - The visible slot (round 3: the composer floats over the transcript)

    /// Keyboard down is the path that was already correct, so it must stay a no-op: the
    /// composer is a `safeAreaInset` there and the proposal already stops above it.
    func testKeyboardDownLeavesTheWholeProposalToThePlaceholder() {
        XCTAssertEqual(Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: nil, composerHeight: 0), 674)
        XCTAssertEqual(Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: nil, composerHeight: 180), 674)
    }

    /// The measured AX5 geometry from the DOCK-c refutation: page 116-790 with the
    /// keyboard at 500 and a 150pt composer riding on it. The copy needed 368pt and the
    /// slot above the composer is 234pt, so the placeholder must be told 234 (which is
    /// what makes `ViewThatFits` degrade to the reachable, scrollable candidate) rather
    /// than 674 (which is what let it pick the candidate whose bottom third was under
    /// the composer).
    func testKeyboardUpSubtractsTheKeyboardAndTheFloatingComposer() {
        let slot = Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                       keyboardTop: 500, composerHeight: 150)
        XCTAssertEqual(slot, 234)
        XCTAssertLessThan(slot, 368, "the copy must not be told it fits when it does not")
    }

    /// An unmeasured composer still shrinks the slot by the keyboard, and a dock that is
    /// absent entirely (previews, the test harness) behaves exactly like keyboard-down.
    /// Every unknown fails OPEN to the old behaviour instead of guessing a constant.
    func testUnknownComposerHeightStillExcludesTheKeyboard() {
        XCTAssertEqual(Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: 500, composerHeight: 0), 384)
        XCTAssertEqual(Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: 500, composerHeight: -40), 384,
                       "a nonsense height must not ADD room")
    }

    /// A keyboard reported below the page (the dock's own screen-vs-page mismatch case,
    /// and the split-view/floating-keyboard case) must not shrink anything, and no input
    /// may ever produce a negative slot or one larger than the proposal. Those two are
    /// the invariants that keep this from becoming a second layout system.
    func testTheSlotStaysWithinTheProposalForEveryInput() {
        XCTAssertEqual(Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: 900, composerHeight: 150), 674)
        for keyboardTop in stride(from: CGFloat(0), through: 1000, by: 13) {
            for composer in [CGFloat(0), 60, 150, 400, 2000] {
                let slot = Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                               keyboardTop: keyboardTop, composerHeight: composer)
                XCTAssertGreaterThanOrEqual(slot, 0, "negative slot at \(keyboardTop)/\(composer)")
                XCTAssertLessThanOrEqual(slot, 674, "slot exceeded the proposal at \(keyboardTop)")
            }
        }
    }

    /// Monotonic in the keyboard's position for the same reason the padding rule is
    /// monotonic in the page height: a slot that grew as the keyboard rose would make the
    /// empty state jitter through the keyboard animation.
    func testTheSlotNeverGrowsAsTheKeyboardRises() {
        var previous = Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: 790, composerHeight: 150)
        // Stops at 1: a keyboard top of 0 is "no keyboard geometry", not a keyboard that
        // covers the screen, and it fails open to the proposal by design.
        for keyboardTop in stride(from: CGFloat(789), through: 1, by: -3) {
            let slot = Inset.visibleHeight(pageHeight: 674, pageBottom: 790,
                                           keyboardTop: keyboardTop, composerHeight: 150)
            XCTAssertLessThanOrEqual(slot, previous, "slot grew as the keyboard rose to \(keyboardTop)")
            previous = slot
        }
    }
}
