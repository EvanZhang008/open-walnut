import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// THE DRAWER COUNTS IN THE SERVER'S UNITS.
///
/// `*Chars`, `offset` and `nextOffset` are UTF-16 code units: the server measures with
/// JavaScript's `string.length`. Swift's `String.count` counts Characters, and the two
/// disagree on anything but plain ASCII — an emoji is 2 units and 1 Character, and
/// `\r\n` is 2 units and, in Swift, also 1 Character.
///
/// Comparing the server's number against a grapheme count therefore made a COMPLETE
/// section look clipped: the 2026-09-12 gate opened a drawer on 40 emoji, the server
/// said 2,717, Swift counted 2,605, and the footer announced "Showing the first 2,605
/// of 2,717 characters." with no Show more to press — 112 characters that did not
/// exist, and no way to ask for them. 120 CRLF line endings did the same.
///
/// Every fixture here writes its non-ASCII as an explicit `\u{…}` escape, so the bytes
/// under test are visible in the source rather than depending on how an editor saved
/// the file.
final class ActivityDrawerUTF16CountTests: XCTestCase {

    /// U+1F600 GRINNING FACE — one Character, one scalar, TWO UTF-16 code units.
    private static let emoji = "\u{1F600}"

    /// A whole section carrying 40 emoji says NOTHING: no cut, no footer, no numbers.
    ///
    /// RED PROOF (`chars = text.count`, `holdsLess` on `s.text.count`):
    ///   XCTAssertFalse failed - a complete section claimed 45 of 85 code units
    func testFortyEmojiInAWholeSectionIsNotReportedAsClipped() {
        let text = String(repeating: Self.emoji, count: 40) + " done"
        // The fixture only proves anything while the two counts DISAGREE.
        XCTAssertLessThan(text.count, text.utf16.count,
                          "the fixture has to be a string the two units count differently")

        let section = TimelineActivitySheet.drawerSection(
            .init(text: text, totalChars: text.utf16.count, nextOffset: nil, truncated: false))

        XCTAssertFalse(section.cut,
                       "a complete section claimed \(section.chars) of \(section.total) code units")
        XCTAssertFalse(section.withholding, "…so the drawer must show no footer at all")
        XCTAssertEqual(section.chars, text.utf16.count, "the text is measured in the server's units")
        XCTAssertEqual(section.total, text.utf16.count, "and so is the total")
    }

    /// The same, for the OTHER pair Swift counts differently: `\r\n` is two code units
    /// and one Character, so a 120-line CRLF result reported 120 missing characters.
    ///
    /// RED PROOF (`chars = text.count`, `holdsLess` on `s.text.count`):
    ///   XCTAssertFalse failed - a complete section claimed 600 of 720 code units
    func testCRLFLineEndingsInAWholeSectionAreNotReportedAsClipped() {
        let text = String(repeating: "line\r\n", count: 120)
        XCTAssertEqual(text.count, 600, "Swift counts CRLF as ONE Character")
        XCTAssertEqual(text.utf16.count, 720, "…the server counts it as two code units")

        let section = TimelineActivitySheet.drawerSection(
            .init(text: text, totalChars: text.utf16.count, nextOffset: nil, truncated: false))

        XCTAssertFalse(section.cut,
                       "a complete section claimed \(section.chars) of \(section.total) code units")
        XCTAssertFalse(section.withholding, "…so the drawer must show no footer at all")
        XCTAssertFalse(TimelineActivitySheet.offersShowMore(section),
                       "…and offer nothing to press")
    }

    /// A section that IS clipped still reports itself clipped, in the same units. The
    /// fix must not buy silence by never saying anything.
    func testAnEmojiSectionThatIsGenuinelyShortIsStillStated() {
        let text = String(repeating: Self.emoji, count: 40)
        let section = TimelineActivitySheet.drawerSection(
            .init(text: text, totalChars: 2_717, nextOffset: nil, truncated: true))
        XCTAssertTrue(section.withholding)
        XCTAssertEqual(section.total, 2_717)
        XCTAssertEqual(TimelineActivitySheet.withheldText(shown: section.shownChars,
                                                         total: section.total),
                       "Showing the first 80 of 2,717 characters.")
    }

    /// THE FOOTER'S TWO NUMBERS DESCRIBE THE SAME TEXT, and the render window cuts on
    /// a Character boundary — never through a surrogate pair, which would put a
    /// half-encoded scalar into a `Text`.
    ///
    /// RED PROOF (`visible = String(text.prefix(window))`):
    ///   XCTAssertEqual failed: ("20") is not equal to ("10") - the window handed 20
    ///   code units to a footer claiming 10
    func testTheRenderWindowCutsInCodeUnitsAndLandsOnACharacterBoundary() {
        var section = TimelineDrawerSection(String(repeating: Self.emoji, count: 40))
        section.window = 10

        XCTAssertEqual(section.visible.utf16.count, 10,
                       "the window handed \(section.visible.utf16.count) code units to a "
                           + "footer claiming \(section.shownChars)")
        XCTAssertEqual(section.visible, String(repeating: Self.emoji, count: 5),
                       "5 whole emoji, not 10 of them and not half of one")
        XCTAssertEqual(section.shownChars, 10)
        XCTAssertEqual(TimelineActivitySheet.withheldText(shown: section.shownChars,
                                                         total: section.total),
                       "Showing the first 10 of 80 characters.")
        XCTAssertTrue(TimelineActivitySheet.offersShowMore(section),
                      "the rest is right here — one press covers it")
    }

    /// An odd window cannot split a pair: it cuts back to the boundary below and the
    /// footer says the number it actually drew.
    func testAnOddWindowFallsBackToTheBoundaryBelowRatherThanSplittingAPair() {
        var section = TimelineDrawerSection(String(repeating: Self.emoji, count: 10))
        section.window = 7

        XCTAssertEqual(section.visible.utf16.count, 6, "three whole emoji, not three and a half")
        XCTAssertEqual(section.shownChars, 6, "and the footer prints what was drawn")
        XCTAssertEqual(section.visible.unicodeScalars.count, 3,
                       "no lone surrogate reached the string")
    }

    /// A CRLF window lands between lines rather than between `\r` and `\n`: Swift has
    /// no index there, so a naive UTF-16 cut would have to invent one.
    func testAWindowInsideACRLFPairCutsBeforeIt() {
        var section = TimelineDrawerSection("a\r\nb\r\n")
        XCTAssertEqual(section.chars, 6)
        section.window = 2   // between the \r and the \n
        XCTAssertEqual(section.visible, "a", "the cut backs off the pair instead of halving it")
        XCTAssertEqual(section.shownChars, 1)
    }

    /// The drawer's whole-section path, end to end from RESPONSE BYTES: the same emoji
    /// text decoded from the route's JSON has to reach the same verdict. A count fixed
    /// only in the Swift-built path would still be wrong on the wire, where the
    /// server's `textChars` is the number that arrives.
    func testAWholeEmojiSectionDecodedFromTheWireAlsoSaysNothing() throws {
        let text = String(repeating: Self.emoji, count: 40)
        // Written as JSON escapes, i.e. exactly the surrogate pairs the server emits.
        let escaped = String(repeating: "\\ud83d\\ude00", count: 40)
        let json = """
        {"version":1,"kind":"thinking","offset":0,
         "text":"\(escaped)","textChars":80}
        """
        let payload = try JSONDecoder().decode(TimelineActivityFullText.Payload.self,
                                               from: Data(json.utf8))
        let wire = try XCTUnwrap(payload.detail.reasoning)
        XCTAssertEqual(wire.text, text, "the pairs decoded to the emoji they encode")
        XCTAssertEqual(wire.totalChars, 80, "the server counted 2 units per emoji")

        let section = TimelineActivitySheet.drawerSection(wire)
        XCTAssertFalse(section.withholding, "a complete section, from the wire, says nothing")
    }

    /// …and the ROW renders no control for it. The footer row is what the reader sees,
    /// so the claim is measured on a laid-out height the way `ActivityDrawerPolishTests`
    /// does it: a row carrying the button cannot be shorter than the 44pt tap target.
    @MainActor
    func testAWholeEmojiSectionRendersNoWithheldRowControl() {
        let text = String(repeating: Self.emoji, count: 40)
        let section = TimelineActivitySheet.drawerSection(
            .init(text: text, totalChars: text.utf16.count, nextOffset: nil, truncated: false))
        XCTAssertFalse(section.withholding,
                       "the status bar is absent entirely, so nothing renders this row")

        // Guard the OTHER direction with the same instrument: a clipped one does.
        let clipped = TimelineActivitySheet.drawerSection(
            .init(text: String(repeating: Self.emoji, count: 20_000), totalChars: 40_000,
                  nextOffset: nil, truncated: true))
        let host = UIHostingController(rootView: TimelineActivityWithheldRow(
            label: nil, section: clipped, widen: {}))
        let height = host.sizeThatFits(
            in: CGSize(width: CGFloat(370), height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(height, TimelineHostedCell.minimumTapHeight,
                                    "a clipped emoji section still offers Show more; got \(height)pt")
    }
}
