import Foundation

// The demo server's Places routes. The demo records nothing: iOS is never asked
// for location there (an answer would stay with the real app, and nothing done
// in the demo may change it), so these routes only answer what the app sends,
// inside the app: the demo has no Mac.
extension DemoServer {
    func routePlaces(_ r: DemoRequest, _ s: [String]) -> DemoReply? {
        guard s.count == 2, s[0] == "places" else { return nil }
        switch (r.method, s[1]) {
        case ("GET", "status"):
            let count = DemoPlaces.count
            return .object([
                "recording": DemoPlaces.recording, "visitCount": count,
                "firstVisitAt": NSNull(), "lastVisitAt": NSNull(),
                "lastUploadAt": count > 0 ? DemoClock.iso(AppClock.now()) as Any : NSNull(),
            ])
        case ("POST", "sync"):
            let visits = (r.json["visits"] as? [[String: Any]]) ?? []
            let ids = visits.compactMap { $0["id"] as? String }
            let inserted = DemoPlaces.add(ids)
            if let state = r.json["state"] as? [String: Any] {
                DemoPlaces.recording = (state["enabled"] as? Bool) == true && (state["access"] as? String) == "always"
            }
            return .object(["accepted": ids.count, "inserted": inserted, "updated": ids.count - inserted, "rejected": 0])
        case ("DELETE", "data"):
            return .object(["removed": DemoPlaces.clear()])
        default:
            return nil
        }
    }
}

/// The demo's visits: ids only, in memory, gone on every reset.
enum DemoPlaces {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var ids = Set<String>()
    nonisolated(unsafe) private static var recordingValue = false

    static var count: Int { lock.withLock { ids.count } }

    static var recording: Bool {
        get { lock.withLock { recordingValue } }
        set { lock.withLock { recordingValue = newValue } }
    }

    static func add(_ new: [String]) -> Int {
        lock.withLock {
            let before = ids.count
            ids.formUnion(new)
            return ids.count - before
        }
    }

    static func reset() {
        lock.withLock {
            ids.removeAll()
            recordingValue = false
        }
    }

    static func clear() -> Int {
        lock.withLock {
            let removed = ids.count
            ids.removeAll()
            return removed
        }
    }
}
