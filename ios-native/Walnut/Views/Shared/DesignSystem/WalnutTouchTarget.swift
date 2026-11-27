import SwiftUI
import UIKit

/// The one way a control keeps a finger's touch while it draws smaller (standard.md "Sizes", iOS
/// column: "a small one draws 32 pt and keeps a 44 pt touch"). Nothing it does moves or redraws a
/// thing: it only says where a tap still counts.
///
/// - `.walnutTouchTarget()` on a SwiftUI label (or inside a style's body): its hit shape reaches
///   past the drawn frame until it covers 44 x 44 pt. The shape reads the frame it is given, so it
///   follows the drawn size at every text size with no measuring.
/// - `.walnutTouchRoom(_:)` on a key, or on a row of keys: how far a touch may reach on each side
///   before it meets a neighbour's (`WalnutTouchRoom`). The family's styles (`WalnutButtonStyle`,
///   `WalnutChipStyle`, `walnutPickerKey`, `PillChip`) read it, so a tight row says it once.
/// - `.walnutMenuTouch()` on a `Menu` around such a label: a Menu hit-tests only its own frame, so
///   there the label grows its real frame and the Menu gives the room back outside it.
/// - A UIKit button laid over a small drawing (`PillMenuUIButton`) takes the touch itself: SwiftUI
///   grows its frame past the drawing (`walnutTouchOutset`), and `WalnutTouchUIButton` keeps the
///   drawn rect for VoiceOver, XCUITest and its menu's preview.
///
/// Neighbours: SwiftUI gives a tap in two overlapping shapes to the one in front, which is not
/// always the nearer one. So the reach toward a neighbour stops at half the gap between two keys
/// that both reach, and at the whole gap toward a control that keeps to its own frame (a field);
/// the closer key always wins and no key ever takes a tap from another one's drawing.
enum WalnutTouchTarget {
    /// A finger: the least touch on both axes.
    static let minimum: CGFloat = Theme.Control.target

    /// How far the touch reaches past each edge of a control drawn `size`: what makes it `minimum`
    /// on each axis, split evenly; what one side's room cannot take goes to the other side. Zero on
    /// an axis already `minimum` or more. Pure, unit-tested (WalnutTouchTargetTests).
    static func reach(for size: CGSize, room: WalnutTouchRoom = .open,
                      minimum: CGFloat = WalnutTouchTarget.minimum) -> EdgeInsets {
        let across = split(max(0, minimum - size.width), room.leading, room.trailing)
        let down = split(max(0, minimum - size.height), room.top, room.bottom)
        return EdgeInsets(top: down.0, leading: across.0, bottom: down.1, trailing: across.1)
    }

    /// The touch area of a control drawn in `rect`.
    static func area(for rect: CGRect, room: WalnutTouchRoom = .open,
                     minimum: CGFloat = WalnutTouchTarget.minimum) -> CGRect {
        let r = reach(for: rect.size, room: room, minimum: minimum)
        return CGRect(x: rect.minX - r.leading, y: rect.minY - r.top,
                      width: rect.width + r.leading + r.trailing,
                      height: rect.height + r.top + r.bottom)
    }

    /// `need` points shared by two sides that may take at most `a` and `b`.
    private static func split(_ need: CGFloat, _ a: CGFloat, _ b: CGFloat) -> (CGFloat, CGFloat) {
        guard need > 0 else { return (0, 0) }
        let roomA = max(0, a), roomB = max(0, b)
        var first = min(need / 2, roomA)
        let second = min(need - first, roomB)
        first = min(need - second, roomA)
        return (first, second)
    }
}

/// How far a small control's touch may reach past each edge of its drawing (`WalnutTouchTarget`).
/// `.infinity`: nothing pressable on that side.
struct WalnutTouchRoom: Equatable, Sendable {
    var top: CGFloat = .infinity
    var leading: CGFloat = .infinity
    var bottom: CGFloat = .infinity
    var trailing: CGFloat = .infinity

    /// No neighbour close enough to matter: reach as far as a finger needs.
    static let open = WalnutTouchRoom()

    /// Keys `horizontal` pt apart on a row, or `vertical` pt apart in a column (or wrapped lines):
    /// each reaches at most half the gap toward its neighbour.
    static func gaps(horizontal: CGFloat = .infinity, vertical: CGFloat = .infinity) -> WalnutTouchRoom {
        WalnutTouchRoom(top: vertical / 2, leading: horizontal / 2, bottom: vertical / 2, trailing: horizontal / 2)
    }
}

/// The hit shape `walnutTouchTarget` sets: the drawn rect grown to a finger, within its room.
struct WalnutTouchShape: Shape {
    var room: WalnutTouchRoom = .open

    func path(in rect: CGRect) -> Path {
        Path(WalnutTouchTarget.area(for: rect, room: room))
    }
}

private struct WalnutTouchTargetModifier: ViewModifier {
    var room: WalnutTouchRoom?
    @Environment(\.walnutTouchRoom) private var inherited
    @Environment(\.walnutMenuTouch) private var menu

    func body(content: Content) -> some View {
        let room = room ?? inherited
        if let menu {
            // Inside a Menu's label (`walnutMenuTouch()`): grow the real frame, since a Menu takes
            // taps only inside its own frame; the drawing is measured before it grows.
            content
                .onGeometryChange(for: CGSize.self) { $0.size } action: { menu.report($0, room) }
                .padding(menu.reach)
                .contentShape(Rectangle())
        } else {
            content.contentShape(WalnutTouchShape(room: room))
        }
    }
}

/// What `walnutMenuTouch()` hands the label inside its Menu: how far the label grows its frame,
/// and where it reports the size it draws (and its room) so that reach can be worked out.
struct WalnutMenuTouchLink {
    var reach: EdgeInsets
    var report: (CGSize, WalnutTouchRoom) -> Void
}

/// A system Menu takes a tap only inside its own frame: a hit shape inside its label cannot reach
/// past it (2026-11-27, TouchTargetOrgUITests: a tap 6 pt above a 28 pt Snooze opened nothing). So
/// the label (its `.walnutTouchTarget()`, or a family style's) grows its frame by its reach, and
/// this gives that room back outside the Menu with a negative padding: the layout around it does
/// not move, and the Menu itself is 44 pt to a finger.
private struct WalnutMenuTouchModifier: ViewModifier {
    @State private var reach = EdgeInsets()

    func body(content: Content) -> some View {
        let reach = reach
        content
            .environment(\.walnutMenuTouch, WalnutMenuTouchLink(reach: reach) { drawn, room in
                let next = WalnutTouchTarget.reach(for: drawn, room: room)
                if next != reach { self.reach = next }
            })
            .walnutTouchOutset(reach)
    }
}

extension EnvironmentValues {
    /// The room a key's touch has on this row (`walnutTouchRoom(_:)`).
    @Entry var walnutTouchRoom = WalnutTouchRoom.open
    /// Set inside a Menu by `walnutMenuTouch()`; nil everywhere else.
    @Entry var walnutMenuTouch: WalnutMenuTouchLink? = nil
}

extension View {
    /// Keep a 44 pt touch around whatever this draws (`WalnutTouchTarget`). `room`: this key's own
    /// room; nil takes the row's (`walnutTouchRoom(_:)`). Apply it to the drawn label, after its
    /// frame and fill; it replaces a `.contentShape(Rectangle())` there.
    func walnutTouchTarget(_ room: WalnutTouchRoom? = nil) -> some View {
        modifier(WalnutTouchTargetModifier(room: room))
    }

    /// On a `Menu` whose label draws smaller than a finger: its label's `.walnutTouchTarget()` (or
    /// the family style's) then grows the Menu's own frame, given back outside so nothing moves.
    /// Apply it to the Menu itself, before its other modifiers (`WalnutMenuTouchModifier`).
    func walnutMenuTouch() -> some View {
        modifier(WalnutMenuTouchModifier())
    }

    /// The room every small key in here has (`WalnutTouchRoom`), the family's styles included.
    func walnutTouchRoom(_ room: WalnutTouchRoom) -> some View {
        environment(\.walnutTouchRoom, room)
    }

    /// Grow an overlay `reach` past the drawing it covers without moving anything (an overlay takes
    /// no room): the frame a UIKit control needs to take the touch itself (`WalnutTouchUIButton`).
    func walnutTouchOutset(_ reach: EdgeInsets) -> some View {
        padding(EdgeInsets(top: -reach.top, leading: -reach.leading,
                           bottom: -reach.bottom, trailing: -reach.trailing))
    }
}

/// A UIKit button laid over a small SwiftUI drawing, whose frame SwiftUI grew past the drawing by
/// `touchOutset` (`walnutTouchOutset`) so the button itself takes a 44 pt touch: UIKit hit-tests a
/// view by its bounds, which no SwiftUI hit shape can widen. What is drawn (`drawnBounds`) stays
/// what VoiceOver and XCUITest read and where a menu's preview sits.
class WalnutTouchUIButton: UIButton {
    var touchOutset: UIEdgeInsets = .zero

    /// The drawing under the button, in its own coordinates.
    var drawnBounds: CGRect {
        let drawn = bounds.inset(by: touchOutset)
        return drawn.isNull || drawn.width <= 0 || drawn.height <= 0 ? bounds : drawn
    }

    override var accessibilityFrame: CGRect {
        get { UIAccessibility.convertToScreenCoordinates(drawnBounds, in: self) }
        set { super.accessibilityFrame = newValue }
    }

    static func outset(_ reach: EdgeInsets) -> UIEdgeInsets {
        UIEdgeInsets(top: reach.top, left: reach.leading, bottom: reach.bottom, right: reach.trailing)
    }
}
