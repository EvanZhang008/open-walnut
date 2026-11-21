#if DEBUG && targetEnvironment(simulator)
import SwiftUI
import UIKit

/// Proof-video touch marks for isolated UI tests only. It observes touches,
/// never recognizes, and never takes them from the real controls.
struct DebugUITestTouches: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView { Installer() }
    func updateUIView(_ uiView: UIView, context: Context) {}

    private final class Installer: UIView {
        private static let installed = NSHashTable<UIWindow>.weakObjects()
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window,
                  ProcessInfo.processInfo.arguments.contains("-walnut.uiTestKeychain"),
                  UserDefaults.standard.bool(forKey: "walnut.debug.showTouches"),
                  !Self.installed.contains(window) else { return }
            Self.installed.add(window)
            let probe = TouchProbe(target: nil, action: nil)
            probe.cancelsTouchesInView = false
            probe.delaysTouchesBegan = false
            probe.delaysTouchesEnded = false
            window.addGestureRecognizer(probe)
        }
    }

    /// Marks where a touch starts and, while it moves, the path it takes; it never recognizes,
    /// so the real controls keep every touch.
    private final class TouchProbe: UIGestureRecognizer {
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch = touches.first else { return }
            mark(touch, side: 32, fade: 0.6)
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let touch = touches.first else { return }
            mark(touch, side: 14, fade: 0.8)
        }

        // A scroll that begins must not end the trail: nothing prevents this probe, and it prevents nothing.
        override func canBePrevented(by preventing: UIGestureRecognizer) -> Bool { false }
        override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }

        private func mark(_ touch: UITouch, side: CGFloat, fade: TimeInterval) {
            guard let window = view as? UIWindow else { state = .failed; return }
            let at = touch.location(in: window)
            let mark = UIView(frame: CGRect(x: at.x - side / 2, y: at.y - side / 2, width: side, height: side))
            mark.isUserInteractionEnabled = false
            mark.accessibilityElementsHidden = true
            mark.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.3)
            mark.layer.borderColor = UIColor.systemBlue.cgColor
            mark.layer.borderWidth = 2
            mark.layer.cornerRadius = side / 2
            window.addSubview(mark)
            UIView.animate(withDuration: fade, delay: 0.1, options: [.allowUserInteraction]) {
                mark.alpha = 0
            } completion: { _ in mark.removeFromSuperview() }
        }
    }
}
#endif
