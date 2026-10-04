import Foundation
import HealthKit
import Observation
import UIKit

/// What the Apple Health screen shows, and its actions. The sync itself runs in
/// `HealthSyncEngine` (off the main thread); this store only reflects it.
@Observable
@MainActor
final class HealthSyncStore {
    static let shared = HealthSyncStore()

    enum Busy: Equatable {
        case turningOn, pausing, deleting
    }

    private(set) var isEnabled: Bool
    private(set) var progress = HealthSyncProgress()
    /// From GET /health/status; nil until it answered once.
    private(set) var macPaused: Bool?
    /// The first local date the Mac has data for.
    private(set) var macDataFrom: Date?
    /// The Mac holds samples, not only the characteristics (birth date, sex),
    /// which iOS may hand out while every sample type stays unreadable.
    private(set) var macHasSamples = false
    private(set) var macUnreachable = false
    private(set) var busy: Busy?
    private(set) var errorMessage: String?
    private(set) var backgroundRefreshOff = false
    private(set) var lowPowerMode = false

    private let transport: HealthSyncTransport

    init(transport: HealthSyncTransport = WalnutHealthTransport()) {
        self.transport = transport
        isEnabled = HealthSync.isEnabled
        loadSaved()
    }

    var isDemo: Bool { DemoMode.isActive }

    // MARK: - Reading state

    func apply(_ next: HealthSyncProgress) {
        progress = next
        if next.lastOutcome == .macUnreachable { macUnreachable = true }
        if next.lastOutcome == .synced { macUnreachable = false }
        if next.lastOutcome == .paused { macPaused = true }
    }

    /// The last run's result as saved on disk (a run in a background launch
    /// does not reach this store).
    func loadSaved() {
        let saved = HealthSyncStateStore.shared.read()
        if progress.lastSuccessAt == nil { progress.lastSuccessAt = saved.lastSuccessAt }
        if progress.oldestDate == nil { progress.oldestDate = saved.oldestDate }
        if progress.lastOutcome == nil { progress.lastOutcome = saved.lastOutcome.flatMap { HealthRunOutcome(rawValue: $0) } }
        if progress.lastRunAt == nil { progress.lastRunAt = saved.lastRunAt }
    }

    /// The Mac's side (pause, how far back its data goes) and this phone's
    /// background limits. Called when the screen opens and on pull to refresh.
    func refresh() async {
        isEnabled = HealthSync.isEnabled
        loadSaved()
        backgroundRefreshOff = UIApplication.shared.backgroundRefreshStatus != .available
        lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        guard isEnabled, AppConfig.serverURL != nil else { return }
        do {
            let status = try await transport.healthStatus(timeout: 30)
            macPaused = status.paused
            macDataFrom = status.coverage?.from.flatMap(Self.parseDay)
            let characteristics = Set(HealthTypeCatalog.characteristicNames.map { "x.\($0)" })
            macHasSamples = (status.types ?? []).contains { $0.lastSampleAt != nil && !characteristics.contains($0.type) }
            macUnreachable = false
        } catch {
            macUnreachable = HealthSyncEngine.outcome(for: error) == .macUnreachable
        }
    }

    // MARK: - Actions

    /// Ask Health for read access to everything, then sync. In the demo nothing
    /// touches HealthKit: the switch flips and the demo server answers.
    func turnOn() async {
        guard busy == nil else { return }
        errorMessage = nil
        if !isDemo {
            guard HKHealthStore.isHealthDataAvailable() else {
                errorMessage = "Apple Health is not available on this device."
                return
            }
        }
        busy = .turningOn
        defer { busy = nil }
        if !isDemo {
            do {
                try await HealthKitDataSource.shared.requestReadAuthorization(
                    for: HealthTypeCatalog.all, characteristics: true
                )
            } catch {
                errorMessage = "Apple Health did not open its permission screen. Try again."
                AppLog.error("health", "authorization request failed", ["error": String(describing: error)])
                return
            }
        }
        HealthSync.isEnabled = true
        isEnabled = true
        AppLog.info("health", "turned on", ["demo": String(isDemo)])
        // Turning this on is a request to sync, so a pause left by an earlier
        // delete (every delete pauses the Mac) is lifted.
        if let settings = try? await transport.healthSetPaused(false) {
            macPaused = settings.paused ?? false
        }
        if isDemo {
            await HealthSync.engine.run(reason: "turned-on", budget: 30)
        } else {
            HealthBackground.shared.enable()
        }
        await refresh()
    }

    func syncNow() {
        errorMessage = nil
        if isDemo {
            Task { await HealthSync.engine.run(reason: "sync-now", budget: 30) }
        } else {
            HealthBackground.shared.syncNow()
        }
    }

    func setPaused(_ paused: Bool) async {
        guard busy == nil else { return }
        busy = .pausing
        defer { busy = nil }
        errorMessage = nil
        do {
            let settings = try await transport.healthSetPaused(paused)
            macPaused = settings.paused ?? paused
            AppLog.info("health", paused ? "paused" : "resumed")
            if !paused { syncNow() }
        } catch {
            errorMessage = "Your Mac can't be reached right now, so nothing changed."
        }
    }

    /// Delete every Health record on the Mac, forget this phone's progress and
    /// turn Apple Health off here. Nothing in the Health app is touched.
    @discardableResult
    func deleteDataOnMac() async -> Bool {
        guard busy == nil else { return false }
        busy = .deleting
        defer { busy = nil }
        errorMessage = nil
        do {
            _ = try await transport.healthDeleteData()
        } catch {
            errorMessage = "Your Mac can't be reached right now, so nothing was deleted."
            return false
        }
        HealthSync.isEnabled = false
        HealthSync.eraseLocalState()
        AppLog.info("health", "data on the Mac deleted, turned off")
        return true
    }

    /// Offer the read sheet again when an update added types nobody was asked
    /// about; otherwise open Settings, where Privacy & Security, Health, Walnut
    /// holds the switches.
    func openHealthPermissions() async {
        if !isDemo, HKHealthStore.isHealthDataAvailable(),
           await HealthKitDataSource.shared.shouldRequestAuthorization(for: HealthTypeCatalog.all) {
            try? await HealthKitDataSource.shared.requestReadAuthorization(
                for: HealthTypeCatalog.all, characteristics: true
            )
            return
        }
        if let settings = URL(string: UIApplication.openSettingsURLString) {
            await UIApplication.shared.open(settings)
        }
    }

    /// Disconnect and delete: back to the off screen.
    func eraseLocalState() {
        isEnabled = false
        progress = HealthSyncProgress()
        macPaused = nil
        macDataFrom = nil
        macHasSamples = false
        macUnreachable = false
        errorMessage = nil
    }

    // MARK: - Helpers

    static func parseDay(_ text: String) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return Calendar.current.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}
