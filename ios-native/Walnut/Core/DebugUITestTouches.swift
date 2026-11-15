#if DEBUG && targetEnvironment(simulator)
import SwiftUI
import UIKit

/// Proof-video touch marks for isolated UI tests only. It observes touches,
/// fails its gesture immediately, and never takes them from the real controls.
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

    private final class TouchProbe: UIGestureRecognizer {
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            guard let window = view as? UIWindow, let touch = touches.first else { state = .failed; return }
            let at = touch.location(in: window)
            let mark = UIView(frame: CGRect(x: at.x - 16, y: at.y - 16, width: 32, height: 32))
            mark.isUserInteractionEnabled = false
            mark.accessibilityElementsHidden = true
            mark.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.3)
            mark.layer.borderColor = UIColor.systemBlue.cgColor
            mark.layer.borderWidth = 2
            mark.layer.cornerRadius = 16
            window.addSubview(mark)
            UIView.animate(withDuration: 0.6, delay: 0.1, options: [.allowUserInteraction]) {
                mark.alpha = 0
            } completion: { _ in mark.removeFromSuperview() }
            state = .failed
        }
    }
}
#endif
