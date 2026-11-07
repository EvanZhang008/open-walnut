import ActivityKit
import Foundation
import Observation

/// What the app does with the lock-screen work card on each read of the server's numbers.
/// Pure: unit-pinned in `WorkCardPlanTests`.
enum WorkCardPlan {
    enum Action: Equatable {
        case none
        /// Start a card with these numbers.
        case start
        /// Redraw the card with newer numbers.
        case update
        /// End the card: nothing works any more, or the user turned the card off.
        case end
    }

    struct Current: Equatable {
        var stretch: String?
        var state: WorkCardAttributes.ContentState
    }

    /// iOS ends a Live Activity on its own after this long; such a card was not removed by the user.
    static let systemLimit: TimeInterval = 8 * 3600

    /// - enabled: the user's switch (Settings, Lock Screen); `allowed`: iOS lets Walnut show
    ///   Live Activities. `dismissedStretch`: the stretch whose card the user swiped away.
    static func decide(
        enabled: Bool, allowed: Bool, view: WalnutAPI.WorkCardView,
        current: Current?, dismissedStretch: String?
    ) -> Action {
        guard enabled, allowed else { return current == nil ? .none : .end }
        guard view.active else { return current == nil ? .none : .end }
        guard let current else {
            // The minutes after the last task stopped keep a card, never start one.
            if view.state.working == 0 { return .none }
            // A card the user removed stays removed until the next stretch of work.
            if let dismissedStretch, dismissedStretch == view.stretch { return .none }
            return .start
        }
        // An older read never overwrites a newer push.
        if view.state.updatedAt < current.state.updatedAt { return .none }
        return current.state.sameFace(as: view.state) && current.stretch == view.stretch ? .none : .update
    }

    /// The card this app started is gone from the lock screen though the server never ended
    /// it, its stretch still runs, and iOS's own time limit is not what ended it: the user
    /// swiped it away. iOS also takes the card away when Walnut is updated or reinstalled, or
    /// the phone restarts, and that is no swipe: `startedIn` is the install and boot that
    /// started the card, `runningIn` this one (`WorkCardController.runningIn`). One not known
    /// (an older build did not note it, or it could not be read) is not taken as a swipe either.
    static func wasDismissed(
        memoStretch: String?, startedAt: Date?, stillOnScreen: Bool,
        view: WalnutAPI.WorkCardView, now: Date, allowed: Bool = true,
        startedIn: String?, runningIn: String?
    ) -> Bool {
        guard let memoStretch, !stillOnScreen, view.active, view.stretch == memoStretch else { return false }
        guard let startedIn, startedIn == runningIn else { return false }
        return removedByUser(startedAt: startedAt, now: now, allowed: allowed)
    }

    /// A card gone from the lock screen before iOS's own limit was removed by the user. One
    /// whose start this install does not know (it lost track of it) is not taken as removed:
    /// starting a card again is the smaller mistake.
    /// `allowed`: Live Activities are on for Walnut. Turning them off in iOS Settings removes
    /// every card too, and that is no swipe: the card comes back when they are on again.
    static func removedByUser(startedAt: Date?, now: Date, allowed: Bool = true) -> Bool {
        guard allowed, let startedAt else { return false }
        return now.timeIntervalSince(startedAt) < systemLimit
    }

    /// Whether the server can keep the card current while Walnut is closed.
    enum Background: Equatable {
        case unknown
        case ready
        /// The server holds no APNs key: the card shows what the app last read.
        case noKey
        /// The server keeps the card's token on the phone's notification row, which a phone
        /// with notifications off for Walnut does not have.
        case notificationsOff
    }

    /// The Settings footer under the Work card switch. `notificationsDenied`: iOS says so now,
    /// whatever the server last answered. `notificationsUndecided`: Walnut has not asked yet, so
    /// the phone has no notification row for the card's token to ride.
    static func footer(enabled: Bool, allowed: Bool, background: Background, notificationsDenied: Bool = false, notificationsUndecided: Bool = false) -> String {
        if enabled, !allowed {
            return "Live Activities are off for Walnut in iOS Settings, so the card cannot show."
        }
        let about = "While tasks work, the lock screen and the Dynamic Island show how many are working, need you and have completed. Silent: no sound, no vibration. It starts when you open Walnut and ends 15 minutes after work stops."
        guard enabled else { return about }
        let closed = " so while Walnut is closed the card does not change: it ends when you leave Walnut with nothing working, else it marks its numbers as old after 15 minutes."
        if notificationsDenied || background == .notificationsOff {
            return about + "\n\nNotifications are off for Walnut," + closed
        }
        if background == .noKey {
            return about + "\n\nYour Walnut server cannot send to Apple yet (it has no APNs key)," + closed
        }
        if notificationsUndecided {
            return about + "\n\nNotifications are not turned on for Walnut yet," + closed
        }
        return about
    }

    /// What happens to the card when Walnut leaves the front.
    enum Leaving: Equatable {
        /// The server keeps it current from here.
        case keep
        /// Nothing will change it until Walnut is open again: it says how old its numbers are
        /// after `staleSoon` instead of passing them off as now.
        case staleSoon
        /// Nothing works and nothing will end it: it ends now and stays `dismissAfter`, as the
        /// server would have ended it.
        case end
    }

    /// `background`: what the server last said it can do while the app is closed.
    static func leaving(background: Background, working: Int?) -> Leaving {
        guard background == .noKey || background == .notificationsOff else { return .keep }
        return working == 0 ? .end : .staleSoon
    }

    /// Whether Settings offers the way to iOS Settings: something there keeps the card from working.
    static func needsIOSSettings(enabled: Bool, allowed: Bool, notificationsDenied: Bool) -> Bool {
        enabled && (!allowed || notificationsDenied)
    }
}

/// Starts, updates and ends the lock-screen work card (`WorkCardAttributes`, drawn by the
/// widget extension), and hands the server the card's push token so it can keep the card
/// current while the phone is locked (src/core/push/work-card.ts).
///
/// iOS lets an app start a Live Activity only while it is in front, so a card starts the next
/// time Walnut is opened while something works. While the app is open it reads the numbers
/// itself every `refreshInterval`; while it is not, the server's silent pushes do. Every push
/// the card gets is a content update, never an alert: it does not ring, vibrate or light the
/// screen.
@Observable
@MainActor
final class WorkCardController {
    static let shared = WorkCardController()

    nonisolated static let enabledKey = "workCard.enabled"
    private nonisolated static let idKey = "workCard.activityId"
    private nonisolated static let startedKey = "workCard.startedAt"
    /// The install and boot that started the card: an update, a reinstall or a restart in
    /// between ends it, which is no swipe.
    private nonisolated static let startedInKey = "workCard.startedIn"
    private nonisolated static let stretchKey = "workCard.stretch"
    private nonisolated static let dismissedKey = "workCard.dismissedStretch"
    private nonisolated static let uploadedKey = "workCard.uploaded"
    /// Cards that ended here whose "ended" has not reached the server yet: sent again on each read.
    private nonisolated static let owedClearsKey = "workCard.owedClears"
    /// While the app is open: how often the card's numbers are read again.
    nonisolated static let refreshInterval: TimeInterval = 20
    /// A card that heard nothing for this long draws itself as out of date.
    nonisolated static let staleAfter: TimeInterval = 45 * 60
    /// With no pushes to keep it current: how long after Walnut leaves the front a card still
    /// passes its numbers off as now.
    nonisolated static let staleSoon: TimeInterval = 15 * 60
    /// An ended card stays on the lock screen this long with its last numbers.
    nonisolated static let dismissAfter: TimeInterval = 15 * 60
    /// This install and this boot of the phone: the app's folder (iOS gives every install and
    /// update a new one) and the boot session id. Nil when the boot cannot be read.
    nonisolated static let runningIn: String? = {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &buf, &size, nil, 0) == 0 else { return nil }
        return "\(Bundle.main.bundlePath)|\(String(cString: buf))"
    }()

    /// The last numbers read, for the lists a card link opens.
    private(set) var lastView: WalnutAPI.WorkCardView?
    private(set) var lastError: String?
    /// iOS lets Walnut show Live Activities (Settings, Walnut, Live Activities), kept current.
    private(set) var allowed = ActivityAuthorizationInfo().areActivitiesEnabled
    private(set) var background: WorkCardPlan.Background = .unknown
    private var enablementWatch: Task<Void, Never>?

    private let api = WalnutAPI()
    private var ticker: Task<Void, Never>?
    private var tokenWatch: Task<Void, Never>?
    private var stateWatch: Task<Void, Never>?
    private var watchedId: String?
    private var running = false
    /// A read asked for while one ran (the switch, a task finished): run once more after it.
    private var again = false
    private var defaults: UserDefaults { AppPrefs.defaults }

    /// The user's switch (Settings, Lock Screen). On by default.
    var enabled: Bool {
        get { defaults.object(forKey: Self.enabledKey) as? Bool ?? true }
        set {
            defaults.set(newValue, forKey: Self.enabledKey)
            Task { newValue ? await refresh() : await endNow() }
        }
    }

    // MARK: - Lifecycle

    /// The app came to the front: read now, then every `refreshInterval` while it stays.
    func appBecameActive() {
        // The card's token is sent again once per return to the front: the server may have
        // dropped it (a re-pairing, a restored config) while this phone thought it was there.
        defaults.removeObject(forKey: Self.uploadedKey)
        watchedId = nil
        allowed = ActivityAuthorizationInfo().areActivitiesEnabled
        if enablementWatch == nil {
            enablementWatch = Task { [weak self] in
                for await on in ActivityAuthorizationInfo().activityEnablementUpdates {
                    self?.allowed = on
                    await self?.refresh()
                }
            }
        }
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: UInt64(Self.refreshInterval * 1_000_000_000))
            }
        }
    }

    /// The app left the front: the server keeps the card current from here, or, when it cannot,
    /// the card is left in a state that stays true while nothing can change it.
    func appWentBackground() {
        ticker?.cancel()
        ticker = nil
        guard let card = live else { return }
        let leaving = WorkCardPlan.leaving(background: background, working: lastView?.state.working)
        guard leaving != .keep else { return }
        // The app is on its way to being suspended: ask for the moment the redraw (and the end's
        // word to the server) needs, or iOS may freeze them half done.
        let assertion = BackgroundAssertion.begin("workcard.leaving")
        let state = lastView?.state
        Task {
            switch leaving {
            case .keep:
                break
            case .staleSoon:
                await card.update(ActivityContent(state: card.content.state, staleDate: Date().addingTimeInterval(Self.staleSoon)))
            case .end:
                if let state { await self.end(card, with: state) }
            }
            BackgroundAssertion.end(assertion)
        }
    }

    // MARK: - One read

    private var live: Activity<WorkCardAttributes>? {
        Activity<WorkCardAttributes>.activities.first { $0.activityState == .active || $0.activityState == .stale }
    }

    /// Reads the numbers and starts, redraws or ends the card. The read runs in a task of its
    /// own: a caller that goes away (the launch's second `appBecameActive` replacing the ticker,
    /// a closed sheet) must not cancel a read half done, nor the read queued behind it. A
    /// cancelled read starts no card, and the next try was a whole `refreshInterval` later.
    func refresh() async {
        await Task { await self.refreshNow() }.value
    }

    private func refreshNow() async {
        guard AppConfig.isConfigured else {
            // Unpaired: no card may keep showing the old pairing's numbers and titles.
            await endAll()
            return
        }
        if running { again = true; return }
        running = true
        await readOnce()
        while again {
            again = false
            await readOnce()
        }
        running = false
    }

    private func readOnce() async {
        let view: WalnutAPI.WorkCardView
        do {
            view = try await api.workCard()
            lastView = view
            lastError = nil
        } catch {
            // An older server has no such route (404), a companion may be offline: the card,
            // if any, keeps what it shows and goes stale on its own.
            lastError = error.localizedDescription
            return
        }
        if let pushes = view.pushes {
            if !pushes { background = .noKey } else if background == .noKey || background == .unknown { background = .ready }
        }
        for id in defaults.stringArray(forKey: Self.owedClearsKey) ?? [] {
            Task { await sendToken(activityId: id, token: nil) }
        }
        let card = live
        noticeGoneCard(live: card, view: view)
        endExtras(keeping: card)

        let action = WorkCardPlan.decide(
            enabled: enabled, allowed: allowed, view: view,
            current: card.map { WorkCardPlan.Current(stretch: defaults.string(forKey: Self.stretchKey), state: $0.content.state) },
            dismissedStretch: defaults.string(forKey: Self.dismissedKey)
        )
        switch action {
        case .none:
            if let card { watch(card) }
        case .start:
            start(view)
        case .update:
            guard let card else { return }
            defaults.set(view.stretch, forKey: Self.stretchKey)
            await card.update(ActivityContent(state: view.state, staleDate: Date().addingTimeInterval(Self.staleAfter)))
            watch(card)
        case .end:
            if let card { await end(card, with: view.state) }
        }
    }

    /// The card this app started is no longer live (the server ended it, iOS did, or the user
    /// swiped it away while the app was not running): its token leaves the server, and a card
    /// the user removed is not started again in the same stretch.
    private func noticeGoneCard(live card: Activity<WorkCardAttributes>?, view: WalnutAPI.WorkCardView) {
        guard let memoId = defaults.string(forKey: Self.idKey), memoId != card?.id else { return }
        let onScreen = Activity<WorkCardAttributes>.activities.contains { $0.id == memoId && $0.activityState != .dismissed }
        let started = defaults.object(forKey: Self.startedKey) as? Date
        if WorkCardPlan.wasDismissed(
            memoStretch: defaults.string(forKey: Self.stretchKey), startedAt: started, stillOnScreen: onScreen,
            view: view, now: Date(), allowed: allowed,
            startedIn: defaults.string(forKey: Self.startedInKey), runningIn: Self.runningIn
        ) {
            defaults.set(defaults.string(forKey: Self.stretchKey), forKey: Self.dismissedKey)
            AppLog.info("workcard", "the card was removed by the user; it stays off until the next stretch", [:])
        }
        Task { await sendToken(activityId: memoId, token: nil) }
        forgetCard()
    }

    private func start(_ view: WalnutAPI.WorkCardView) {
        // A card the server ended a moment ago lingers with its last numbers: the new one replaces it.
        for old in Activity<WorkCardAttributes>.activities where old.activityState == .ended {
            Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
        do {
            let card = try Activity.request(
                attributes: WorkCardAttributes(),
                content: ActivityContent(state: view.state, staleDate: Date().addingTimeInterval(Self.staleAfter), relevanceScore: 50),
                pushType: .token
            )
            defaults.set(card.id, forKey: Self.idKey)
            defaults.set(Date(), forKey: Self.startedKey)
            defaults.set(Self.runningIn, forKey: Self.startedInKey)
            defaults.set(view.stretch, forKey: Self.stretchKey)
            AppLog.info("workcard", "card started", ["working": String(view.state.working), "needs": String(view.state.needs)])
            watch(card)
        } catch {
            lastError = error.localizedDescription
            AppLog.warn("workcard", "card could not start", ["error": error.localizedDescription])
        }
    }

    /// Nothing works any more: the card stays a while with its last numbers. `now`: the user
    /// asked for it to go (the switch off, a disconnect), so it leaves at once.
    private func end(_ card: Activity<WorkCardAttributes>, with state: WorkCardAttributes.ContentState, now: Bool = false) async {
        forgetCard()
        let policy: ActivityUIDismissalPolicy = now ? .immediate : .after(Date().addingTimeInterval(Self.dismissAfter))
        // Its last face reads "Finished", not as work still running.
        var last = state
        last.endedAt = last.endedAt ?? Date().timeIntervalSince1970
        await card.end(ActivityContent(state: last, staleDate: nil), dismissalPolicy: policy)
        AppLog.info("workcard", "card ended", ["completed": String(state.completed)])
        await sendToken(activityId: card.id, token: nil)
    }

    /// The switch went off: end the card now, without waiting for the server, and with it a
    /// card that ended a moment ago and still lingers with its last numbers.
    private func endNow() async {
        if let card = live { await end(card, with: lastView?.state ?? card.content.state, now: true) }
        for card in Activity<WorkCardAttributes>.activities where card.activityState != .dismissed {
            await card.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// No pairing: every card goes at once. The server holds no token of it any more (a revoke
    /// takes the device's rows), so the phone ends it itself.
    private func endAll() async {
        forgetCard()
        for card in Activity<WorkCardAttributes>.activities where card.activityState != .dismissed {
            await card.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// Disconnect (LocalDataReset): the card and everything this install knew about it go.
    func forgetServer() {
        lastView = nil
        lastError = nil
        defaults.removeObject(forKey: Self.dismissedKey)
        Task { await endAll() }
    }

    /// Only one card at a time: an older one left by a crash or a second start goes.
    private func endExtras(keeping card: Activity<WorkCardAttributes>?) {
        for other in Activity<WorkCardAttributes>.activities
        where other.id != card?.id && (other.activityState == .active || other.activityState == .stale) {
            Task { await other.end(nil, dismissalPolicy: .immediate) }
        }
    }

    private func forgetCard() {
        for key in [Self.idKey, Self.startedKey, Self.startedInKey, Self.stretchKey, Self.uploadedKey] { defaults.removeObject(forKey: key) }
        tokenWatch?.cancel()
        stateWatch?.cancel()
        tokenWatch = nil
        stateWatch = nil
        watchedId = nil
    }

    // MARK: - The card's push token

    /// Hand the server every token iOS mints for the card (it can rotate), once each, and
    /// notice the user removing the card while the app runs.
    private func watch(_ card: Activity<WorkCardAttributes>) {
        if watchedId == card.id { return }
        watchedId = card.id
        // A live card this install lost track of (its memo was cleared) is the card from now on.
        if defaults.string(forKey: Self.idKey) != card.id {
            defaults.set(card.id, forKey: Self.idKey)
            defaults.removeObject(forKey: Self.startedKey)
            defaults.removeObject(forKey: Self.startedInKey)
        }
        tokenWatch?.cancel()
        stateWatch?.cancel()
        tokenWatch = Task { [weak self] in
            for await data in card.pushTokenUpdates {
                await self?.sendToken(activityId: card.id, token: PushRegistration.hexString(from: data))
            }
        }
        stateWatch = Task { [weak self] in
            for await state in card.activityStateUpdates where state == .dismissed {
                self?.userRemoved(card)
            }
        }
        // A token minted before this watch began (the app was relaunched) is still owed.
        if let data = card.pushToken {
            Task { await sendToken(activityId: card.id, token: PushRegistration.hexString(from: data)) }
        }
    }

    private func userRemoved(_ card: Activity<WorkCardAttributes>) {
        guard defaults.string(forKey: Self.idKey) == card.id else { return }
        let started = defaults.object(forKey: Self.startedKey) as? Date
        if WorkCardPlan.removedByUser(startedAt: started, now: Date(), allowed: allowed), let stretch = defaults.string(forKey: Self.stretchKey) {
            defaults.set(stretch, forKey: Self.dismissedKey)
        }
        forgetCard()
        Task { await sendToken(activityId: card.id, token: nil) }
    }

    private func sendToken(activityId: String, token: String?) async {
        let memo = "\(activityId)|\(token ?? "-")"
        if token != nil, defaults.string(forKey: Self.uploadedKey) == memo { return }
        do {
            try await api.registerWorkCard(activityId: activityId, token: token)
            if token != nil, defaults.string(forKey: Self.idKey) == activityId { defaults.set(memo, forKey: Self.uploadedKey) }
            if token != nil, background == .notificationsOff { background = .ready }
            if token == nil { owedClear(activityId, owed: false) }
        } catch {
            // The server keeps the card's token on this phone's notification row; with
            // notifications off for Walnut there is none, and the card changes only while Walnut is open.
            let noRow: Bool
            if case let APIError.server(_, code, _, _, _) = error { noRow = code == "device_not_registered" } else { noRow = false }
            if token == nil {
                // Nothing to clear on a server that holds no row for this phone.
                owedClear(activityId, owed: !noRow)
            } else if noRow {
                background = .notificationsOff
            }
            // Kept unsent: the next read watches the card again and sends its current token.
            lastError = error.localizedDescription
            AppLog.warn("workcard", "card token not stored", ["error": error.localizedDescription, "ending": token == nil ? "yes" : "no"])
            if watchedId == activityId { watchedId = nil }
        }
    }

    /// Remember (or forget) an "ended" the server has not heard yet. A handful at most: older
    /// cards are long gone from the server's rows by then (it keeps no card past eight hours).
    private func owedClear(_ activityId: String, owed: Bool) {
        var ids = (defaults.stringArray(forKey: Self.owedClearsKey) ?? []).filter { $0 != activityId }
        if owed { ids.append(activityId) }
        defaults.set(Array(ids.suffix(5)), forKey: Self.owedClearsKey)
    }
}
