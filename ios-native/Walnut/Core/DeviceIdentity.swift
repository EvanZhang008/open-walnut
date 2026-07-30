import Foundation
import UIKit

/// This device's hardware/app identity, reported to the server so the console's
/// Devices list can show "iPhone17,1 · iOS 26.1 · Walnut 1.0 (26)" instead of
/// only the name typed at pairing time.
///
/// `model` is the RAW hardware identifier from `hw.machine` (e.g. `iPhone17,1`).
/// UIKit exposes no marketing name ("iPhone 17 Pro"), and mapping identifiers to
/// marketing names needs a lookup table that must be updated every September —
/// so we deliberately show the identifier and keep this zero-maintenance.
///
/// `name` uses `UIDevice.current.name`, which since iOS 16 returns the generic
/// model name ("iPhone") unless the app holds Apple's restricted
/// `user-assigned-device-name` entitlement. We do NOT request that entitlement
/// (it needs a manual approval round-trip with Apple, and an unapproved
/// entitlement breaks signing), so treat this as a coarse hint.
enum DeviceIdentity {
    /// `hw.machine`, e.g. "iPhone17,1". Empty string if sysctl fails.
    static var model: String {
        var size = 0
        guard sysctlbyname("hw.machine", nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.machine", &bytes, &size, nil, 0) == 0 else { return "" }
        return String(cString: bytes)
    }

    /// e.g. "iOS 26.1".
    @MainActor
    static var os: String {
        "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
    }

    /// Generic model name on iOS 16+ (see the entitlement note above).
    @MainActor
    static var name: String {
        UIDevice.current.name
    }

    /// e.g. "1.0 (26)".
    static var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }
}
