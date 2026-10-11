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

    /// The bottom room to hand back to the content while the tab bar is away, so a
    /// composer riding the content's bottom edge stays put through the slide. Read
    /// only by `LeadingDrawerTabBarBand`, so it re-renders that band and nothing else.
    /// See `tabBarCompensation(pageHeight:heightsWithTabBar:)`.
    private(set) var tabBarCompensation: CGFloat = 0
    @ObservationIgnored private var heightsWithTabBar: [CGFloat] = []

    /// The drawer content's own horizontal scrollers that a finger is moving right now
    /// (the board's chip rail). A drag one of them owns is its scroll, never a close.
    /// Written by `drawerCloseExempt`, read only inside the drag handler, so never
    /// observed.
    ///
    /// The scroller's PHASE, not its frame: the rail's frame was measured once, in a
    /// coordinate space a `List` row does not resolve, and while the drawer was shut, a
    /// panel's width off screen, so a drag on the open drawer's rail closed it twice over
    /// (2026-10-10).
    @ObservationIgnored private var scrollingInside: Set<String> = []

    /// The host's coordinate space, which the drag is measured in.
    static let coordinateSpace = "leadingDrawerHost"

    var isOpen: Bool { progress > 0.5 }

    func setInnerScroll(_ id: String, active: Bool) {
        if active { scrollingInside.insert(id) } else { scrollingInside.remove(id) }
    }

    /// A scroller inside the drawer is being moved by the finger.
    var innerScrollActive: Bool { !scrollingInside.isEmpty }

    /// One page-height sample from the host (`ChatView`'s measurement, with a bound
    /// `tabBarCompensation(pageHeight:heightsWithTabBar:)` explains).
    func notePageHeight(_ height: CGFloat) {
        let hidden = ChatDrawerGeometry.tabBarHidden(progress: progress)
        if !hidden { heightsWithTabBar = Self.remembering(height, in: heightsWithTabBar) }
        let next = hidden
            ? Self.tabBarCompensation(pageHeight: height, heightsWithTabBar: heightsWithTabBar)
            : 0
        if next != tabBarCompensation { tabBarCompensation = next }
    }

    /// The page heights seen with the tab bar present: a few distinct ones, newest last.
    static func remembering(_ height: CGFloat, in heights: [CGFloat]) -> [CGFloat] {
        Array((heights.filter { abs($0 - height) >= 0.5 } + [height]).suffix(8))
    }

    /// The room the tab bar left, to hand back below the composer while it is away: the
    /// page now, less the tallest page seen with the bar that is still SHORTER than it.
    ///
    /// The bound is the difference from `ChatDrawerGeometry.tabBarCompensation`'s running
    /// maximum. A page with the bar is always shorter than the same page without it, so a
    /// taller sample was no page with a bar: the Tasks tab reports the whole window
    /// (874 pt on a 402 x 874 phone) once before its safe area is applied, the maximum
    /// kept it, and the composer dropped 49 pt every time the drawer opened over a session
    /// (UI QA, 2026-10-11). Nor is a page more than `maxTabBarRoom` shorter, so a sample
    /// the keyboard shrank is no base either, and a page the keyboard shrinks while the
    /// bar is away gets nothing, as before.
    static func tabBarCompensation(pageHeight: CGFloat, heightsWithTabBar: [CGFloat]) -> CGFloat {
        let bases = heightsWithTabBar.filter { $0 < pageHeight && pageHeight - $0 <= maxTabBarRoom }
        guard let base = bases.max() else { return 0 }
        return pageHeight - base
    }

    /// More than a floating tab bar ever takes from the page (49 pt measured on iOS 26),
    /// and less than any keyboard.
    static let maxTabBarRoom: CGFloat = 120

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
        // A drawer kept mounted while shut (the Tasks board) still holds its search
        // field: a keyboard it raised must not stay up over the page it closed onto.
        if progress > 0 {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
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
/// literally the same (`ChatDrawerGeometry`). The chat's composer compensation is the
/// model's `tabBarCompensation`, which content with a composer applies through
/// `LeadingDrawerTabBarBand`.
struct LeadingDrawerHost<Drawer: View>: ViewModifier {
    let model: LeadingDrawerModel
    /// May an edge swipe OPEN it right now. Closing is always allowed while open.
    let canOpen: Bool
    let edgeZone: CGFloat
    /// Prefix for the scrim's accessibility id (`<prefix>.scrim`).
    let identifier: String
    /// Keep the drawer's view alive while it is shut, hidden. For a drawer whose content
    /// is a whole screen (the Tasks board: its scroll position, search text and derived
    /// bands), rebuilding it on every open would cost a hitch and lose the user's place.
    /// Shut, it is transparent, untouchable and folded out of the accessibility tree.
    /// Known gap: the fold stops at UIKit-backed content. A shut board's `List` rows and
    /// its navigation bar stay in the tree, a panel's width off screen; a flag on the
    /// List, on its rows, or set in UIKit on the collection view did not take them out
    /// (gate runs 12 to 16, 2026-10-10).
    var keepsDrawerMounted = false
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
        .coordinateSpace(.named(LeadingDrawerModel.coordinateSpace))
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            containerWidth = size.width
            model.notePageHeight(size.height)
        }
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
            if keepsDrawerMounted {
                // Always built; shut means hidden, never torn down. One chain with
                // different VALUES, never an `if`: a branch would be a new identity and
                // rebuild the whole screen on every open. Hiding it from accessibility
                // takes the fold as well as the flag: a subtree whose containers say
                // `.contain` re-publishes its children whatever an outer `hidden` says
                // (the lesson `BoardBandBar.card` records), so a shut drawer folds to
                // one element first and that element is what gets hidden.
                drawer()
                    .opacity(model.mounted ? 1 : 0)
                    .accessibilityElement(children: model.mounted ? .contain : .ignore)
                    .accessibilityHidden(!model.mounted)
            } else if model.mounted {
                // Rides the shell's slide; a fade on top of it would read as lag.
                drawer()
                    .transition(.identity)
            } else {
                Color.clear
            }
        }
        .environment(\.leadingDrawer, model)
        .frame(width: drawerWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background {
            Color(.secondarySystemBackground)
                .ignoresSafeArea(edges: [.top, .bottom])
                .shadow(color: .black.opacity(0.22 * progress), radius: 14, x: 3, y: 0)
        }
        // Where the drawer ends. In dark mode the board's page and the dimmed page beside
        // it are both black, and a shadow does not show on black (UI QA, 2026-10-11).
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color(.separator))
                .frame(width: 0.5)
                .ignoresSafeArea(edges: [.top, .bottom])
                .allowsHitTesting(false)
                .accessibilityHidden(true)
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
        DragGesture(minimumDistance: 12, coordinateSpace: .named(LeadingDrawerModel.coordinateSpace))
            .updating($dragLive) { _, live, _ in live = true }
            .onChanged { value in
                // A drag a scroller inside the drawer took (the board's chip rail) is that
                // scroller's, never a close. Its pan can be recognised a beat after this
                // one began tracking: then the drawer goes back to where the drag found it.
                if model.innerScrollActive {
                    if let origin = dragOrigin {
                        dragOrigin = nil
                        model.track(origin)
                    }
                    dragRejected = true
                    return
                }
                if dragOrigin == nil {
                    guard !dragRejected else { return }
                }
                if model.isOpen { model.suppressTaps = true }
                if dragOrigin == nil {
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
        keepsDrawerMounted: Bool = false,
        @ViewBuilder drawer: @escaping () -> Drawer
    ) -> some View {
        modifier(LeadingDrawerHost(
            model: model, canOpen: canOpen, edgeZone: edgeZone,
            identifier: identifier, keepsDrawerMounted: keepsDrawerMounted, drawer: drawer
        ))
    }

    /// Mark this view (a horizontal `ScrollView`, or a view holding one) as the drawer
    /// content's own scroller, so a drag it scrolls never also closes the drawer. A no-op
    /// outside a drawer.
    func drawerCloseExempt(_ id: String, active: Bool = true) -> some View {
        modifier(DrawerCloseExemption(id: id, active: active))
    }
}

extension EnvironmentValues {
    /// The drawer this view is inside, if any (set by `LeadingDrawerHost`).
    @Entry var leadingDrawer: LeadingDrawerModel?
}

private struct DrawerCloseExemption: ViewModifier {
    let id: String
    let active: Bool
    @Environment(\.leadingDrawer) private var drawer

    func body(content: Content) -> some View {
        content
            // Only a scroll the finger is driving: one that fits its room never moves,
            // so a drag on it still closes the drawer.
            .onScrollPhaseChange { _, phase in
                drawer?.setInnerScroll(id, active: active && Self.fingerDriven(phase))
            }
            .onChange(of: active) { _, now in
                if !now { drawer?.setInnerScroll(id, active: false) }
            }
            .onDisappear { drawer?.setInnerScroll(id, active: false) }
    }

    static func fingerDriven(_ phase: ScrollPhase) -> Bool {
        switch phase {
        case .interacting, .decelerating: true
        default: false
        }
    }
}

/// The tab bar's room handed back below a composer while the drawer is out, so the
/// composer does not drop by the bar's height as the drawer opens (`ChatView` draws the
/// same band). Apply as the OUTERMOST bottom inset of the content, outside the
/// composer's own: SwiftUI carries the outermost inset's background through the home
/// indicator. Zero height while the bar is present.
struct LeadingDrawerTabBarBand: View {
    let model: LeadingDrawerModel

    var body: some View {
        if model.tabBarCompensation > 0 {
            Rectangle()
                .fill(ComposerCard.backdrop)
                .frame(height: model.tabBarCompensation)
        }
    }
}
