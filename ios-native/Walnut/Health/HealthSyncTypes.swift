import Foundation

/// How a sync run ended. Persisted (raw value) for the Health screen.
enum HealthRunOutcome: String, Codable, Sendable {
    /// Every type is current on the Mac.
    case synced
    /// Out of time; the next run continues where this one stopped.
    case budget
    /// Syncing is paused (on the Mac or from this phone).
    case paused
    /// The Mac could not be reached (503, offline, timeout). Nothing is lost.
    case macUnreachable
    /// The phone is locked, so HealthKit cannot be read.
    case locked
    /// Apple Health is off on this iPhone.
    case off
    case notPaired
    /// No HealthKit on this device.
    case unavailable
    case unauthorized
    case cancelled
    /// Another run was already going; it picks this request up.
    case coalesced
    case failed
}

/// What the Health screen shows, published after every type.
struct HealthSyncProgress: Sendable, Equatable {
    var running = false
    var typesDone = 0
    var typesTotal = 0
    var oldestDate: Date?
    var lastSuccessAt: Date?
    var lastRunAt: Date?
    var lastOutcome: HealthRunOutcome?

    var historyComplete: Bool { typesTotal > 0 && typesDone >= typesTotal }
}

/// What the engine needs from the app, as values and closures so the engine has
/// no main-actor state (it runs in background launches) and tests control all of it.
struct HealthSyncEnvironment: Sendable {
    var isEnabled: @Sendable () -> Bool
    var isPaired: @Sendable () -> Bool
    var isDemo: @Sendable () -> Bool
    var now: @Sendable () -> Date
    var timeZone: @Sendable () -> TimeZone
    var deviceModel: String
    var deviceOS: String
}

