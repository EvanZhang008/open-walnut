import Foundation

// What a Walnut server says it is on GET /api/v1/status (server: src/web/server-facts.ts).
// A server is the leader (the Mac) or a replica; the cloud companion is a replica that runs
// on the cloud with some capabilities, nothing more. Every field is additive: an older server
// omits them, and the app then reads the frozen `mode` and `cloud` as before.

extension ServerStatus {
    /// `role`: leader | replica. An unknown value reads as absent.
    enum Role: String, Codable, Equatable {
        case leader
        case replica
    }

    /// `placement`: where the server runs. An unknown value reads as absent.
    enum Placement: String, Codable, Equatable {
        case mac
        case host
        case cloud
    }

    /// `leader`: does this server's leader (the Mac) answer it right now. On the leader
    /// itself `answers` is always true.
    struct LeaderPresence: Codable, Equatable {
        let answers: Bool
        /// Why not (or "answers" / "leader"). "not-heard" = the replica has not heard yet.
        let why: String?
        /// Since when, in ms since the epoch (0 = never changed).
        let since: Double?

        init(answers: Bool, why: String? = nil, since: Double? = nil) {
            self.answers = answers
            self.why = why
            self.since = since
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            answers = try c.decode(Bool.self, forKey: .answers)
            why = try? c.decodeIfPresent(String.self, forKey: .why)
            since = try? c.decodeIfPresent(Double.self, forKey: .since)
        }
    }

    /// This server is a replica, its leader elsewhere: `role` when the server says it, else `mode`.
    var isReplica: Bool {
        if let role { return role == .replica }
        return mode == .replica
    }

    /// This server runs on the cloud (the companion): `placement` when sent, else the frozen `cloud`.
    var isOnCloud: Bool {
        if let placement { return placement == .cloud }
        return cloud
    }

    /// Does the server list this capability? nil = it does not list its capabilities (older build).
    func hasCapability(_ name: String) -> Bool? {
        serverCapabilities.map { $0.contains(name) }
    }

    enum LeaderReach: Equatable { case reachable, offline, unknown }

    /// Can this server reach the Mac right now? The server's own `leader.answers` when it sends
    /// it; else the companion's older signal, its bridge list holding the Mac (`__local__`).
    /// An ABSENT bridge list means "too old to say" (`.unknown`), unlike an empty one.
    var leaderReach: LeaderReach {
        if let leader, !(leader.answers == false && leader.why == "not-heard") {
            return leader.answers ? .reachable : .offline
        }
        guard let bridgeHosts else { return .unknown }
        return bridgeHosts.contains { $0.hostAlias == "__local__" } ? .reachable : .offline
    }
}
