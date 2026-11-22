import SwiftUI

/// A Working task's status glyph breathes (2026-11-21, the user: a working task should blink):
/// its opacity goes 1 to 0.55 and back every 2 seconds, and holds still under Reduce Motion. The
/// web does the same in web/src/styles/working-pulse.css.
struct WorkingPulse: ViewModifier {
    let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    func body(content: Content) -> some View {
        let on = active && !reduceMotion
        content
            .opacity(on && dim ? 0.55 : 1)
            .onChange(of: on, initial: true) { _, now in
                if now {
                    withAnimation(.easeInOut(duration: 1).repeatForever(autoreverses: true)) { dim = true }
                } else {
                    var still = Transaction()
                    still.disablesAnimations = true
                    withTransaction(still) { dim = false }
                }
            }
    }
}

extension View {
    /// Breathes while `active` (a Working task's glyph), still under Reduce Motion.
    func workingPulse(_ active: Bool) -> some View { modifier(WorkingPulse(active: active)) }
}
