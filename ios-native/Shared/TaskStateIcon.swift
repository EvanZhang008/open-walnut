import SwiftUI
import UIKit

/// The seven states a task's status icon tells apart, the same set and shapes the web draws
/// (2026-11-21, the user: "I can't tell whether it is working or not started"). Each state
/// has its own shape, so it reads without colour; only Working moves; only Needs you is red.
///
/// Shared with the widget extension (the lock-screen work card), which has no task model:
/// what a task's state is lives in the app (`TeamStatusModel.iconState`).
enum TaskIconState: String, CaseIterable {
    case needs, read, working, waiting, snoozed, todo, done

    /// The state's word, the one VoiceOver reads for the icon. The app's other state words
    /// (`UserState.label`, the work card's lists) take theirs from here.
    var label: String {
        switch self {
        case .needs: return "Needs you"
        case .read: return "To read"
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .snoozed: return "Snoozed"
        case .todo: return "Not started"
        case .done: return "Completed"
        }
    }

    /// One colour per meaning, the system's own so it adapts to dark mode: Needs you red,
    /// To read amber, Working green, everything that asks nothing of anyone now grey.
    /// Concrete colours, never a hierarchical style: inside a List header `.secondary`
    /// resolves a level lower (`BoardHeadingType.ink`).
    var color: Color { Color(uiColor: uiColor) }

    /// The same, for UIKit text (the timeline's About dots).
    var uiColor: UIColor {
        switch self {
        case .needs: return .systemRed
        case .read: return .systemOrange
        case .working: return .systemGreen
        case .waiting, .snoozed, .todo, .done: return .systemGray
        }
    }
}

/// A task's status icon: the one mark every task row, pill, chip and heading wears (the
/// web's `TaskStateIcon`). About 14pt beside body text, about 8pt as an inline dot. Working's
/// centre dot breathes (opacity 1 to 0.7 and back every 2 seconds) and stays still under
/// Reduce Motion, in the background, or where the caller says nothing may move.
struct TaskStateIcon: View {
    let state: TaskIconState
    var size: CGFloat = 14
    /// False where an animation cannot run or must not (a Live Activity draws one frame).
    var animates = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var pulses: Bool { animates && state == .working && !reduceMotion && scenePhase == .active }

    var body: some View {
        glyph
            .frame(width: size, height: size)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.label)
    }

    @ViewBuilder
    private var glyph: some View {
        let ink = state.color
        switch state {
        case .needs:
            ZStack {
                TaskIconShape(part: .disc).fill(ink)
                TaskIconShape(part: .bang).fill(Color.white)
            }
        case .read:
            TaskIconShape(part: .page).fill(ink)
        case .working:
            ZStack {
                TaskIconShape(part: .workingRing).fill(ink)
                // Two branches, so each time the dot starts breathing it is a fresh animator (a
                // flag kept on the icon stayed dimmed and still after Working, another state,
                // then Working again).
                if pulses {
                    TaskIconShape(part: .workingDot).fill(ink)
                        .phaseAnimator([false, true]) { dot, dimmed in
                            dot.opacity(dimmed ? 0.7 : 1)
                        } animation: { _ in
                            Animation.easeInOut(duration: 1)
                        }
                } else {
                    TaskIconShape(part: .workingDot).fill(ink)
                }
            }
        case .waiting:
            TaskIconShape(part: .clock).fill(ink)
        case .snoozed:
            TaskIconShape(part: .moon).fill(ink)
        case .todo:
            TaskIconShape(part: .dashedRing).fill(ink)
        case .done:
            TaskIconShape(part: .check).fill(ink)
        }
    }
}

/// The icon's glyphs, drawn in the design's 16-unit box (the web's SVG, path for path) and
/// scaled to the frame. Every part is a filled outline: strokes are outlined in the unit box
/// (so their widths scale with the icon), and the page's lines and the tick are cut out of
/// their shape, so the paper behind shows through on any background.
private struct TaskIconShape: Shape {
    enum Part: CaseIterable {
        case disc, bang, page, workingRing, workingDot, clock, moon, dashedRing, check
    }

    let part: Part

    func path(in rect: CGRect) -> Path {
        let unit = Self.paths[part] ?? Path()
        let scale = CGAffineTransform(translationX: rect.minX, y: rect.minY)
            .scaledBy(x: rect.width / 16, y: rect.height / 16)
        return unit.applying(scale)
    }

    /// Built once: a list of rows never outlines a stroke or cuts a path per frame.
    private static let paths: [Part: Path] = {
        var out: [Part: Path] = [:]
        for part in Part.allCases { out[part] = unitPath(part) }
        return out
    }()

    private static func roundStroke(_ width: CGFloat) -> StrokeStyle {
        StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
    }

    private static func circle(_ r: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: 8 - r, y: 8 - r, width: r * 2, height: r * 2))
    }

    /// One part in the 16-unit box.
    private static func unitPath(_ part: Part) -> Path {
        switch part {
        case .disc:
            return circle(7)
        case .bang:
            // The white "!" on Needs you's disc.
            var p = Path(roundedRect: CGRect(x: 7.1, y: 3.6, width: 1.8, height: 5.6), cornerRadius: 0.9, style: .circular)
            p.addEllipse(in: CGRect(x: 8 - 1.05, y: 11.6 - 1.05, width: 2.1, height: 2.1))
            return p
        case .page:
            // M4 1.8h5.4L12.6 5v8.4a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z
            var page = Path()
            page.move(to: CGPoint(x: 4, y: 1.8))
            page.addLine(to: CGPoint(x: 9.4, y: 1.8))
            page.addLine(to: CGPoint(x: 12.6, y: 5))
            page.addArc(tangent1End: CGPoint(x: 12.6, y: 14.2), tangent2End: CGPoint(x: 4, y: 14.2), radius: 0.8)
            page.addArc(tangent1End: CGPoint(x: 3.2, y: 14.2), tangent2End: CGPoint(x: 3.2, y: 1.8), radius: 0.8)
            page.addArc(tangent1End: CGPoint(x: 3.2, y: 1.8), tangent2End: CGPoint(x: 12.6, y: 1.8), radius: 0.8)
            page.closeSubpath()
            // M5.6 7.4h4.8 M5.6 10h4.8, stroke 1.4, cut out of the page.
            var lines = Path()
            lines.move(to: CGPoint(x: 5.6, y: 7.4))
            lines.addLine(to: CGPoint(x: 10.4, y: 7.4))
            lines.move(to: CGPoint(x: 5.6, y: 10))
            lines.addLine(to: CGPoint(x: 10.4, y: 10))
            return page.subtracting(lines.strokedPath(roundStroke(1.4)))
        case .workingRing:
            return circle(6.2).strokedPath(StrokeStyle(lineWidth: 2))
        case .workingDot:
            return circle(3.6)
        case .clock:
            // The ring, and the hands M8 4.6V8l2.4 1.6.
            var hands = Path()
            hands.move(to: CGPoint(x: 8, y: 4.6))
            hands.addLine(to: CGPoint(x: 8, y: 8))
            hands.addLine(to: CGPoint(x: 10.4, y: 9.6))
            return circle(6.3).strokedPath(StrokeStyle(lineWidth: 1.6))
                .union(hands.strokedPath(roundStroke(1.6)))
        case .moon:
            // M10.9 2.2A6.2 6.2 0 1 0 13.8 10.4 5 5 0 0 1 10.9 2.2Z, its two arcs' centres
            // solved once from the SVG endpoint form (angles in the y-down unit box).
            var moon = Path()
            moon.move(to: CGPoint(x: 10.9, y: 2.2))
            addArc(&moon, center: CGPoint(x: 8.1839, y: 7.7734), radius: 6.2, from: -64.018, sweep: -270.917)
            addArc(&moon, center: CGPoint(x: 14.6761, y: 5.4774), radius: 5, from: 100.091, sweep: 120.864)
            moon.closeSubpath()
            return moon.strokedPath(StrokeStyle(lineWidth: 1.6, lineJoin: .round))
        case .dashedRing:
            return circle(6.3).strokedPath(StrokeStyle(lineWidth: 1.6, dash: [2.6, 2.4]))
        case .check:
            // M4.8 8.2l2.2 2.2 4.2-4.6, stroke 1.8, cut out of the disc.
            var tick = Path()
            tick.move(to: CGPoint(x: 4.8, y: 8.2))
            tick.addLine(to: CGPoint(x: 7, y: 10.4))
            tick.addLine(to: CGPoint(x: 11.2, y: 5.8))
            return circle(7).subtracting(tick.strokedPath(roundStroke(1.8)))
        }
    }

    /// An arc as short line segments, the direction stated by the sweep's sign (degrees, in the
    /// y-down box). Sampled rather than `addArc(center:...clockwise:)`, whose `clockwise`
    /// reads backwards in a flipped coordinate space.
    private static func addArc(_ path: inout Path, center: CGPoint, radius: CGFloat, from start: CGFloat, sweep: CGFloat) {
        let steps = 48
        for i in 1...steps {
            let degrees = start + sweep * CGFloat(i) / CGFloat(steps)
            let radians = degrees * .pi / 180
            path.addLine(to: CGPoint(x: center.x + radius * cos(radians), y: center.y + radius * sin(radians)))
        }
    }
}
