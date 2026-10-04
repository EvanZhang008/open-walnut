import Foundation

// The demo server's Apple Health routes. The demo never reads HealthKit (the
// engine stops after the status call in demo mode), so these only have to make
// the Health screen look like a phone that has been syncing for a while.
extension DemoServer {
    func routeHealth(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        guard s.count == 2, s[0] == "health" else { return nil }
        switch (r.method, s[1]) {
        case ("GET", "status"):
            return .object(healthStatus())
        case ("POST", "sync"):
            let count = ((r.json["samples"] as? [Any])?.count ?? 0) + ((r.json["buckets"] as? [Any])?.count ?? 0)
            let state = withState { ($0.healthStoreId, $0.healthPaused) }
            if let sent = r.string("storeId"), sent != state.0 {
                return .object(["error": ["code": "store_mismatch", "message": "This health store was reset"],
                                "storeId": state.0], status: 409)
            }
            return .object([
                "accepted": state.1 ? 0 : count, "inserted": state.1 ? 0 : count,
                "deleted": (r.json["deleted"] as? [Any])?.count ?? 0, "storeId": state.0, "paused": state.1,
            ])
        case ("PUT", "settings"):
            let paused = withState { state -> Bool in
                if let value = r.bool("paused") { state.healthPaused = value }
                return state.healthPaused
            }
            return .object(["paused": paused, "sleepSourceOrder": NSNull(), "categories": Self.healthCategories,
                            "preferredUnits": [String: Any]()])
        case ("DELETE", "data"):
            let storeId = withState { state -> String in
                state.healthDeletes += 1
                state.healthStoreId = "hs-demo-\(state.healthDeletes)"
                state.healthPaused = true
                return state.healthStoreId
            }
            return .object(["deleted": "all", "storeId": storeId, "paused": true, "removed": 48_210])
        default:
            return nil
        }
    }

    private static let healthCategories = ["sleep", "heart", "activity", "vitals", "workouts", "mind", "audio", "other"]

    private func healthStatus() -> [String: Any] {
        let (storeId, paused, deletes) = withState { ($0.healthStoreId, $0.healthPaused, $0.healthDeletes) }
        let day = DateFormatter()
        day.calendar = Calendar(identifier: .gregorian)
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"
        let today = Date()
        // A believable history: about two and a half years, gone after a delete.
        let from = deletes > 0 ? nil : today.addingTimeInterval(-920 * 86_400)
        let catalog = HealthTypeCatalog.catalogSpecs
        let lastUpload: Any = deletes > 0 ? NSNull() : DemoClock.iso(today.addingTimeInterval(-240))
        let coverageFrom: Any = from.map { day.string(from: $0) as Any } ?? NSNull()
        let coverageTo: Any = deletes > 0 ? NSNull() : day.string(from: today)
        return [
            "connected": deletes == 0, "paused": paused, "storeId": storeId,
            "lastUploadAt": lastUpload,
            "coverage": ["from": coverageFrom, "to": coverageTo],
            "types": [Any](),
            "sources": [Any](),
            "sleepSourceOrder": NSNull(),
            "categories": Self.healthCategories,
            "tz": TimeZone.current.identifier,
            "supported": [
                "raw": catalog.filter { $0.kind == .raw }.map(\.name),
                "buckets": catalog.filter { $0.kind == .buckets }.map(\.name),
                "generic": ["prefixes": ["q", "c", "x"], "bucketPrefixes": ["q"], "covered": [String]()],
            ],
        ]
    }
}
