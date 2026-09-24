import UIKit
import XCTest
@testable import Walnut

/// The UIKit button that owns a composer pill's menu.
///
/// Two promises: the menu opens ABOVE the pill (a second tap on the pill must
/// land outside the menu, gate r2 D1), and every open is followed by exactly one
/// close (a model left believing a menu is open holds every answer forever).
@MainActor
final class PillMenuButtonTests: XCTestCase {

    /// Windows the buttons under test live in (a preview target must be in one).
    private var windows: [UIWindow] = []

    private func button(width: CGFloat = 81, height: CGFloat = 24, inWindow: Bool = true) -> PillMenuUIButton {
        let button = PillMenuUIButton(frame: CGRect(x: 52, y: 755, width: width, height: height))
        button.menuID = "model"
        if inWindow {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
            window.addSubview(button)
            window.isHidden = false
            windows.append(window)
        }
        return button
    }

    /// Where the menu grows from, in the button's own coordinates.
    private func previewRect(_ preview: UITargetedPreview) -> CGRect {
        let size = preview.view.bounds.size
        let center = preview.target.center
        return CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
    }

    // MARK: - The menu opens above the pill

    /// iOS 26 grows a button's menu out of its highlight preview. The preview sits
    /// wholly above the pill, `menuGap` clear of its top, at every size the pill
    /// takes (the default pill, an AX5 pill three lines tall).
    func testTheMenuGrowsFromAboveThePillNeverOverIt() {
        for (width, height) in [(81.0, 24.3), (140.0, 62.0), (290.0, 150.0)] as [(CGFloat, CGFloat)] {
            let button = self.button(width: width, height: height)
            guard let preview = button.previewAbovePill() else { return XCTFail("no preview in a window") }
            let rect = previewRect(preview)
            XCTAssertTrue(preview.target.container === button)
            XCTAssertEqual(rect.maxY, -PillMenuUIButton.menuGap, accuracy: 0.01,
                           "the menu's source must end \(PillMenuUIButton.menuGap)pt above the pill (\(rect))")
            XCTAssertFalse(rect.intersects(button.bounds), "the menu's source overlaps the pill (\(rect))")
            XCTAssertEqual(rect.midX, button.bounds.midX, accuracy: 0.01, "centered over the pill")
            XCTAssertEqual(rect.size, button.bounds.size, "a pill-sized source, so the menu lines up with the pill")
        }
    }

    /// A pill with another stacked above it (the effort pill under the model pill
    /// at the accessibility sizes) opens its menu above both.
    func testAStackedPillsMenuClearsThePillAboveItToo() {
        let button = self.button(width: 242, height: 61)
        button.menuClearance = 67
        guard let preview = button.previewAbovePill() else { return XCTFail("no preview in a window") }
        let rect = previewRect(preview)
        XCTAssertEqual(rect.maxY, -(PillMenuUIButton.menuGap + 67), accuracy: 0.01)
        let pillAbove = CGRect(x: 0, y: -67, width: 283, height: 61)
        XCTAssertFalse(rect.intersects(pillAbove), "the menu's source overlaps the pill above (\(rect))")
    }

    /// Both previews UIKit asks for (the open and the close) are that one place,
    /// through the real delegate methods.
    func testTheOpenAndTheCloseUseThePreviewAboveThePill() {
        let button = self.button()
        let interaction = UIContextMenuInteraction(delegate: button)
        let configuration = UIContextMenuConfiguration()
        let open = button.contextMenuInteraction(
            interaction, configuration: configuration, highlightPreviewForItemWithIdentifier: "row" as NSString
        )
        let close = button.contextMenuInteraction(
            interaction, configuration: configuration, dismissalPreviewForItemWithIdentifier: "row" as NSString
        )
        for (name, preview) in [("open", open), ("close", close)] {
            guard let preview else { return XCTFail("no \(name) preview") }
            XCTAssertLessThan(previewRect(preview).maxY, 0, "the \(name) preview overlaps the pill")
        }
    }

    /// A zero-size button (before its first layout) still gives UIKit a valid
    /// shape, and a button in no window gives none (UIKit's own placement then)
    /// instead of raising.
    func testAButtonBeforeLayoutOrOffScreenIsSafe() {
        guard let preview = button(width: 0, height: 0).previewAbovePill() else { return XCTFail("no preview") }
        XCTAssertGreaterThan(preview.view.bounds.width, 0)
        XCTAssertGreaterThan(preview.view.bounds.height, 0)
        XCTAssertLessThan(previewRect(preview).maxY, 0)
        XCTAssertNil(button(inWindow: false).previewAbovePill())
    }

    /// Off screen, the delegate methods answer nil (UIKit's default preview) and
    /// never reach `super`, which UIButton does not implement: a `super` call here
    /// raised `doesNotRecognizeSelector` on iOS 26.
    func testTheDelegateOffScreenAnswersNilWithoutCallingSuper() {
        let button = self.button(inWindow: false)
        let interaction = UIContextMenuInteraction(delegate: button)
        let configuration = UIContextMenuConfiguration()
        XCTAssertNil(button.contextMenuInteraction(
            interaction, configuration: configuration, highlightPreviewForItemWithIdentifier: "row" as NSString
        ))
        XCTAssertNil(button.contextMenuInteraction(
            interaction, configuration: configuration, dismissalPreviewForItemWithIdentifier: "row" as NSString
        ))
    }

    // MARK: - Every open gets one close

    private func recorder(_ button: PillMenuUIButton) -> () -> [Bool] {
        var reports: [Bool] = []
        button.onPresentedChange = { _, presented in reports.append(presented) }
        return { reports }
    }

    private func wait(_ seconds: TimeInterval) {
        let done = expectation(description: "wait")
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { done.fulfill() }
        wait(for: [done], timeout: seconds + 2)
    }

    override func tearDown() {
        PillMenuUIButton.displayDeadline = 2
        windows.forEach { $0.isHidden = true }
        windows = []
        super.tearDown()
    }

    func testAShownMenuIsOpenUntilItsDismissalEnds() {
        PillMenuUIButton.displayDeadline = 0.05
        let button = self.button()
        let reports = recorder(button)
        button.menuRequested()
        button.menuDisplayed()
        wait(0.2)
        XCTAssertEqual(reports(), [true], "a displayed menu must not be ended by the display deadline")
        XCTAssertTrue(button.isPresenting)
        button.menuEnded()
        XCTAssertEqual(reports(), [true, false])
        button.menuEnded()
        XCTAssertEqual(reports(), [true, false], "one close per open")
    }

    /// The touch that asked for the menu was cancelled before it appeared: UIKit
    /// sends no end, so the deadline reports the close.
    func testAMenuThatNeverAppearsIsReportedClosed() {
        PillMenuUIButton.displayDeadline = 0.05
        let button = self.button()
        let reports = recorder(button)
        button.menuRequested()
        XCTAssertEqual(reports(), [true])
        wait(0.2)
        XCTAssertEqual(reports(), [true, false])
        XCTAssertFalse(button.isPresenting)
    }

    /// An earlier open's deadline must never end a LATER menu.
    func testAnEarlierDeadlineNeverEndsALaterMenu() {
        PillMenuUIButton.displayDeadline = 0.15
        let button = self.button()
        let reports = recorder(button)
        button.menuRequested()
        button.menuEnded()
        // The next open is requested but not yet displayed when the first
        // open's deadline comes due.
        let next = expectation(description: "second open")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            button.menuRequested()
            next.fulfill()
        }
        wait(for: [next], timeout: 2)
        wait(0.1)
        XCTAssertTrue(button.isPresenting, "the first open's deadline ended the second menu")
        XCTAssertEqual(reports(), [true, false, true])
        button.menuDisplayed()
        wait(0.2)
        XCTAssertEqual(reports(), [true, false, true], "a displayed menu is closed only by its dismissal")
    }

    /// Torn down with the menu up: the close is still reported.
    func testATornDownButtonReportsItsMenuClosed() {
        let button = self.button()
        let reports = recorder(button)
        button.menuDisplayed()
        button.forgetPresentation()
        XCTAssertEqual(reports(), [true, false])
    }

    // MARK: - The menu itself

    /// An unchanged menu is never reassigned (UIKit would rebuild it), a changed
    /// one always is, and the rows carry the model's checkmark and order.
    func testOnlyAChangedMenuIsReassigned() {
        let button = self.button()
        let token = ComposerControlsModel.MenuToken(generation: 1, version: 1)
        let menu = PillMenu(sections: [.init(title: "Model", items: [
            .init(title: "Haiku 4.5", choice: .model("haiku")),
            .init(title: "Sonnet 5", choice: .model("sonnet"), checked: true),
        ])], token: token)
        button.show(menu)
        let first = button.menu
        XCTAssertNotNil(first)
        button.show(menu)
        XCTAssertTrue(button.menu === first, "an unchanged menu was rebuilt")
        var moved = menu
        moved.sections[0].items[0].checked = true
        moved.sections[0].items[1].checked = false
        button.show(moved)
        XCTAssertFalse(button.menu === first, "a changed menu was not installed")
        let rows = (button.menu?.children.first as? UIMenu)?.children.compactMap { $0 as? UIAction } ?? []
        XCTAssertEqual(rows.map(\.title), ["Haiku 4.5", "Sonnet 5"])
        XCTAssertEqual(rows.map(\.state), [.on, .off])
    }
}
