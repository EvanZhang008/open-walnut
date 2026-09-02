import XCTest
import SwiftUI
import UIKit
@testable import Walnut

/// `BoardViewBar` — the two inline toggle chips that replaced the band bar's filter menu as
/// the way grouping and dates are set.
///
/// A toggle chip can be wrong in ways a menu cannot, and these are the three:
///
///  - It can name the value a TAP WOULD BRING instead of the one in force (the classic
///    inverted toggle). The label has to be the ACTIVE value's own word.
///  - It can fail to reach a value that is stored, which would leave a board stuck in a
///    filter with no control that turns it off.
///  - It can spell a value differently from the menu that still writes it, which is two
///    names for one state on two surfaces one tap apart.
final class BoardViewBarTests: XCTestCase {

    // MARK: - The label names what is IN FORCE

    func testEachChipNamesTheValueInForceAndNotTheOneATapWouldBring() {
        for value in BoardGrouping.allCases {
            XCTAssertEqual(
                BoardViewBarModel.grouping(value).label, value.label,
                "the grouping chip must say what the board is doing, not what a tap will do"
            )
            XCTAssertNotEqual(
                BoardViewBarModel.grouping(value).label, value.nextChoice.label,
                "an inverted toggle: the chip is naming the other value"
            )
        }
        for value in BoardDateFilter.allCases {
            XCTAssertEqual(BoardViewBarModel.date(value).label, value.label)
            XCTAssertNotEqual(BoardViewBarModel.date(value).label, value.nextChoice.label)
        }
    }

    /// The two words the user named, verbatim, and they come from the ENUM rather than from
    /// a second copy inside the bar — which is what keeps the chip, the band bar's filter
    /// menu and VoiceOver saying one thing about one state.
    func testTheChipsReadTheDesktopsOwnWords() {
        XCTAssertEqual(BoardViewBarModel.grouping(.project).label, "By project")
        XCTAssertEqual(BoardViewBarModel.grouping(.tier).label, "Custom order")
        XCTAssertEqual(BoardViewBarModel.date(.now).label, "Now")
        XCTAssertEqual(BoardViewBarModel.date(.all).label, "All")
    }

    // MARK: - A tap CYCLES, and the cycle reaches every value

    func testATapCyclesTheGroupingBetweenTheTwoModes() {
        XCTAssertEqual(BoardGrouping.tier.nextChoice, .project)
        XCTAssertEqual(BoardGrouping.project.nextChoice, .tier)
    }

    func testATapCyclesTheDateFilterBetweenNowAndAll() {
        XCTAssertEqual(BoardDateFilter.all.nextChoice, .now)
        XCTAssertEqual(BoardDateFilter.now.nextChoice, .all)
    }

    /// Tapping enough times reaches EVERY value of either filter, so no stored value can
    /// become unreachable — the failure that would leave `Now` hiding rows with nothing on
    /// the bar able to turn it off.
    func testCyclingReachesEveryValueOfBothFilters() {
        assertCycleIsComplete(BoardGrouping.self)
        assertCycleIsComplete(BoardDateFilter.self)
    }

    private func assertCycleIsComplete<Option: BoardFilterChoice>(_ type: Option.Type) {
        let all = Array(Option.allCases)
        XCTAssertFalse(all.isEmpty)
        for start in all {
            var seen: Set<Option> = [start]
            var current = start
            for _ in 0..<all.count {
                current = current.nextChoice
                seen.insert(current)
            }
            XCTAssertEqual(
                seen.count, all.count,
                "\(type) starting at \(start.rawValue): cycling cannot reach every value"
            )
            XCTAssertEqual(
                current, start,
                "\(type): a full cycle has to come back to where it started"
            )
        }
    }

    // MARK: - The glyphs

    /// The glyph names the DIMENSION, so the chip does not change shape when it changes
    /// state: both date values carry the clock (the desktop's `◷` rides both of its
    /// labels), while the grouping's two modes are two different ideas and get two glyphs.
    func testTheDateChipKeepsOneGlyphAndTheGroupingChipDistinguishesItsModes() {
        XCTAssertEqual(
            BoardViewBarModel.date(.now).symbol, BoardViewBarModel.date(.all).symbol,
            "the date chip changes its word, not its glyph"
        )
        XCTAssertNotEqual(
            BoardViewBarModel.grouping(.project).symbol,
            BoardViewBarModel.grouping(.tier).symbol,
            "project clusters and a manual order are two different shapes"
        )
        for symbol in [
            BoardViewBarModel.grouping(.project).symbol,
            BoardViewBarModel.grouping(.tier).symbol,
            BoardViewBarModel.date(.now).symbol,
        ] {
            XCTAssertNotNil(
                UIImage(systemName: symbol),
                "\(symbol) is not a system symbol, so the chip would draw nothing"
            )
        }
    }

    /// Every chip says what a tap will do, and it says it as a HINT — a label would replace
    /// the visible word and a flow asserting "By project" would then find nothing.
    func testEveryChipCarriesAHintThatDescribesTheTap() {
        let specs = BoardGrouping.allCases.map(BoardViewBarModel.grouping)
            + BoardDateFilter.allCases.map(BoardViewBarModel.date)
        for spec in specs {
            XCTAssertFalse(spec.hint.isEmpty, "\(spec.label) has no hint")
            XCTAssertTrue(
                spec.hint.contains("Tap"),
                "\(spec.label): the hint has to say what a tap does — \"\(spec.hint)\""
            )
            XCTAssertFalse(
                spec.hint.contains("Click"),
                "\(spec.label): the desktop's verb leaked onto the phone"
            )
        }
    }

    // MARK: - The row's own geometry

    /// The bar is a row of its own precisely because it does NOT fit inside the band bar's
    /// card: the rail there is required to keep over 80% of the card
    /// (`TasksBoardChipRowTests.testTheRailKeepsMostOfTheCard`), and two chips of real
    /// words do not fit in what is left. Stated as arithmetic so a future "just put them in
    /// the bar" fails here with the reason.
    func testTwoWordChipsCouldNotFitInsideTheBandBarsCard() {
        let rail = BoardBandRailGeometry.standard
        let card: CGFloat = 370
        let spare = rail.railWidth(cardWidth: card) - 0.8 * card
        let twoChips = ["By project", "Now"].reduce(CGFloat(0)) { total, label in
            total + 2 * rail.chipPaddingH + CGFloat(label.count) * rail.chipLabelAdvance
        }
        XCTAssertGreaterThan(
            twoChips, spare,
            "if two toggle chips fit the band bar's card, they belong in it and not in a row"
        )
    }

    /// The row's height has to hold the capsule it draws at the widest type size the chips
    /// are allowed to grow to — a fixed-height row that clips its own control is the defect
    /// the `show done` button's `minHeight` exists to avoid.
    func testTheRowIsTallEnoughForItsCapsuleAtTheTypeCap() {
        let capsule = UIFont.preferredFont(
            forTextStyle: .footnote,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraLarge)
        )
        // The chips clamp at `BoardBandBar.chipTypeCap` (xxLarge), so that — and not the
        // accessibility ramp above it — is what the row has to hold.
        let capped = UIFont.preferredFont(
            forTextStyle: .footnote,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .extraExtraLarge)
        )
        XCTAssertLessThan(capped.lineHeight, capsule.lineHeight, "the cap has to actually cap")
        XCTAssertGreaterThanOrEqual(
            TasksChromeMetrics.viewBar, capped.lineHeight + 2 * 5,
            "the view bar clips its own chips at the type cap"
        )
    }

    /// The board never collapses its chrome, at ANY offset — which is why adding a row to it
    /// is a layout question and not a threshold question.
    ///
    /// This replaces an assertion that only restated `chromeHeight`'s own arithmetic (2026-09-02
    /// review: the board branch of that sum has no reader in the app, because `hasCompactBar`
    /// is false for the board, so a test agreeing with the sum proved nothing). The invariant
    /// worth pinning is the one the SCREEN has: one floating row on the board, and no
    /// whole-body publish on its scroll path for a bar that never draws. It fails the moment
    /// someone gives the board a compact bar or drops the guard in `isCollapsed`.
    func testTheBoardNeverCollapsesItsChromeAtAnyOffset() {
        XCTAssertFalse(
            TasksChromeMetrics.hasCompactBar(.sessions),
            "the board's floating row is its pinned chips — a compact bar would be a second one"
        )
        for offline in [false, true] {
            let past = Int(TasksChromeMetrics.chromeHeight(filter: .sessions, offline: offline)) + 400
            for scrolled in stride(from: -80, through: past, by: 7) {
                for wasCollapsed in [false, true] {
                    XCTAssertFalse(
                        TasksChromeMetrics.isCollapsed(
                            scrolled: CGFloat(scrolled), wasCollapsed: wasCollapsed,
                            filter: .sessions, offline: offline),
                        "the board collapsed at \(scrolled) (offline=\(offline))"
                    )
                    XCTAssertFalse(
                        TasksChromeMetrics.showsCompactBar(filter: .sessions, collapsed: wasCollapsed),
                        "the board drew a compact bar"
                    )
                }
            }
        }
    }

    /// And it does NOT move the pin: the band bar is row 2 and this rides below it, so the
    /// offset where the chips reach the top edge is untouched by its existence.
    func testTheViewBarDoesNotMoveThePinThreshold() {
        for offline in [false, true] {
            XCTAssertEqual(
                TasksChromeMetrics.chipsPinThreshold(offline: offline),
                TasksChromeMetrics.rowTwoContentTop(offline: offline)
                    - TasksChromeMetrics.pinnedChipsTopInset,
                accuracy: 0.01, "offline=\(offline)"
            )
            XCTAssertLessThan(
                TasksChromeMetrics.chipsPinThreshold(offline: offline),
                TasksChromeMetrics.chromeHeight(filter: .sessions, offline: offline)
            )
        }
    }

    // MARK: - ONE name per value, across every surface that presents it

    /// The rule: a value is spelled in exactly ONE place (`BoardGrouping.label` /
    /// `BoardDateFilter.label`), and the four surfaces that present it — the toggle chip, the
    /// band bar's filter MENU, its accessibility SHEET, and the control's VoiceOver value —
    /// all read that one spelling.
    ///
    /// Asserted by SCANNING THE APP TARGET's source, because that is the only form of this
    /// test that can fail for a real reason (2026-09-02 review). Comparing
    /// `BoardViewBarModel.grouping(v).label` to `v.label` was a tautology: the implementation
    /// passes exactly that value through, so the assertion restated the code and would keep
    /// passing while somebody typed "Custom" into a menu row two files away. What actually
    /// breaks the rule is a HARDCODED second spelling, so that is what this looks for.
    ///
    /// Scoped to the distinctive labels (two words) on purpose: "Now" and "All" are ordinary
    /// English that appears legitimately all over the target, so a scan for them would be
    /// noise. They are covered instead by `testTheChipsReadTheDesktopsOwnWords` (the exact
    /// strings) and by the hint rule below (which is where a second spelling of a date value
    /// would actually land).
    func testNoFileOutsideTheEnumSpellsAGroupingValueASecondTime() throws {
        let owner = "Walnut/Views/Tasks/TaskBoardModel.swift"
        let phrases = (BoardGrouping.allCases.map(\.label) + BoardDateFilter.allCases.map(\.label))
            .filter { $0.contains(" ") }
        XCTAssertEqual(
            Set(phrases), ["By project", "Custom order"],
            "a value's label changed shape — re-check what this scan is looking for"
        )

        let files = try appTargetSwiftFiles()
        XCTAssertGreaterThan(
            files.count, 50,
            "the scan found almost no source — it would pass without reading anything"
        )
        for phrase in phrases {
            let literal = "\"\(phrase)\""
            var owners: [String] = []
            for (relative, text) in files where code(in: text).contains(literal) {
                owners.append(relative)
            }
            XCTAssertEqual(
                owners, [owner],
                "\(literal) is spelled in \(owners) — one value, one spelling, and it lives in "
                    + "the enum's `label` so the chip, the menu, the sheet and VoiceOver cannot drift"
            )
        }
    }

    /// The hint's TAP SENTENCE names where the tap goes, in that value's own word — never the
    /// value you are already on.
    ///
    /// This is the inverted-toggle bug one level down: the label is easy to check by eye, the
    /// hint is not, and `value.label` in place of `value.nextChoice.label` reads perfectly
    /// while telling a VoiceOver user the tap does nothing. Splitting at "Tap" is what makes
    /// the check honest — the first half of a hint legitimately describes the CURRENT state
    /// ("Grouped by project, with folder headings").
    func testTheTapSentenceNamesTheDestinationAndNeverTheValueYouAreOn() {
        func check<Option: BoardFilterChoice>(_ value: Option, _ spec: BoardViewChipSpec) {
            guard let tap = spec.hint.range(of: "Tap") else {
                return XCTFail("\(spec.label): the hint never says what a tap does")
            }
            let sentence = String(spec.hint[tap.upperBound...])
            XCTAssertTrue(
                sentence.contains(value.nextChoice.label),
                "\(spec.label): the tap sentence \"\(sentence)\" does not name its destination "
                    + "(\(value.nextChoice.label))"
            )
            XCTAssertFalse(
                sentence.contains(value.label),
                "\(spec.label): the tap sentence offers the value already in force"
            )
        }
        for value in BoardGrouping.allCases { check(value, BoardViewBarModel.grouping(value)) }
        for value in BoardDateFilter.allCases { check(value, BoardViewBarModel.date(value)) }
    }

    // MARK: - Reading the app target as text

    /// Every Swift file in the app target, keyed by its repo-relative path.
    private func appTargetSwiftFiles() throws -> [(String, String)] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
        let target = root.appendingPathComponent("Walnut")
        var found: [(String, String)] = []
        let all = FileManager.default.enumerator(at: target, includingPropertiesForKeys: nil)
        while let url = all?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
            found.append((relative, try String(contentsOf: url, encoding: .utf8)))
        }
        return found
    }

    /// The file with its COMMENTS removed, so prose about a label (this file's own headers are
    /// full of it) is not mistaken for a second spelling in code. Deliberately crude: it
    /// cannot understand a `//` inside a string literal, and the failure mode of that is a
    /// line kept when it could have been dropped — quieter, never wrong about real code.
    private func code(in source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { return "" }
            return String(line)
        }.joined(separator: "\n")
    }

    /// The persistence keys and raw values are UNTOUCHED by the move, which is what makes a
    /// user's current setting survive the new bar instead of being silently reset.
    func testTheStoredKeysAndRawValuesSurviveTheMoveToChips() {
        XCTAssertEqual(BoardFilterPrefs.groupingKey, "tasks.board.grouping")
        XCTAssertEqual(BoardFilterPrefs.dateFilterKey, "tasks.board.dateFilter")
        XCTAssertEqual(BoardGrouping.allCases.map(\.rawValue), ["tier", "project"])
        XCTAssertEqual(BoardDateFilter.allCases.map(\.rawValue), ["all", "now"])
        for value in BoardGrouping.allCases {
            XCTAssertEqual(BoardFilterPrefs.grouping(value.rawValue), value)
        }
        for value in BoardDateFilter.allCases {
            XCTAssertEqual(BoardFilterPrefs.dateFilter(value.rawValue), value)
        }
    }
}
