import SwiftUI
import UIKit

/// How far a leading-edge drawer is out, shared between the host that draws it and
/// whatever control toggles it (a toolbar button inside the hosted content).
///
/// A reference object on purpose. The fraction changes on every frame of a drag, and
/// the screen hosting this drawer (the Tasks board) has an expensive body: a `@State`
/// fraction on that screen would re-run its whole body per frame. Only the host's
/// modifier reads `progress`, so a drag re-renders the offset, the scrim and the
/// drawer, and never the board under them.
@Observable
@MainActor
final class LeadingDrawerModel {
    /// 0 shut, 1 open.
    var progress: Double = 0
    /// Up while a drawer drag is tracked: a drag that starts on a row and ends on it
    /// must not also tap it (`ChatView.suppressDrawerTaps` has the incident).
    var suppressTaps = false
    /// True while any of the drawer is on screen, including its slide out. The rows exist
    /// only then: a shut drawer costs nothing (not even a dependency on the stores it
    /// lists), and it cannot linger in the accessibility tree. `accessibilityHidden` alone
    /// left the shut drawer's rows findable by XCUITest, the same lesson
    /// `ChatView.scrimLayer` records for its closer.
    private(set) var mounted = false

    var isOpen: Bool { progress > 0.5 }

    func setOpen(_ open: Bool) {
        let animation: Animation? = UIAccessibility.isReduceMotionEnabled
            ? nil : .spring(response: 0.34, dampingFraction: 0.86)
        if open {
            mounted = true
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
            withAnimation(animation) { progress = 1 }
            return
        }
        guard let animation, progress > 0 else {
            progress = 0
            mounted = false
            return
        }
        // Unmount once the slide has finished, and only if nothing reopened it meanwhile.
        withAnimation(animation, completionCriteria: .logicallyComplete) {
            progress = 0
        } completion: { [weak self] in
            guard let self, self.progress == 0 else { return }
            self.mounted = false
        }
    }

    /// A drag's live value, unanimated.
    func track(_ value: Double) {
        if value > 0 { mounted = true }
        progress = value
    }
}

/// The Chat tab's drawer shell, for a screen that is not the chat: the content slides
/// aside, a scrim dims the sliver left showing, the drawer comes in from the leading
/// edge, and an edge swipe does the same interactively.
///
/// Every rule here is `ChatView`'s, applied to a different content, and the geometry is
/// literally the same (`ChatDrawerGeometry`). What it leaves out is the chat's composer
/// compensation: no composer rides this content's bottom edge.
struct LeadingDrawerHost<Drawer: View>: ViewModifier {
    let model: LeadingDrawerModel
    /// May an edge swipe OPEN it right now. Closing is always allowed while open.
    let canOpen: Bool
    let edgeZone: CGFloat
    /// Prefix for the scrim's accessibility id (`<prefix>.scrim`).
    let identifier: String
    @ViewBuilder let drawer: () -> Drawer

    @State private var dragOrigin: Double?
    @State private var dragRejected = false
    @State private var containerWidth: CGFloat = 0
    /// Up while a drag is live. SwiftUI resets it when the gesture ends AND when the
    /// system cancels it (a call banner, Control Center), but calls `onEnded` only for the
    /// first; this is how a cancelled drag still settles instead of leaving the drawer
    /// half out with taps suppressed.
    @GestureState private var dragLive = false

    private var drawerWidth: CGFloat { ChatDrawerGeometry.width(container: containerWidth) }

    func body(content: Content) -> some View {
        let progress = model.progress
        let isOpen = model.isOpen
        ZStack(alignment: .topLeading) {
            content
                .offset(x: drawerWidth * progress)
                // An open drawer is modal: what it covers must not be read out behind it.
                .accessibilityHidden(isOpen)
            // Only while the drawer is out. A full-screen layer above the content, even an
            // empty and untouchable one, is what an ACCESSIBILITY hit test lands on: with it
            // always mounted, every board row read as not hittable to XCUITest, which is
            // also what VoiceOver's touch exploration would have found under a finger.
            if model.mounted {
                scrimLayer(progress: progress, isOpen: isOpen)
                    .transition(.opacity)
            }
            drawerLayer(progress: progress, isOpen: isOpen)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
        // A floating tab bar paints over the tab's content, so an open drawer would have
        // it hovering above its rows, undimmed (same rule as the chat's drawer).
        .toolbarVisibility(
            ChatDrawerGeometry.tabBarHidden(progress: progress) ? .hidden : .automatic,
            for: .tabBar
        )
        // SIMULTANEOUS, so the list under it keeps scrolling; `tracksDrag` keeps the two
        // apart. Off entirely when it may not open and is not open, so a pushed page's
        // own back swipe from the same edge is never shared with this.
        .simultaneousGesture(edgeDrag, including: (canOpen || isOpen) ? .all : .subviews)
        .onChange(of: dragLive) { _, live in
            // A runloop later, so a drag that ended normally has already settled in
            // `onEnded` (with its velocity) and this finds nothing left to do.
            guard !live else { return }
            DispatchQueue.main.async { settleCancelledDrag() }
        }
    }

    private func settleCancelledDrag() {
        dragRejected = false
        model.suppressTaps = false
        guard dragOrigin != nil else { return }
        dragOrigin = nil
        model.setOpen(model.progress >= 0.5)
    }

    private func drawerLayer(progress: Double, isOpen: Bool) -> some View {
        Group {
            if model.mounted {
                // Rides the shell's slide; a fade on top of it would read as lag.
                drawer()
                    .transition(.identity)
            } else {
                Color.clear
            }
        }
        .frame(width: drawerWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            Color(.secondarySystemBackground)
                .ignoresSafeArea(edges: [.top, .bottom])
                .shadow(color: .black.opacity(0.22 * progress), radius: 14, x: 3, y: 0)
        }
        .offset(x: drawerWidth * (progress - 1))
        .allowsHitTesting(isOpen)
        .accessibilityHidden(!isOpen)
    }

    /// The dim is decoration (no touch, always mounted so it fades); the closer exists
    /// only while open and covers only the sliver of content beside the drawer. Both
    /// halves are `ChatView.scrimLayer`'s, for the reasons written there.
    private func scrimLayer(progress: Double, isOpen: Bool) -> some View {
        ZStack(alignment: .trailing) {
            Color.black.opacity(ChatDrawerGeometry.maxScrimOpacity)
                .opacity(progress)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            if isOpen {
                Color.clear
                    .frame(width: max(0, containerWidth - drawerWidth * progress))
                    .contentShape(Rectangle())
                    .onTapGesture { model.setOpen(false) }
                    .accessibilityIdentifier("\(identifier).scrim")
                    .accessibilityLabel("Close")
                    .accessibilityAddTraits(.isButton)
            }
        }
        .accessibilityElement(children: .contain)
        .ignoresSafeArea()
    }

    private var edgeDrag: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragLive) { _, live, _ in live = true }
            .onChanged { value in
                if model.isOpen { model.suppressTaps = true }
                if dragOrigin == nil {
                    guard !dragRejected else { return }
                    guard ChatDrawerGeometry.tracksDrag(
                        startX: value.startLocation.x,
                        translation: value.translation,
                        isOpen: model.isOpen,
                        edgeZone: edgeZone
                    ) else {
                        dragRejected = true
                        return
                    }
                    dragOrigin = model.progress
                    model.suppressTaps = true
                    UIApplication.shared.sendAction(
                        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
                    )
                }
                guard let origin = dragOrigin else { return }
                model.track(ChatDrawerGeometry.progress(
                    from: origin, translationX: value.translation.width, width: drawerWidth
                ))
            }
            .onEnded { value in
                dragRejected = false
                // A runloop turn later: the lift-off that ends this drag is the same
                // event a row's Button acts on (see `ChatView.edgeDrag`).
                DispatchQueue.main.async { model.suppressTaps = false }
                guard dragOrigin != nil else { return }
                dragOrigin = nil
                model.setOpen(ChatDrawerGeometry.settlesOpen(
                    progress: model.progress, velocityX: value.velocity.width
                ))
            }
    }
}

extension View {
    /// Host a leading-edge drawer over this view. See `LeadingDrawerHost`.
    func leadingDrawer<Drawer: View>(
        _ model: LeadingDrawerModel,
        canOpen: Bool,
        edgeZone: CGFloat = ChatDrawerGeometry.edgeZone,
        identifier: String,
        @ViewBuilder drawer: @escaping () -> Drawer
    ) -> some View {
        modifier(LeadingDrawerHost(
            model: model, canOpen: canOpen, edgeZone: edgeZone,
            identifier: identifier, drawer: drawer
        ))
    }
}
