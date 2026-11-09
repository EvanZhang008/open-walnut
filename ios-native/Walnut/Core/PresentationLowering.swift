import UIKit

/// A navigation the user asked for from outside the screen (a tapped thread push, a lock-screen
/// work card link) goes to a page UNDER whatever is presented over the app: a session's Info or
/// Controls sheet, a task's details on the Tasks tab, the Tasks draft, an alert. Left up, that
/// sheet hides the page the tap opened (2026-11-08 review: "Session Controls is still up over the
/// pushed thread"). This is the ONE entry that lowers them all first.
///
/// It works on the presentation chain of the app's own window, not on each view's state: every
/// SwiftUI `.sheet`, `.fullScreenCover`, `.popover`, `.alert` and `.confirmationDialog` is
/// presented on that chain, so one dismiss of the window's root closes every one of them, on any
/// tab, a sheet over a sheet included, and SwiftUI clears each owner's binding as the sheet goes
/// (its `onDismiss` runs too). No owner has to be wired to it; `PresentationLoweringGuardTests`
/// fails on a presentation that would not be on that chain (another window, a UIKit `present`
/// from elsewhere) and on a new sheet that refuses to be closed, until it is listed with why.
///
/// A sheet that refuses a swipe down (`holdsNavigation`: unsaved words being saved, a decision
/// owed, a fork running) is never closed for a navigation, and neither is anything under it: the
/// navigation WAITS until he saves or closes it (`OrgNodeLink` holds the push, the sheet says so),
/// because going ahead underneath would tear down the view that hosts the sheet, his words with it
/// (2026-11-08 review, round 2). The Talk panel has a window of its own above the app and is left
/// alone.
@MainActor
enum PresentationLowering {
    enum Presenting: Equatable {
        /// Nothing over the app.
        case show
        /// Something over the app that may be closed.
        case closeFirst
        /// A sheet on its way out already.
        case wait
        /// A sheet that holds his unsaved work or a decision he owes.
        case keep
    }

    /// `modal`: for each screen presented over the app, bottom first, whether it refuses to be
    /// swiped away (`isModalInPresentation`, SwiftUI's `interactiveDismissDisabled`).
    /// `closing`: a presented screen is on its way out.
    nonisolated static func plan(over modal: [Bool], closing: Bool = false) -> Presenting {
        if modal.contains(true) { return .keep }
        if closing { return .wait }
        return modal.isEmpty ? .show : .closeFirst
    }

    /// The app's own window: the scene's normal-level window. Not the key window, which is the
    /// Talk panel's while that panel is up.
    static func appWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let front = scenes.filter { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive }
        for scene in front + scenes {
            if let window = scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden && $0.rootViewController != nil }) {
                return window
            }
        }
        return nil
    }

    static func root() -> UIViewController? { appWindow()?.rootViewController }

    /// What is presented over `root`, bottom first, skipping what is already on its way out.
    static func chain(from root: UIViewController?) -> [Bool] {
        var out: [Bool] = []
        var top = root
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            out.append(presented.isModalInPresentation)
            top = presented
        }
        return out
    }

    /// Something is up over the app's window now (and not on its way out).
    static var somethingPresented: Bool { !chain(from: root()).isEmpty }

    /// What a navigation would meet now: `.keep` while a sheet holds his work.
    static func current() -> Presenting {
        let root = root()
        return plan(over: chain(from: root), closing: root?.presentedViewController?.isBeingDismissed == true)
    }

    /// Close everything presented over the app's window for a navigation, and the keyboard, unless
    /// one of them holds unsaved work: then nothing is touched (his keyboard stays where he types)
    /// and the caller waits. Returns what it found.
    @discardableResult
    static func lowerForNavigation(_ reason: String) -> Presenting {
        let root = root()
        let plan = current()
        if plan != .keep {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        if plan == .closeFirst { root?.dismiss(animated: true) }
        AppLog.info("nav", "presentations lowered for a navigation", ["reason": reason, "plan": "\(plan)"])
        return plan
    }
}
