import Foundation

/// Short relative timestamps ("3h ago", "now") for list rows.
///
/// Shared formatter (audit IO-7): this runs per ROW per render, and an
/// ISO8601DateFormatter allocation alone is ~133µs — the parse itself rides
/// `WalnutTask.parseISO`'s memo cache (Models.swift).
enum RelativeTime {
    private static let formatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func short(_ iso: String) -> String {
        guard let date = WalnutTask.parseISO(iso) else { return "" }
        // A just-touched row's timestamp can be ~now or slightly ahead (server
        // clock skew) — RelativeDateTimeFormatter renders that as the future
        // tense "in 0s". Clamp anything under a minute to "now".
        if abs(date.timeIntervalSinceNow) < 60 { return "now" }
        return formatter.localizedString(for: date, relativeTo: .now)
    }
}
