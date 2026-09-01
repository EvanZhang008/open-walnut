import XCTest
import SwiftUI
@testable import Walnut

/// R30's four fixes, as the assertions that would have caught them.
///
/// Each one pins a rule that a screenshot found and a unit test could not, so the shape of
/// the test is chosen per defect rather than per convention:
///
///  - THE INVISIBLE TITLE was a modifier ARRANGEMENT (`toolbarBackground` with a `Color`),
///    which no value in the app can express — so it is pinned by reading the source. That is
///    unusual and deliberate: the alternative is a screenshot diff of a navigation bar, and
///    the thing that must never come back is one line of code.
///  - THE CHIP CAPSULE was a MATERIAL, which resolves against its backdrop, so the two copies
///    of the bar drew different pixels. An opaque colour is a value a test can resolve.
///  - THE HEADING'S TYPE was fixed point sizes, so it ignored Dynamic Type. Text STYLES are
///    what the OS scales, and `UIFontMetrics` can prove that they do.
///  - THE DEGRADATION LADDERS (the row's second line, the heading's control and count) are
///    pure functions precisely so the rule is testable without a screen.
final class BoardChromeR30Tests: XCTestCase {

    // MARK: - P1: the large title renders

    /// `.toolbarBackground(BoardBandCard.page, for: .navigationBar)` cost the Tasks screen
    /// its large title ENTIRELY: measured on the pinned simulator, the title's own
    /// accessibility rect came back a flat 243-246 luminance in light and dark, at default
    /// and at accessibility-XXXL, on cold launch. `InboxView` — same OS, same List, one
    /// `.visible` and no colour — drew its title fine, which is what identified the
    /// `ShapeStyle` overload rather than the opacity as the cause.
    ///
    /// So the rule is: this screen may ask for a VISIBLE bar background, and may not name the
    /// colour. Reading the source is the only way to assert an arrangement; the value it
    /// would otherwise assert (the page colour) is still right and still used by the List.
    func testTheTasksToolbarAsksForVisibilityAndNeverForAColour() throws {
        let source = code(in: try source("Walnut/Views/Tasks/TasksView.swift"))
        XCTAssertTrue(
            source.contains(".toolbarBackground(.visible, for: .navigationBar)"),
            "the bar needs a visible background or board rows ghost up into the status bar"
        )
        for argument in toolbarBackgroundArguments(in: source) {
            XCTAssertTrue(
                ["visible", "hidden", "automatic"].contains(argument),
                """
                `.toolbarBackground(\(argument), …)` is a ShapeStyle overload, and that is \
                what made the large "Tasks" title render zero pixels
                """
            )
        }
    }

    /// The same rule on the screen that never had the defect, as the control case: if
    /// `InboxView` ever grows a colour overload, the comparison that identified the cause is
    /// gone and this class is asserting a coincidence.
    func testTheInboxToolbarStaysTheControlCase() throws {
        let source = try source("Walnut/Views/Inbox/InboxView.swift")
        for argument in toolbarBackgroundArguments(in: source) {
            XCTAssertTrue(
                ["visible", "hidden", "automatic"].contains(argument),
                "InboxView is the screen whose title proves the overload is the cause"
            )
        }
    }

    // MARK: - Z8: the bar's corner can actually be drawn

    /// A rounded rectangle cannot round deeper than half its height, and that is why the
    /// chips bar's corner was wrong even after the radius was right.
    ///
    /// R29 set 20 against OS cards measuring ~26. R30 set 26 — and at the bar's old 44pt
    /// height the platform silently clamped it to 22, which measured a 12.54pt inset 2pt
    /// below the card's top edge where the OS cards measured 15.87-15.90. The height went to
    /// 52 and the profiles agreed to 0.25pt. This is the invariant behind that: the bar must
    /// be tall enough to DRAW the radius it shares with the cards around it.
    func testTheBarIsTallEnoughToDrawTheSharedCornerRadius() {
        XCTAssertGreaterThanOrEqual(
            TasksChromeMetrics.bandBar, 2 * BoardBandCard.cornerRadius,
            """
            a \(TasksChromeMetrics.bandBar)pt bar clamps a \(BoardBandCard.cornerRadius)pt \
            radius to \(TasksChromeMetrics.bandBar / 2) — the corner the user sees is not \
            the corner this constant claims
            """
        )
    }

    // MARK: - P2: the chip capsule is one colour in both copies

    /// The pinned copy and the inline copy drew the SAME chips with different pixels:
    /// (209,209,209) inline against (222,…) pinned, because `.quaternary` is a material and
    /// a material is a function of whatever is behind it. Third time on this bar (the card's
    /// `.bar` material, R27; the row tint inside a card, R29), hence a concrete colour.
    func testTheUnselectedChipCapsuleIsOneOpaqueColour() {
        for dark in [false, true] {
            let resolved = BoardBandBar.unselectedChipFillColor.resolvedColor(
                with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            XCTAssertTrue(resolved.getRed(&r, green: &g, blue: &b, alpha: &a),
                "dark=\(dark): the capsule must be a plain RGB colour, not a pattern or a material")
            XCTAssertEqual(Double(a), 1, accuracy: 0.001,
                "dark=\(dark): a translucent fill is a fill that depends on its backdrop")
        }
    }

    /// And it reads as a capsule ON the card in both schemes — the other half of the same
    /// defect, since an opaque colour that matches the card is a chip nobody can see.
    ///
    /// Measured on the simulator with these constants: 209 on a 255 card in light, 60 on a 28
    /// card in dark. The floor is well under both so the test fails on a real regression
    /// rather than on a taste change.
    func testTheChipCapsuleStepsAwayFromTheCardInBothSchemes() {
        for dark in [false, true] {
            let capsule = grey(BoardBandBar.unselectedChipFillColor, dark: dark)
            let card = grey(BoardBandBar.cardBaseColor, dark: dark)
            XCTAssertGreaterThan(
                abs(capsule - card), 20,
                "dark=\(dark): capsule \(capsule) against card \(card) — the chips dissolve into the card"
            )
        }
    }

    /// Both copies read the SAME symbol, which is what makes "same pixels at the flip" a
    /// property of the code. The bar has exactly one chip background expression and it names
    /// this colour; a material there is the regression.
    func testTheChipBackgroundNamesTheColourAndNotAMaterial() throws {
        let source = code(in: try source("Walnut/Views/Tasks/BoardBandBar.swift"))
        XCTAssertTrue(
            source.contains("AnyShapeStyle(Self.unselectedChipFill)"),
            "the chip capsule stopped filling with the explicit colour"
        )
        XCTAssertFalse(
            source.contains("AnyShapeStyle(.quaternary)"),
            "`.quaternary` is back on this bar — it resolves against the backdrop, so the two copies differ"
        )
    }

    // MARK: - Dynamic Type: the heading scales

    /// Every size in the band heading used to be a `Font.system(size:)` literal (11 bold, 11.5,
    /// 11, 10.5, 9.5), so at accessibility-XXXL the rows grew to ~40pt text and the headings
    /// labelling them stayed at 11. Text STYLES scale because the OS scales them, and this is
    /// that claim measured through `UIFontMetrics` rather than asserted in a comment.
    func testEveryHeadingTypeStyleGrowsWithDynamicType() {
        let styles: [(name: String, style: Font.TextStyle)] = [
            ("label", BoardHeadingType.label),
            ("folderLabel", BoardHeadingType.folderLabel),
            ("count", BoardHeadingType.count),
            ("control", BoardHeadingType.control),
            ("folderGlyph", BoardHeadingType.folderGlyph),
        ]
        for entry in styles {
            let ui = uiStyle(entry.style)
            let base = UIFont.preferredFont(
                forTextStyle: ui,
                compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
            ).pointSize
            let accessible = UIFont.preferredFont(
                forTextStyle: ui,
                compatibleWith: UITraitCollection(
                    preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
            ).pointSize
            XCTAssertGreaterThan(
                accessible, base * 1.5,
                "\(entry.name) went from \(base)pt to \(accessible)pt — a heading that ignores the setting"
            )
        }
    }

    /// The band's own name is the LARGEST thing in the heading and it is at least as big as
    /// the 11pt it replaced. Both halves matter: the label used to be the smallest text on a
    /// screen full of body-size rows, and a folder label has to stay a step below a project
    /// label or the two levels read as siblings.
    func testTheHeadingLabelIsTheTopOfItsOwnScale() {
        let label = pointSize(BoardHeadingType.label)
        XCTAssertGreaterThanOrEqual(label, 11,
            "the label is smaller than the 11pt literal it replaced")
        for smaller in [BoardHeadingType.folderLabel, BoardHeadingType.count, BoardHeadingType.control] {
            XCTAssertLessThan(pointSize(smaller), label,
                "a heading satellite is not allowed to be as loud as the band's name")
        }
        XCTAssertLessThanOrEqual(
            pointSize(BoardHeadingType.folderGlyph), pointSize(BoardHeadingType.folderLabel),
            "the folder glyph is an icon beside a word, so it never outsizes the word")
    }

    /// The heading's own ladder: at accessibility sizes the control becomes a glyph and the
    /// count goes, because the four things on that line want 330.5pt of a 330pt row and the
    /// only one that cannot be sacrificed is the band's NAME (it hyphenated into "Fo-cus"
    /// while the control truncated to "hid…" — every element lost).
    func testTheHeadingSpendsItsControlLabelAndCountAtAccessibilitySizes() {
        for size in [DynamicTypeSize.small, .large, .xxLarge, .xxxLarge] {
            XCTAssertTrue(BoardHeadingType.showsControlLabel(size), "\(size)")
            XCTAssertTrue(BoardHeadingType.showsCount(size), "\(size)")
        }
        for size in [DynamicTypeSize.accessibility1, .accessibility3, .accessibility5] {
            XCTAssertFalse(BoardHeadingType.showsControlLabel(size),
                "\(size): a spelled-out control eats the band label's room")
            XCTAssertFalse(BoardHeadingType.showsCount(size),
                "\(size): the count is the cheapest token on the line and the chip above says it too")
        }
    }

    // MARK: - R28c P1: the heading is legible on its own page

    /// The band heading rendered at 1.71:1 (label) and 1.37:1 (count) on the FIRST screen of
    /// the app, and neither number is in the code: `.foregroundStyle(.secondary)` resolves
    /// RELATIVE to the level its context sits at, and a List section header already starts one
    /// level down, so `.secondary` drew `tertiaryLabel` and `.tertiary` drew quaternary.
    ///
    /// The measurement that identified it: the label's ink came back 187.4 luminance on the
    /// 242 page, which is exactly `tertiaryLabel` composited over that page (0.3·60 + 0.7·242
    /// = 187.4), and the count 215 ≈ quaternary (0.18·60 + 0.82·242 = 209).
    ///
    /// So the assertion is the measurement, done on the app's own constants: resolve the ink
    /// for the scheme, composite it over `BoardBandCard.pageColor` (label colours carry alpha
    /// — that is half of why the numbers were so low), and require the WCAG contrast a
    /// non-decorative label owes a reader. 3:1 and not 4.5:1 because these are the platform's
    /// own header greys at semibold, which is the "large text" bar.
    func testTheHeadingInkIsLegibleOnTheBoardsPageInBothSchemes() {
        let inks: [(name: String, color: UIColor)] = [
            ("label", BoardHeadingType.inkColor),
            ("count", BoardHeadingType.countInkColor),
        ]
        for ink in inks {
            for dark in [false, true] {
                let ratio = contrast(ink.color, over: BoardBandCard.pageColor, dark: dark)
                XCTAssertGreaterThanOrEqual(
                    ratio, 3.0,
                    """
                    \(ink.name) ink is \(String(format: "%.2f", ratio)):1 over the page in \
                    \(dark ? "dark" : "light") — R28c shipped 1.71:1 and 1.37:1 and the user \
                    could not read the band names
                    """
                )
            }
        }
    }

    /// And the ink is NAMED, which is the only way the number above stays true.
    ///
    /// A hierarchical style is not a colour, it is a request to whatever context resolves it —
    /// so a test on values cannot see it and the header is free to re-level it. This scans the
    /// board list for the two styles that caused the defect. It covers the whole file rather
    /// than the heading alone on purpose: every ink in it is a named colour now, so the rule is
    /// checkable without a fragile idea of where the heading's source begins and ends.
    ///
    /// `.fill(.quaternary)` on the folder rail is deliberately NOT covered: a 1pt hairline is a
    /// separator, and separators legitimately sit under 3:1.
    func testTheBoardListNamesItsInkAndNeverAHierarchyLevel() throws {
        let source = code(in: try source("Walnut/Views/Tasks/TaskBoardList.swift"))
        for level in ["secondary", "tertiary", "quaternary"] {
            XCTAssertFalse(
                source.contains("foregroundStyle(.\(level))"),
                """
                `.foregroundStyle(.\(level))` is back — inside a List section header it \
                resolves one level LOWER than it reads, which is the 1.71:1 defect
                """
            )
        }
        XCTAssertTrue(
            source.contains("foregroundStyle(BoardHeadingType.ink)"),
            "the heading stopped naming its own ink constant"
        )
        XCTAssertTrue(
            source.contains("foregroundStyle(BoardHeadingType.countInk)"),
            "the count stopped naming its own ink constant"
        )
    }

    /// The heading's ink must also step away from the page as a plain grey, in both schemes.
    ///
    /// This is the cheap sanity net beside the WCAG number: a future "quieter heading" edit
    /// that lands on a colour close to the page fails here even if someone has loosened the
    /// ratio, and it is the same shape as the chip-capsule check above (measured greys, one
    /// floor, both schemes).
    func testTheHeadingInkStepsAwayFromThePageInBothSchemes() {
        for dark in [false, true] {
            let page = grey(BoardBandCard.pageColor, dark: dark)
            let ink = grey(flatten(BoardHeadingType.inkColor, over: BoardBandCard.pageColor, dark: dark),
                           dark: dark)
            XCTAssertGreaterThan(
                abs(ink - page), 60,
                "dark=\(dark): heading ink \(ink) against page \(page) — the name dissolves into the page"
            )
        }
    }

    // MARK: - R28c P2: both voices read ONE rule

    /// The label and the VoiceOver hint are two SITES, and the defect was that each held its
    /// own ternary over a Bool (`row.hasKnownSession ? … : "Start Session"`), which cannot
    /// express the ledger's third value. `BoardModel.affordance` is that rule as a value, and
    /// the assertion here is the ARRANGEMENT: neither site may branch on the Bool again.
    ///
    /// Source-scanned for the same reason the toolbar test above is: what must not come back is
    /// a line of code, and a value test cannot see which expression a view chose.
    func testTheMenuAndTheHintBothReadTheAffordanceAndNotTheBool() throws {
        let sites = [
            "Walnut/Views/Tasks/TaskBoardList.swift",
            "Walnut/Views/Tasks/TaskBoardRow.swift",
        ]
        for site in sites {
            let source = code(in: try source(site))
            XCTAssertFalse(
                source.contains("row.hasKnownSession ?"),
                """
                \(site) phrases an affordance from a Bool again — that reads the ledger's \
                "nobody asked" as "no session" and offers to START one on a task that has some
                """
            )
            XCTAssertTrue(
                source.contains("BoardModel.affordance(row)"),
                "\(site) stopped reading the one rule that knows about the unknown state"
            )
        }
    }

    // MARK: - The row's second line

    /// At accessibility-XXXL the line used to squeeze every token equally, so the row read
    /// "hand… · Immi…" — the STATE WORD, the one thing that says what is being asked of the
    /// reader, destroyed to keep two other tokens that were also destroyed.
    func testTheStateWordSurvivesEveryTypeSize() {
        for size in DynamicTypeSize.allCases {
            let meta = TaskBoardRow.meta(
                word: "handed back", age: "2h", project: "Immigration", typeSize: size)
            XCTAssertEqual(meta.state, "handed back", "\(size): the state word was dropped or shortened")
            XCTAssertEqual(meta.tokens.first, "handed back", "\(size): the state word must lead the line")
        }
    }

    /// The ladder, in order: at ordinary sizes all three tokens; at accessibility sizes the
    /// age goes first and then the project, because one word fills the column.
    func testTheLadderDropsTheCheapestTokenFirst() {
        let ordinary = TaskBoardRow.meta(
            word: "running", age: "5m", project: "Marina", typeSize: .large)
        XCTAssertEqual(ordinary.tokens, ["running", "5m", "Marina"])

        let accessible = TaskBoardRow.meta(
            word: "running", age: "5m", project: "Marina", typeSize: .accessibility3)
        XCTAssertEqual(accessible.tokens, ["running"],
            "at an accessibility size the line says the one thing that matters")
        XCTAssertNil(accessible.age)
        XCTAssertNil(accessible.project)
    }

    /// A row with no session state keeps its project at every size: then the project IS the
    /// line, and dropping it would leave the row's second line empty.
    func testARowWithNoStateKeepsItsProject() {
        let accessible = TaskBoardRow.meta(
            word: nil, age: nil, project: "Marina", typeSize: .accessibility5)
        XCTAssertEqual(accessible.tokens, ["Marina"])

        let inbox = TaskBoardRow.meta(word: nil, age: nil, project: "", typeSize: .large)
        XCTAssertEqual(inbox.tokens, ["Inbox"],
            "the empty project is the Inbox, which is a place with a name")
    }

    /// The age is only ever dropped BY THE TYPE SIZE — a row that has no session has no age
    /// to begin with, and the two nils must not be confused (the first is a degradation, the
    /// second is the truth).
    func testAnAbsentAgeIsNotADegradation() {
        let meta = TaskBoardRow.meta(word: "ended", age: nil, project: "Marina", typeSize: .large)
        XCTAssertEqual(meta.tokens, ["ended", "Marina"])
    }

    // MARK: - The heading's done toggle (done folds by default)

    /// The toggle is phrased from the BAND, and the band is the only thing that knows how
    /// many rows it is suppressing. Folded with rows to show is the DEFAULT state now, so
    /// this is the label a cold board draws on every band that has finished work.
    func testTheDoneToggleOffersToShowExactlyWhatTheBandIsHoldingBack() {
        let toggle = BoardModel.doneToggle(band("focus", hiddenDone: 59))
        XCTAssertEqual(toggle.word, "show done (59)")
        XCTAssertTrue(toggle.folding)
        XCTAssertEqual(toggle.glyph, "eye", "a closed eye is what you tap to open")
    }

    /// Expanded, it offers the way back. No count in the word: the rows are on screen, so
    /// the number is the heading's job and repeating it here would be two answers to one
    /// question.
    func testTheDoneToggleOffersToFoldAgainOnceTheBandIsExpanded() {
        let toggle = BoardModel.doneToggle(band("focus", hiddenDone: 0))
        XCTAssertEqual(toggle.word, "hide done")
        XCTAssertFalse(toggle.folding)
        XCTAssertEqual(toggle.glyph, "eye.slash")
    }

    /// THE case the flip creates, and the reason the label reads the band instead of the
    /// view's expanded set: a band with nothing done is folded like every other band, and
    /// it must not offer to `show done` rows that do not exist. Phrased from the set it
    /// would have, because "not expanded" says nothing about whether there is anything to
    /// expand.
    func testABandWithNothingDoneNeverOffersToShowDoneRows() {
        let toggle = BoardModel.doneToggle(band("wait", hiddenDone: 0))
        XCTAssertEqual(toggle.word, "hide done",
            "a folded band with no completions must not promise rows it does not have")
        XCTAssertFalse(toggle.word.contains("show"))
    }

    /// The arrangement, source-scanned for the same reason `affordance` is above: what must
    /// not come back is a line of code. The heading may not re-derive the toggle from a set
    /// of expanded band ids, and the list may not take that set as a property again —
    /// either one lets the label and the rows disagree.
    func testTheHeadingReadsTheToggleOffTheBandAndNeverOffTheExpandedSet() throws {
        let source = code(in: try source("Walnut/Views/Tasks/TaskBoardList.swift"))
        XCTAssertTrue(
            source.contains("BoardModel.doneToggle(band)"),
            "the heading stopped reading the one rule that knows what the band is folding"
        )
        for phrase in ["hiddenDoneBands", "shownDoneBands"] {
            XCTAssertFalse(
                source.contains(phrase),
                "TaskBoardList reads `\(phrase)` again — the label is back to guessing"
            )
        }
    }

    // MARK: - The nav row's chips

    /// The fair share: two chips capped at half the row each fit BY ARITHMETIC, which is the
    /// only cap available without measuring text. It is the last of the row's three layouts,
    /// so it only bites when even the leanest full-label layout overflows — and there it
    /// truncates with an ellipsis inside an intact capsule, which is what the sliced capsule
    /// at x=370 was missing.
    func testTheNavChipsFairShareAlwaysFitsTheRow() throws {
        // The real row on this device: 402pt screen, 16pt List margins each side.
        let width = try XCTUnwrap(TasksNavRow.chipMaxWidth(
            container: 370, count: 2, spacing: TasksNavRow.chipSpacing))
        XCTAssertEqual(width, 181, accuracy: 0.01)
        // Two of them plus the gap is the row, never more than it.
        XCTAssertLessThanOrEqual(
            2 * width + TasksNavRow.chipSpacing, 370,
            "the cap does not actually guarantee a fit"
        )
    }

    /// No cap before the row has been measured, and none from a degenerate width: capping to
    /// a few points would draw two ellipses instead of two words.
    func testAnUnmeasuredRowDoesNotCapItsChips() {
        XCTAssertNil(TasksNavRow.chipMaxWidth(container: 0, count: 2, spacing: 8))
        XCTAssertNil(TasksNavRow.chipMaxWidth(container: 60, count: 2, spacing: 8))
        XCTAssertNil(TasksNavRow.chipMaxWidth(container: 370, count: 0, spacing: 8))
    }

    // MARK: - Helpers

    /// A band that is suppressing `hiddenDone` rows.
    ///
    /// No rows on purpose: `hiddenDone` is the ONLY field the heading's toggle is allowed
    /// to read (that is the rule these cases pin), so a fixture carrying visible rows
    /// would invite an assertion about a number the toggle must not consult.
    private func band(_ id: String, hiddenDone: Int) -> BoardBand {
        BoardBand(bandId: id, label: id, rows: [], hiddenDone: hiddenDone, createSeed: nil)
    }

    /// One dynamic colour resolved for a scheme, as a 0-255 grey. The bar's surfaces are all
    /// neutral, so the channel average is the whole story.
    private func grey(_ color: UIColor, dark: Bool) -> Double {
        let resolved = color.resolvedColor(
            with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
        return Double(r + g + b) / 3 * 255
    }

    /// A (possibly translucent) ink composited over an opaque backdrop, for one scheme.
    ///
    /// Compositing is not a detail here: every `*Label` colour is `#3C3C43` at an ALPHA (0.6 /
    /// 0.3 / 0.18 in light), so reading its components straight gives the same near-black for
    /// all three and hides the entire defect. What the eye sees is the blend, and that is what
    /// the QA sweep measured off the screen.
    private func flatten(_ ink: UIColor, over backdrop: UIColor, dark: Bool) -> UIColor {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        var ir: CGFloat = 0, ig: CGFloat = 0, ib: CGFloat = 0, ia: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        ink.resolvedColor(with: traits).getRed(&ir, green: &ig, blue: &ib, alpha: &ia)
        backdrop.resolvedColor(with: traits).getRed(&br, green: &bg, blue: &bb, alpha: &ba)
        return UIColor(
            red: ir * ia + br * (1 - ia),
            green: ig * ia + bg * (1 - ia),
            blue: ib * ia + bb * (1 - ia),
            alpha: 1
        )
    }

    /// WCAG 2.x relative luminance of an opaque colour resolved for a scheme.
    private func relativeLuminance(_ color: UIColor, dark: Bool) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: UITraitCollection(userInterfaceStyle: dark ? .dark : .light))
            .getRed(&r, green: &g, blue: &b, alpha: &a)
        func linear(_ channel: CGFloat) -> Double {
            let c = Double(channel)
            return c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    /// The WCAG contrast ratio of an ink over a backdrop, in one scheme.
    private func contrast(_ ink: UIColor, over backdrop: UIColor, dark: Bool) -> Double {
        let a = relativeLuminance(flatten(ink, over: backdrop, dark: dark), dark: dark)
        let b = relativeLuminance(backdrop, dark: dark)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private func pointSize(_ style: Font.TextStyle) -> CGFloat {
        UIFont.preferredFont(
            forTextStyle: uiStyle(style),
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        ).pointSize
    }

    /// SwiftUI's text style as UIKit's, so `UIFontMetrics` can measure the app's own
    /// constant. A switch and not a dictionary: a new case has to be handled here, which is
    /// the point.
    private func uiStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .largeTitle: return .largeTitle
        case .title: return .title1
        case .title2: return .title2
        case .title3: return .title3
        case .headline: return .headline
        case .subheadline: return .subheadline
        case .body: return .body
        case .callout: return .callout
        case .footnote: return .footnote
        case .caption: return .caption1
        case .caption2: return .caption2
        @unknown default: return .body
        }
    }

    /// Every `toolbarBackground(` argument in a source file, as the leading token.
    ///
    /// The distinction that matters is VISIBILITY (`.visible`) versus a `ShapeStyle` (a
    /// colour), so the token before the first comma is enough — and a leading dot is dropped
    /// so `.visible` and `visible` read the same.
    ///
    /// COMMENTS ARE EXCLUDED, and that is not a nicety: the first version of this test failed
    /// on `TasksView`'s own comment, which QUOTES the removed call to say why it is gone. A
    /// scanner that cannot tell code from prose forces the next reader to delete the
    /// explanation in order to get green, which is the opposite of what this file is for.
    private func toolbarBackgroundArguments(in source: String) -> [String] {
        var found: [String] = []
        var rest = Substring(code(in: source))
        while let call = rest.range(of: "toolbarBackground(") {
            let afterCall = rest[call.upperBound...]
            guard let comma = afterCall.firstIndex(of: ","),
                  let close = afterCall.firstIndex(of: ")") else {
                rest = afterCall
                continue
            }
            let end = min(comma, close)
            var argument = afterCall[..<end].trimmingCharacters(in: .whitespacesAndNewlines)
            if argument.hasPrefix(".") { argument.removeFirst() }
            found.append(argument)
            rest = afterCall
        }
        return found
    }

    /// A source file with its `//` comments removed, line by line.
    ///
    /// Deliberately not a Swift parser: a whole-line `//` is dropped and a trailing one is cut,
    /// which is every comment this codebase writes. The one input it would mis-handle is a
    /// `//` inside a string literal on the same line as a call this test cares about (a URL),
    /// and the failure mode there is a MISSED call rather than a phantom one, so it can only
    /// make this test quieter, never wrong about code that exists.
    private func code(in source: String) -> String {
        source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("//") { return "" }
            if let comment = line.range(of: "//") { return String(line[..<comment.lowerBound]) }
            return String(line)
        }.joined(separator: "\n")
    }

    /// A file from the app target, read as TEXT.
    ///
    /// Reading source in a unit test is unusual and it is the point: the defect this class
    /// leads with is not expressible as a value the app exposes — it is which OVERLOAD of a
    /// modifier is called. `#filePath` is resolved at compile time, so this finds the
    /// checkout the tests were built from.
    private func source(_ relative: String) throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
        let url = root.appendingPathComponent(relative)
        return try String(contentsOf: url, encoding: .utf8)
    }
}
