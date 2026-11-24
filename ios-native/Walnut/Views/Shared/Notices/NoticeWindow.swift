import SwiftUI
import UIKit

/// Where every notice shows: one window of its own just above the app's, so a notice is seen over
/// any sheet or cover that is up (a notice drawn inside a tab sat under them, and its timer ran
/// out unseen). It shows only while the center holds a notice, takes only the touches that land
/// on the stack (everything else goes through to the app), and never becomes the key window, so
/// it takes no keyboard or focus. The Talk panel's window is above it.
@MainActor
final class NoticeWindow {
    static let shared = NoticeWindow()

    private var window: PassThroughWindow?
    private let center: NoticeCenter

    private init(center: NoticeCenter = .shared) {
        self.center = center
    }

    /// Hook the shared center up: called once at launch (`RootView`).
    func install() {
        center.onPresenceChange = { [weak self] present in self?.setShown(present) }
        if !center.entries.isEmpty { setShown(true) }
    }

    private func setShown(_ shown: Bool) {
        if shown {
            guard let window = window ?? makeWindow() else { return }
            window.isHidden = false
        } else {
            window?.isHidden = true
            window?.stackRect = .zero
        }
    }

    private func makeWindow() -> PassThroughWindow? {
        guard let scene = PresentationLowering.appWindow()?.windowScene
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
        else { return nil }
        let window = PassThroughWindow(windowScene: scene)
        // Above the app and its sheets, under the Talk panel (`.alert`).
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.normal.rawValue + 1)
        let host = NoticeHostController(rootView: NoticeStack(center: center) { [weak window] rect in
            window?.stackRect = rect
        })
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.backgroundColor = .clear
        self.window = window
        return window
    }
}

/// Takes a touch only inside the notice stack; anywhere else the app under it gets it.
private final class PassThroughWindow: UIWindow {
    /// The stack's frame in this window, reported by the SwiftUI stack itself (a hit test of a
    /// hosting view cannot tell its drawn parts from its empty ones).
    var stackRect: CGRect = .zero

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard stackRect.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }

    // Never the key window: the chat's keyboard stays where it is.
    override var canBecomeKey: Bool { false }
}

/// The status bar keeps the app's look while a notice is up.
private final class NoticeHostController: UIHostingController<NoticeStack> {
    override var preferredStatusBarStyle: UIStatusBarStyle { PresentationLowering.top()?.preferredStatusBarStyle ?? .default }
    override var prefersStatusBarHidden: Bool { PresentationLowering.top()?.prefersStatusBarHidden ?? false }
}

/// The notices at the top of the screen, newest nearest the edge, at most three, then "N more".
struct NoticeStack: View {
    let center: NoticeCenter
    /// The stack's frame in the window, for its touches.
    let reportFrame: (CGRect) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 8) {
            ForEach(center.inSight) { item in
                SwipeAwayCard(item: item) { close(item.id) }
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
            if center.folded > 0 {
                Button { withAnimation(animation) { center.showsAll = true } } label: {
                    Text("\(center.folded) more")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.regularMaterial, in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.1), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(center.folded) more notices")
                .accessibilityIdentifier("notice.more")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 12)
        .frame(maxWidth: 520)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { reportFrame($0) }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(animation, value: center.entries.map(\.id))
        // No accessibility container or identifier of its own: over a single card SwiftUI folds a
        // container into its one child, and the stack's identifier replaced the card's, so a lone
        // notice ("chat.orgOpening", "chat.orgOpenNotice") could not be found by its id
        // (NoticeIdentityUITests).
    }

    private var animation: Animation? { reduceMotion ? nil : .snappy(duration: 0.3) }

    private func close(_ id: String) {
        withAnimation(animation) { center.dismiss(id) }
    }
}

/// A card that follows a finger up and goes when let go far enough.
private struct SwipeAwayCard: View {
    let item: NoticeItem
    let dismiss: () -> Void

    @State private var lift: CGFloat = 0

    /// How far up a let-go takes it away.
    static let threshold: CGFloat = 28

    var body: some View {
        NoticeCard(item: item, onClose: dismiss)
            .offset(y: lift)
            .opacity(1 + Double(lift) / 120)
            .simultaneousGesture(
                DragGesture(minimumDistance: 8)
                    .onChanged { lift = min(0, $0.translation.height) }
                    .onEnded { value in
                        if value.translation.height < -Self.threshold || value.predictedEndTranslation.height < -80 {
                            dismiss()
                        } else {
                            withAnimation(.snappy(duration: 0.2)) { lift = 0 }
                        }
                    }
            )
    }
}
