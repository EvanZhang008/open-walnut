import SwiftUI
import UIKit

/// One composer pill's menu, as plain values: what `PillMenuUIButton` builds its
/// `UIMenu` from. Values rather than closures, so "did the menu change?" is `==`
/// and a menu that did not change is never reassigned.
struct PillMenu: Equatable {
    /// What a tap on a row asks the model to do.
    enum Choice: Equatable {
        case model(String)
        case effort(String)
        case retry
        /// An informational row (read-only reason, a current model the catalog
        /// does not list). Rendered disabled; a tap cannot reach it.
        case none
    }

    struct Item: Equatable {
        var title: String
        var choice: Choice
        var checked = false
        var enabled = true
        var systemImage: String?
        var accessibilityID: String?
    }

    struct Section: Equatable {
        var title: String
        var items: [Item]
    }

    var sections: [Section]
    /// The model state this menu was built from. A tap on a menu whose state was
    /// replaced since (an answer staged while it was open, applied as it closed)
    /// is dropped instead of being applied to rows the user never saw.
    var token: ComposerControlsModel.MenuToken
    /// A heading above every section (a just-failed write's reason), or "".
    var title = ""
}

/// A transparent UIKit button laid over a SwiftUI pill, owning the pill's menu.
///
/// Why UIKit and not SwiftUI's `Menu`: SwiftUI gives no open or close signal (a
/// menu content `onAppear` fires on the FIRST open only, measured), and it
/// rewrites the visible `UIMenu` whenever the model changes. An answer that
/// landed while the menu was open rebuilt the rows under the finger, and a tap
/// meant for one row picked another (a real write the user never chose). Here
/// the interaction's own delegate calls mark every open and close, and the model
/// holds every answer while a menu is open (`ComposerControlsModel.setMenuPresented`),
/// so the rows on screen are the rows the menu opened with.
///
/// The menu opens ABOVE the pill, never over it (`previewAbovePill`). With the
/// keyboard up, a tap first puts the keyboard away (`menuMayOpenNow`).
///
/// Enabled state is NOT set here: SwiftUI owns `UIControl.isEnabled` for a
/// representable and writes its environment's value back after every update
/// (measured: `Update.dispatchActions` re-enabled the button 12ms after
/// `updateUIView` disabled it, so a pill that looked disabled still opened its
/// menu). The caller disables it the SwiftUI way, with `.disabled(_:)`.
struct PillMenuButton: UIViewRepresentable {
    var menu: PillMenu
    var accessibilityID: String
    var accessibilityLabel: String
    /// Distinguishes the pills of one composer in the open/close reports.
    var menuID: String
    /// How far above its own top the menu must also stay clear: the height of
    /// the pills stacked above this one (see `PillMenuUIButton.menuClearance`).
    var menuClearance: CGFloat = 0
    var onSelect: (PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void
    var onPresentedChange: (String, Bool) -> Void
    var onHighlightChange: (Bool) -> Void

    func makeUIView(context: Context) -> PillMenuUIButton {
        let button = PillMenuUIButton(frame: .zero)
        configure(button)
        return button
    }

    func updateUIView(_ button: PillMenuUIButton, context: Context) {
        configure(button)
    }

    private func configure(_ button: PillMenuUIButton) {
        button.menuID = menuID
        button.menuClearance = menuClearance
        button.onSelect = onSelect
        button.onPresentedChange = onPresentedChange
        button.onHighlightChange = onHighlightChange
        button.accessibilityIdentifier = accessibilityID
        button.accessibilityLabel = accessibilityLabel
        button.show(menu)
    }

    /// A button torn down with its menu up never gets its close call, and a model
    /// left believing a menu is open would hold every answer forever.
    static func dismantleUIView(_ button: PillMenuUIButton, coordinator: ()) {
        button.forgetPresentation()
    }
}

final class PillMenuUIButton: UIButton {
    var menuID = ""
    var onSelect: ((PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void)?
    var onPresentedChange: ((String, Bool) -> Void)?
    var onHighlightChange: ((Bool) -> Void)?

    /// From the moment UIKit asks for the menu until its dismissal finishes: the
    /// rows MAY be on screen for this whole window, so it counts as open.
    private(set) var isPresenting = false
    private var displayConfirmed = false
    private var presentation = 0
    private var shown: PillMenu?
    /// How long a menu UIKit asked for may take to appear before it counts as
    /// never shown. Settable so a test need not wait the real two seconds.
    static var displayDeadline: TimeInterval = 2
    /// The space between the bottom of the menu and the top of the pill.
    static let menuGap: CGFloat = 6
    /// Extra space the menu keeps clear above the pill's top: the pills stacked
    /// ABOVE this one (the model pill over the effort pill at the accessibility
    /// sizes), so a tap on either pill with this menu up lands outside it too.
    var menuClearance: CGFloat = 0
    /// A tap on this pill is putting the keyboard away (see `menuMayOpenNow`):
    /// until the keyboard is down and the pill has settled, a tap opens nothing.
    private(set) var waitingForTheKeyboard = false
    private var keyboardWait = 0
    private var keyboardHideSeen = false
    private var keyboardObserver: NSObjectProtocol?
    /// No keyboard announced its hiding by then (nothing was on screen): done.
    static var noKeyboardWait: TimeInterval = 0.3
    /// Past the keyboard's own animation, for the layout that rides it.
    static let afterKeyboardMargin: TimeInterval = 0.1
    /// The text view a pill tap took the focus from, and when. Shared by the
    /// pills of the composer: the tap that put the keyboard away may be on the
    /// model pill and the menu then opened from the effort pill.
    /// Internal so a test can start from a clean slate.
    static weak var focusPutAway: UIResponder?
    static var focusPutAwayAt: Date?
    /// A menu opened this long after the keyboard went away gives the focus back
    /// when it closes; later than that, the user has moved on.
    static let focusReturnWindow: TimeInterval = 15
    static var now: () -> Date = Date.init
    /// This open took over a put-away focus, to give back when it closes.
    private var returnsFocus = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        showsMenuAsPrimaryAction = true
        // The rows' own order, top to bottom. By default iOS REVERSES a menu that
        // opens upward (this one sits at the bottom of the screen).
        preferredMenuElementOrder = .fixed
        backgroundColor = .clear
        isAccessibilityElement = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// VoiceOver (and XCUITest) must hear "dimmed" exactly when a tap does
    /// nothing. A stored trait value is not recomputed from `isEnabled`, so this
    /// derives it.
    override var accessibilityTraits: UIAccessibilityTraits {
        get {
            var traits = super.accessibilityTraits.union(.button)
            if isEnabled { traits.remove(.notEnabled) } else { traits.insert(.notEnabled) }
            return traits
        }
        set { super.accessibilityTraits = newValue }
    }

    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != oldValue else { return }
            onHighlightChange?(isHighlighted)
        }
    }

    /// Install a menu. Unchanged menus are never reassigned. A menu that changes
    /// while one is open can only come from a tap already delivered (the pick
    /// moving the checkmark): the model holds every answer until the close, so
    /// no button-level hold is needed here (gate r2 removed the untested one).
    func show(_ menu: PillMenu) {
        guard shown != menu else { return }
        self.menu = Self.build(menu) { [weak self] choice, token in
            self?.onSelect?(choice, token)
        }
        shown = menu
    }

    static func build(
        _ menu: PillMenu,
        onSelect: @escaping (PillMenu.Choice, ComposerControlsModel.MenuToken) -> Void
    ) -> UIMenu {
        let token = menu.token
        let sections: [UIMenuElement] = menu.sections.map { section in
            UIMenu(title: section.title, options: .displayInline, children: section.items.map { item in
                let action = UIAction(
                    title: item.title,
                    image: item.systemImage.flatMap { UIImage(systemName: $0) },
                    attributes: item.enabled ? [] : [.disabled],
                    state: item.checked ? .on : .off
                ) { _ in onSelect(item.choice, token) }
                action.accessibilityIdentifier = item.accessibilityID
                return action
            })
        }
        return UIMenu(title: menu.title, children: sections)
    }

    // MARK: - Where the menu opens: above the pill, never over it

    /// iOS 26 grows a button's menu out of the button itself, so the open menu
    /// COVERED the pill, and the rows at its bottom (the strongest model, "Max")
    /// sat exactly where the pill had been. A double tap, or a second tap meant to
    /// close the menu, landed on that row and wrote it (gate r2 D1: `model=default`
    /// 380ms after the open, `opus` on a tap 1.2s later, `effort=max`).
    ///
    /// UIKit grows the menu out of the highlight preview, so the preview is an
    /// invisible pill-sized shape just ABOVE the pill: the menu ends `menuGap`
    /// above the pill's top, and a second tap on the pill lands outside the menu,
    /// which only closes it. This holds for every menu the pills show (models,
    /// levels, Retry) and whatever the current row is, which is why it was chosen
    /// over pop-up semantics (`changesSelectionAsPrimaryAction`): measured on iOS
    /// 26, a pop-up button's menu did NOT put the selected row over the pill (the
    /// bottom row covered it for every current model tried), and a menu with no
    /// current row (an unknown effort, the Retry state) has nothing to align.
    ///
    /// A pill with others stacked above it (`menuClearance`) opens its menu above
    /// all of them, for the same reason.
    ///
    /// nil off screen: `UIPreviewTarget` raises for a container that is not in a
    /// window (UIKit only asks while presenting from one, so this is a guard).
    /// nil is also what the delegate overrides below hand UIKit then, which means
    /// "your default preview". They must NOT fall back to `super`: UIButton does
    /// not implement these two methods at runtime (measured on iOS 26, a
    /// `super` call raised `doesNotRecognizeSelector` and killed the app).
    func previewAbovePill() -> UITargetedPreview? {
        guard window != nil else { return nil }
        let size = CGSize(width: max(bounds.width, 1), height: max(bounds.height, 1))
        let shape = UIView(frame: CGRect(origin: .zero, size: size))
        shape.backgroundColor = .clear
        let parameters = UIPreviewParameters()
        parameters.backgroundColor = .clear
        parameters.visiblePath = UIBezierPath(roundedRect: shape.bounds, cornerRadius: size.height / 2)
        let center = CGPoint(x: bounds.midX, y: -(size.height / 2 + Self.menuGap + max(menuClearance, 0)))
        return UITargetedPreview(view: shape, parameters: parameters, target: UIPreviewTarget(container: self, center: center))
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configuration: UIContextMenuConfiguration,
        highlightPreviewForItemWithIdentifier identifier: any NSCopying
    ) -> UITargetedPreview? {
        previewAbovePill()
    }

    /// The menu folds back into the same place it grew from.
    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configuration: UIContextMenuConfiguration,
        dismissalPreviewForItemWithIdentifier identifier: any NSCopying
    ) -> UITargetedPreview? {
        previewAbovePill()
    }

    // MARK: - Presentation edges (UIControl is the interaction's delegate)

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        configurationForMenuAtLocation location: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard menuMayOpenNow() else { return nil }
        let configuration = super.contextMenuInteraction(interaction, configurationForMenuAtLocation: location)
        if configuration != nil { menuRequested() }
        return configuration
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willDisplayMenuFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        menuDisplayed()
    }

    override func contextMenuInteraction(
        _ interaction: UIContextMenuInteraction,
        willEndFor configuration: UIContextMenuConfiguration,
        animator: UIContextMenuInteractionAnimating?
    ) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        // The rows stay on screen through the dismissal animation, so the menu
        // counts as open until it has finished.
        if let animator {
            animator.addCompletion { [weak self] in self?.menuEnded() }
        } else {
            menuEnded()
        }
    }

    // MARK: - With the keyboard up: the first tap puts it away

    /// A tap that would open the menu: may it open NOW?
    ///
    /// Not while the keyboard is up. The model list is about 460pt tall, and a
    /// pill above the keyboard has about 420pt over it, so UIKit laid the menu
    /// over the pill (measured: rows down to y=520 with the pill at 488-522, and
    /// at 515 once the menu had taken the focus and the QuickType row had gone).
    /// A double tap, or a tap 3pt above the pill, wrote the row there (gate r3
    /// P1-1; P2-1 fired Retry the same way). No placement fixes that: a list that
    /// tall cannot fit above that pill, and UIKit moves a menu that does not fit
    /// over its source.
    ///
    /// So with the keyboard up, the tap puts the keyboard away and opens
    /// nothing: the pill settles at its keyboard-down place, and the next tap
    /// opens the menu there, the geometry every gesture already passes. Opening
    /// it automatically once the keyboard is down is not possible with a UIKit
    /// menu: measured on iOS 26, `performPrimaryAction()` asks for the menu and
    /// its preview, reports the button held, and never shows it (with or without
    /// the keyboard), and `accessibilityActivate()` returns false. A tap while
    /// the keyboard is still going away opens nothing either. When a menu opened
    /// soon after closes, picked or not, the focus goes back to the text view,
    /// so typing goes on.
    func menuMayOpenNow() -> Bool {
        if waitingForTheKeyboard { return false }
        guard let focus = window?.textFocus else { return true }
        putTheKeyboardAway(focus)
        return false
    }

    private func putTheKeyboardAway(_ focus: UIView) {
        waitingForTheKeyboard = true
        keyboardWait &+= 1
        let wait = keyboardWait
        keyboardHideSeen = false
        Self.focusPutAway = focus
        Self.focusPutAwayAt = Self.now()
        keyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main
        ) { [weak self] note in
            let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.35
            MainActor.assumeIsolated {
                self?.keyboardHideSeen = true
                self?.stopWaiting(wait, after: duration + Self.afterKeyboardMargin)
            }
        }
        AppLog.info("chat", "composer model: keyboard put away by a pill tap", ["menu": menuID])
        _ = focus.resignFirstResponder()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.noKeyboardWait) { [weak self] in
            guard let self, !self.keyboardHideSeen else { return }
            self.stopWaiting(wait, after: 0)
        }
    }

    private func stopWaiting(_ wait: Int, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.waitingForTheKeyboard, self.keyboardWait == wait else { return }
            self.endKeyboardWait()
        }
    }

    private func endKeyboardWait() {
        waitingForTheKeyboard = false
        if let keyboardObserver { NotificationCenter.default.removeObserver(keyboardObserver) }
        keyboardObserver = nil
    }

    /// A menu is opening: does it give a put-away focus back when it closes?
    private func takeOverPutAwayFocus() {
        guard Self.focusPutAway != nil, let at = Self.focusPutAwayAt else { return }
        if Self.now().timeIntervalSince(at) < Self.focusReturnWindow {
            returnsFocus = true
        } else {
            Self.focusPutAway = nil
            Self.focusPutAwayAt = nil
        }
    }

    /// The menu closed: the text view gets the focus back, unless it is gone or
    /// something else already has it.
    private func returnFocus() {
        guard returnsFocus else { return }
        returnsFocus = false
        let focus = Self.focusPutAway
        Self.focusPutAway = nil
        Self.focusPutAwayAt = nil
        guard let view = focus as? UIView, view.window != nil, view.window?.textFocus == nil else { return }
        AppLog.info("chat", "composer model: focus back after the menu", ["menu": menuID])
        _ = view.becomeFirstResponder()
    }

    // The three edges, internal so `PillMenuButtonTests` can drive them without
    // a UIKit menu on screen.

    /// UIKit asked for the menu: it may be on screen from now on.
    func menuRequested() {
        guard !isPresenting else { return }
        takeOverPutAwayFocus()
        isPresenting = true
        displayConfirmed = false
        presentation &+= 1
        let this = presentation
        onPresentedChange?(menuID, true)
        // A menu asked for but never displayed (the touch was cancelled first)
        // gets no end call either. Don't let that hold every answer forever.
        // Keyed to THIS presentation, so an earlier one's deadline never ends a
        // later menu.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.displayDeadline) { [weak self] in
            guard let self, self.presentation == this, self.isPresenting, !self.displayConfirmed else { return }
            self.menuEnded()
        }
    }

    /// The menu is on screen.
    func menuDisplayed() {
        menuRequested()
        displayConfirmed = true
    }

    /// The menu's dismissal has finished.
    func menuEnded() {
        guard isPresenting else { return }
        isPresenting = false
        onPresentedChange?(menuID, false)
        returnFocus()
    }

    /// The view is going away: report the menu closed without touching UIKit.
    func forgetPresentation() {
        if waitingForTheKeyboard { endKeyboardWait() }
        returnsFocus = false
        guard isPresenting else { return }
        isPresenting = false
        onPresentedChange?(menuID, false)
    }
}

private extension UIView {
    /// The text view holding the focus (and so the keyboard) in this subtree.
    var textFocus: UIView? {
        if isFirstResponder, self is UITextInput { return self }
        for subview in subviews {
            if let focus = subview.textFocus { return focus }
        }
        return nil
    }
}
