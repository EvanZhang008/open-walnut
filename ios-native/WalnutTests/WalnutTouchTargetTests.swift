import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// The one way a small control keeps a 44 pt touch (`WalnutTouchTarget`, standard.md "Sizes"):
/// how far the touch reaches past a drawing, within the room its neighbours leave, and the UIKit
/// pill button that takes the grown touch while VoiceOver and its menu keep the drawn pill.
/// TouchTargetUITests taps the grown areas on screen.
@MainActor
final class WalnutTouchTargetTests: XCTestCase {

    private func total(_ r: EdgeInsets) -> CGSize {
        CGSize(width: r.leading + r.trailing, height: r.top + r.bottom)
    }

    /// A 32 pt key with nothing near: 6 pt on every side, 44 x 44.
    func testASmallKeyReachesEvenlyToAFinger() {
        let r = WalnutTouchTarget.reach(for: CGSize(width: 32, height: 32))
        XCTAssertEqual(r, EdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 6))
        XCTAssertEqual(WalnutTouchTarget.area(for: CGRect(x: 10, y: 20, width: 32, height: 32)),
                       CGRect(x: 4, y: 14, width: 44, height: 44))
    }

    /// An axis already 44 pt or more grows nothing on that axis (a wide pill: only up and down).
    func testAWideKeyGrowsOnlyWhereItIsShort() {
        let r = WalnutTouchTarget.reach(for: CGSize(width: 121, height: 34))
        XCTAssertEqual(r.leading, 0)
        XCTAssertEqual(r.trailing, 0)
        XCTAssertEqual(r.top, 5)
        XCTAssertEqual(r.bottom, 5)
        XCTAssertEqual(WalnutTouchTarget.reach(for: CGSize(width: 50, height: 52)), EdgeInsets())
    }

    /// Two 32 pt keys 8 pt apart: each reaches half the gap toward the other, so the closer key wins.
    func testNeighboursShareTheGapByHalves() {
        let r = WalnutTouchTarget.reach(for: CGSize(width: 32, height: 32), room: .gaps(horizontal: 8))
        XCTAssertEqual(r.leading, 4)
        XCTAssertEqual(r.trailing, 4)
        XCTAssertEqual(r.top, 6)
    }

    /// What one side's room cannot take goes to the other side: the calendar's funnel, 20 pt wide
    /// with 6 pt of room toward the add key, reaches 18 pt toward the title.
    func testAShortSideHandsItsRestToTheOtherSide() {
        let r = WalnutTouchTarget.reach(for: CGSize(width: 20, height: 32), room: WalnutTouchRoom(trailing: 6))
        XCTAssertEqual(r.trailing, 6)
        XCTAssertEqual(r.leading, 18)
        XCTAssertEqual(total(r).width + 20, 44)
        // Both sides short: as far as the room goes, and no further.
        let tight = WalnutTouchTarget.reach(for: CGSize(width: 300, height: 17), room: WalnutTouchRoom(top: 1, bottom: 2))
        XCTAssertEqual(tight.top, 1)
        XCTAssertEqual(tight.bottom, 2)
    }

    /// The hit shape is the area, at whatever size the label is laid out.
    func testTheShapeIsTheArea() {
        let rect = CGRect(x: 0, y: 0, width: 32, height: 26)
        let shape = WalnutTouchShape(room: .gaps(vertical: 6))
        XCTAssertEqual(shape.path(in: rect).boundingRect, CGRect(x: -6, y: -3, width: 44, height: 32))
    }

    /// The timeline's chip cells claim the same reach from the gap as every other small control.
    func testTheTimelineChipOutsetIsTheSameRule() {
        XCTAssertEqual(TimelineHostedCell.minimumTapHeight, WalnutTouchTarget.minimum)
    }

    /// The composer pill's UIKit button is the grown touch, but VoiceOver, XCUITest and its menu
    /// read the pill as drawn.
    func testAPillButtonGrownToTheTouchKeepsItsDrawnPill() {
        let button = PillMenuUIButton(frame: CGRect(x: 47, y: 750, width: 91, height: 44))
        button.touchOutset = UIEdgeInsets(top: 5, left: 0, bottom: 5, right: 0)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
        window.addSubview(button)
        window.isHidden = false
        defer { window.isHidden = true }
        XCTAssertEqual(button.drawnBounds, CGRect(x: 0, y: 5, width: 91, height: 34))
        XCTAssertEqual(button.accessibilityFrame.height, 34, accuracy: 0.01)
        XCTAssertEqual(button.accessibilityFrame.width, 91, accuracy: 0.01)
        // The touch is the whole button: a point 3 pt above the drawn pill is inside it.
        XCTAssertTrue(button.point(inside: CGPoint(x: 45, y: 2), with: nil))
        // The menu still grows from just above the drawn pill, the pill's size.
        guard let preview = button.previewAbovePill() else { return XCTFail("no preview in a window") }
        let size = preview.view.bounds.size
        XCTAssertEqual(size, CGSize(width: 91, height: 34))
        XCTAssertEqual(preview.target.center.y + size.height / 2, 5 - PillMenuUIButton.menuGap, accuracy: 0.01)
        // Nothing measured yet (no outset): the drawn pill is the whole button.
        button.touchOutset = .zero
        XCTAssertEqual(button.drawnBounds, button.bounds)
    }
}
