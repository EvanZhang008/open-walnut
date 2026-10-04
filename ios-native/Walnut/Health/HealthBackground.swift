import BackgroundTasks
import Foundation
import HealthKit
import UIKit

/// The on switch and the shared engine.
enum HealthSync {
    /// The user turned Apple Health on in Settings. Erased with every other
    /// preference by Disconnect.
    static let enabledKey = "walnut.health.enabled"

    static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }

    /// The one engine every trigger feeds (foreground, HealthKit background
    /// delivery, the app refresh task, Sync Now).
    static let engine = HealthSyncEngine(
        source: HealthKitDataSource.shared,
        transport: WalnutHealthTransport(),
        state: .shared,
        environment: HealthSyncEnvironment(
            isEnabled: { HealthSync.isEnabled },
            isPaired: { AppConfig.serverURL != nil && !(AppConfig.token ?? "").isEmpty },
            isDemo: { DemoMode.isActive },
            now: { Date() },
            timeZone: { TimeZone.current },
            deviceModel: DeviceIdentity.model,
            deviceOS: "iOS \(ProcessInfo.processInfo.operatingSystemVersion.majorVersion).\(ProcessInfo.processInfo.operatingSystemVersion.minorVersion)"
        ),
        onProgress: { progress in
            // A background launch that never became active hydrates no UI
            // state (see LaunchGate); the screen reads the saved state when it opens.
            Task { @MainActor in
                guard LaunchGate.shared.hasActivated else { return }
                HealthSyncStore.shared.apply(progress)
            }
        }
    )

    /// Disconnect (LocalDataReset) and "Delete Health Data on Mac": stop every
    /// trigger and forget every anchor. The preference itself is cleared by the
    /// caller (Disconnect removes all of them).
    @MainActor
    static func eraseLocalState() {
        HealthBackground.shared.stopObserving()
        HealthSyncStateStore.shared.eraseAll()
        HealthSyncStore.shared.eraseLocalState()
    }
}

/// When the sync runs. Installed at launch from the app delegate, NOT gated on
/// LaunchGate: like telemetry, a HealthKit background delivery wakes the app in
/// the background and must be answered there. The engine touches no SwiftUI or
/// main-actor state, so it is safe in a launch that never becomes active.
///
/// Triggers:
///  - one HKObserverQuery over every enabled sample type (the iOS 15+ form that
///    says which types changed) plus background delivery per type, immediate
///    for sleep, workouts and state of mind, hourly otherwise. Its handler
///    takes a background task, runs the engine for about 20 s and ALWAYS calls
///    HealthKit's completion handler (HealthKit stops delivering after 3 misses);
///  - a BGAppRefreshTask, earliest 1 h out, rescheduled on every run, 25 s;
///  - every activation, and `protectedDataDidBecomeAvailable` (the first unlock
///    after the phone woke the app while locked).
@MainActor
final class HealthBackground {
    static let shared = HealthBackground()
    static let refreshTaskIdentifier = "dev.openwalnut.ios.health-refresh"
    static let observerBudget: TimeInterval = 20
    static let refreshBudget: TimeInterval = 25
    static let foregroundBudget: TimeInterval = 60

    private var started = false
    private var refreshRegistered = false
    private var observer: HKObserverQuery?
    private var foregroundTask: Task<Void, Never>?

    /// A hosted unit test runs inside the app: it must never start real syncs.
    static let isHostedUnitTestProcess = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

    /// Health is on, paired with a real server, and HealthKit exists.
    static var shouldSync: Bool {
        HealthSync.isEnabled && !DemoMode.isActive && AppConfig.serverURL != nil
            && HKHealthStore.isHealthDataAvailable()
    }

    /// From `application(_:didFinishLaunchingWithOptions:)`.
    func start() {
        guard !started, !Self.isHostedUnitTestProcess else { return }
        started = true
        registerRefreshTask()
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { HealthBackground.shared.runInForeground(reason: "active") }
        }
        center.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil,
                           queue: .main) { _ in
            MainActor.assumeIsolated { HealthBackground.shared.runAfterUnlock() }
        }
        if Self.shouldSync {
            startObserving()
            scheduleRefresh()
        }
        #if DEBUG
        HealthDebugSeed.runIfRequested()
        #endif
    }

    /// Health was just turned on.
    func enable() {
        guard Self.shouldSync else { return }
        startObserving()
        scheduleRefresh()
        runInForeground(reason: "turned-on")
    }

    // MARK: - HealthKit background delivery

    private func startObserving() {
        guard observer == nil else { return }
        let store = HealthKitDataSource.shared.store
        let specs = HealthTypeCatalog.all
        let descriptors = specs.compactMap { spec in
            spec.sampleType.map { HKQueryDescriptor(sampleType: $0, predicate: nil) }
        }
        guard !descriptors.isEmpty else { return }
        let nameByIdentifier = Dictionary(
            specs.compactMap { spec in spec.sampleType.map { ($0.identifier, spec.name) } },
            uniquingKeysWith: { first, _ in first }
        )
        let query = HKObserverQuery(queryDescriptors: descriptors) { _, changed, completion, error in
            let names = Set((changed ?? []).compactMap { nameByIdentifier[$0.identifier] })
            let failed = error != nil
            Task { @MainActor in
                guard !failed, HealthBackground.shouldSync else {
                    completion()
                    return
                }
                HealthBackground.shared.runInBackground(
                    reason: "observer", budget: Self.observerBudget, only: names.isEmpty ? nil : names
                ) { _ in completion() }
            }
        }
        observer = query
        store.execute(query)
        for spec in specs {
            guard let type = spec.sampleType else { continue }
            store.enableBackgroundDelivery(for: type, frequency: spec.immediateDelivery ? .immediate : .hourly) { _, _ in }
        }
        AppLog.info("health", "background delivery on", ["types": String(descriptors.count)])
    }

    /// Off, Disconnect or delete: no more wake-ups.
    func stopObserving() {
        if let observer {
            HealthKitDataSource.shared.store.stop(observer)
        }
        observer = nil
        foregroundTask?.cancel()
        foregroundTask = nil
        guard !Self.isHostedUnitTestProcess else { return }
        if HKHealthStore.isHealthDataAvailable() {
            HealthKitDataSource.shared.store.disableAllBackgroundDelivery { _, _ in }
        }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskIdentifier)
    }

    // MARK: - App refresh

    private func registerRefreshTask() {
        guard !refreshRegistered else { return }
        refreshRegistered = true
        // Must be registered before launching finishes, on every launch.
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskIdentifier, using: nil) { task in
            Task { @MainActor in HealthBackground.shared.handleRefresh(task) }
        }
    }

    private func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskIdentifier)
        request.earliestBeginDate = Date().addingTimeInterval(3600)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            // The simulator, Background App Refresh off, or Low Power Mode.
            AppLog.debug("health", "app refresh not scheduled", ["error": String(describing: type(of: error))])
        }
    }

    private func handleRefresh(_ task: BGTask) {
        guard Self.shouldSync else {
            task.setTaskCompleted(success: true)
            return
        }
        scheduleRefresh()
        let work = Task {
            let outcome = await HealthSync.engine.run(reason: "refresh", budget: Self.refreshBudget)
            task.setTaskCompleted(success: outcome != .failed && outcome != .cancelled)
        }
        task.expirationHandler = { work.cancel() }
    }

    // MARK: - Runs

    /// A run under a UIApplication background task. `completion` always runs,
    /// exactly once: when the run ends, or when iOS takes the time back first.
    func runInBackground(
        reason: String, budget: TimeInterval, only: Set<String>?,
        completion: @escaping @MainActor (HealthRunOutcome) -> Void
    ) {
        let token = BackgroundRun(completion: completion)
        token.taskID = UIApplication.shared.beginBackgroundTask(withName: "health-sync") {
            MainActor.assumeIsolated {
                token.work?.cancel()
                token.finish(.cancelled)
            }
        }
        token.work = Task { @MainActor in
            let outcome = await HealthSync.engine.run(reason: reason, budget: budget, only: only)
            token.finish(outcome)
        }
    }

    /// While the app is open: keep going past one budget until the history is
    /// in, as long as the app stays active.
    func runInForeground(reason: String) {
        guard Self.shouldSync, foregroundTask == nil else { return }
        foregroundTask = Task { @MainActor in
            defer { HealthBackground.shared.foregroundTask = nil }
            for round in 0..<30 {
                let outcome = await withCheckedContinuation { (done: CheckedContinuation<HealthRunOutcome, Never>) in
                    HealthBackground.shared.runInBackground(
                        reason: round == 0 ? reason : "\(reason)+more", budget: Self.foregroundBudget, only: nil
                    ) { done.resume(returning: $0) }
                }
                guard outcome == .budget, UIApplication.shared.applicationState == .active,
                      !Task.isCancelled else { break }
            }
        }
    }

    private func runAfterUnlock() {
        guard Self.shouldSync else { return }
        if UIApplication.shared.applicationState == .active {
            runInForeground(reason: "unlocked")
        } else {
            runInBackground(reason: "unlocked", budget: Self.observerBudget, only: nil) { _ in }
        }
    }

    /// Sync Now. A run already going (any trigger) picks the request up.
    func syncNow() {
        runInForeground(reason: "sync-now")
    }
}

/// One background-task run: ends the UIKit task and calls the completion once.
@MainActor
private final class BackgroundRun {
    var taskID: UIBackgroundTaskIdentifier = .invalid
    var work: Task<Void, Never>?
    private var completion: (@MainActor (HealthRunOutcome) -> Void)?

    init(completion: @escaping @MainActor (HealthRunOutcome) -> Void) {
        self.completion = completion
    }

    func finish(_ outcome: HealthRunOutcome) {
        if let completion {
            self.completion = nil
            completion(outcome)
        }
        if taskID != .invalid {
            UIApplication.shared.endBackgroundTask(taskID)
            taskID = .invalid
        }
    }
}
