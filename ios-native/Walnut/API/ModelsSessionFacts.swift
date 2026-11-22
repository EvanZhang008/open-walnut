import Foundation

// MARK: - What the model sheet's Cost, Speed and Details read (additive /api/v1, 2026-11)
//
// The speed and the context are fields of the session record GET /v1/sessions/:id
// already returns (`SessionDetail.Record`); the cost and the budget come from
// GET /v1/sessions/:id/cost. Every field is optional or decoded leniently: an older
// server, or the companion's degraded detail, leaves them out, and the sheet then
// shows "n/a" or "—", never a decode failure.

/// The last turn's speed (`SessionTurnSpeed` in src/core/types.ts), only the fields
/// the sheet's Speed row and page read (`computeReadout` in
/// web/src/components/sessions/turn-speed-format.ts). Decoded field by field, so
/// one field of an unexpected type drops that field and never the record (it is
/// Codable only because the record is; the demo server encodes records).
struct SessionTurnSpeed: Codable, Equatable, Sendable {
    var outputTokens: Int = 0
    var generationMs: Double = 0
    var ttftMs: Double?
    var durationMs: Double?
    var startedAt: Double?
    var endedAt: Double?
    var model: String?
    /// The turn is over (`final` on the wire); a record only stores final turns.
    var isFinal = true
    var inFlight = false
    var inFlightChars: Int = 0
    var inFlightVisibleMs: Double = 0
    var estimatedTokens: Int?
    var turnOutputTokens: Int?
    /// "last-call": the counts cover the turn's last model call only (Codex over ACP).
    var tokenScope: String?
    /// Walnut saw only part of the turn (attached mid-turn), so the rate covers what it saw.
    var partial = false
    /// The turn was stopped before it finished.
    var interrupted = false
    /// The turn's subagents, one per Agent call, in start order (absent from older servers).
    var lanes: [SessionTurnSpeedLane] = []

    private enum CodingKeys: String, CodingKey {
        case outputTokens, generationMs, ttftMs, durationMs, startedAt, endedAt, model
        case isFinal = "final"
        case inFlight, inFlightChars, inFlightVisibleMs, estimatedTokens, turnOutputTokens, tokenScope
        case partial, interrupted, lanes
    }

    init(
        outputTokens: Int = 0, generationMs: Double = 0, ttftMs: Double? = nil, durationMs: Double? = nil,
        model: String? = nil, isFinal: Bool = true, tokenScope: String? = nil
    ) {
        self.outputTokens = outputTokens
        self.generationMs = generationMs
        self.ttftMs = ttftMs
        self.durationMs = durationMs
        self.model = model
        self.isFinal = isFinal
        self.tokenScope = tokenScope
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func number(_ key: CodingKeys) -> Double? { try? c.decodeIfPresent(Double.self, forKey: key) }
        outputTokens = number(.outputTokens).map { Int($0) } ?? 0
        generationMs = number(.generationMs) ?? 0
        ttftMs = number(.ttftMs)
        durationMs = number(.durationMs)
        startedAt = number(.startedAt)
        endedAt = number(.endedAt)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        isFinal = (try? c.decodeIfPresent(Bool.self, forKey: .isFinal)) ?? true
        inFlight = (try? c.decodeIfPresent(Bool.self, forKey: .inFlight)) ?? false
        inFlightChars = number(.inFlightChars).map { Int($0) } ?? 0
        inFlightVisibleMs = number(.inFlightVisibleMs) ?? 0
        estimatedTokens = number(.estimatedTokens).map { Int($0) }
        turnOutputTokens = number(.turnOutputTokens).map { Int($0) }
        tokenScope = try? c.decodeIfPresent(String.self, forKey: .tokenScope)
        partial = (try? c.decodeIfPresent(Bool.self, forKey: .partial)) ?? false
        interrupted = (try? c.decodeIfPresent(Bool.self, forKey: .interrupted)) ?? false
        lanes = (try? c.decodeIfPresent([SessionTurnSpeedLane].self, forKey: .lanes)) ?? []
    }
}

/// One subagent of a turn (`SessionTurnSpeedLane` in src/core/types.ts), the fields the
/// Speed page's agent rows read (`computeLaneRows` in turn-speed-format.ts). Decoded field
/// by field like the turn: an odd field drops that field, never the lane or the record.
struct SessionTurnSpeedLane: Codable, Equatable, Sendable {
    var model: String?
    /// The Agent's subagent_type (or description), for a row whose model is not known yet.
    var label: String?
    var startedAt: Double = 0
    /// Agent start to its first message; nil until seen.
    var firstReplyMs: Double?
    var generationMs: Double = 0
    /// Characters ÷ 4 of the agent's messages: the only token figure an agent has.
    var estimatedTokens: Int = 0
    /// "running", "done", "failed" or "stopped".
    var status = "done"
    var endedAt: Double?

    private enum CodingKeys: String, CodingKey {
        case model, label, startedAt, firstReplyMs, generationMs, estimatedTokens, status, endedAt
    }

    init(
        model: String? = nil, label: String? = nil, startedAt: Double = 0, firstReplyMs: Double? = nil,
        generationMs: Double = 0, estimatedTokens: Int = 0, status: String = "done", endedAt: Double? = nil
    ) {
        self.model = model
        self.label = label
        self.startedAt = startedAt
        self.firstReplyMs = firstReplyMs
        self.generationMs = generationMs
        self.estimatedTokens = estimatedTokens
        self.status = status
        self.endedAt = endedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func number(_ key: CodingKeys) -> Double? { try? c.decodeIfPresent(Double.self, forKey: key) }
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        startedAt = number(.startedAt) ?? 0
        firstReplyMs = number(.firstReplyMs)
        generationMs = number(.generationMs) ?? 0
        estimatedTokens = number(.estimatedTokens).map { Int($0) } ?? 0
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "done"
        endedAt = number(.endedAt)
    }
}

/// The session's running speed totals per model (`speedTotals` on the record,
/// `SessionSpeedTotal` in src/core/types.ts): the summed output tokens and generation
/// time of its counted turns, so tokens over time is the average the Speed row shows.
/// Decoded leniently: an entry of an unexpected shape is dropped, never the record.
struct SessionSpeedTotals: Codable, Equatable, Sendable {
    struct Total: Codable, Equatable, Sendable {
        var outputTokens: Double
        var generationMs: Double
        var turns: Int
    }

    var models: [String: Total]

    init(_ models: [String: Total]) { self.models = models }

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(_ name: String) { stringValue = name }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    init(from decoder: Decoder) throws {
        var models: [String: Total] = [:]
        if let c = try? decoder.container(keyedBy: Key.self) {
            for key in c.allKeys {
                guard let entry = try? c.nestedContainer(keyedBy: Key.self, forKey: key) else { continue }
                func number(_ name: String) -> Double? { try? entry.decodeIfPresent(Double.self, forKey: Key(name)) }
                guard let tokens = number("outputTokens"), let ms = number("generationMs") else { continue }
                models[key.stringValue] = Total(outputTokens: tokens, generationMs: ms, turns: Int(number("turns") ?? 0))
            }
        }
        self.models = models
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        for (model, total) in models { try c.encode(total, forKey: Key(model)) }
    }
}

/// The record's prompt cache facts (`PromptCacheFacts`, src/core/sessions/prompt-cache.ts):
/// `tokens` is a Claude Code session's context size at its last request, the number
/// the web's "+" menu shows. An ACP session reports `contextTokens` instead.
struct SessionPromptCache: Codable, Equatable, Sendable {
    var tokens: Double?

    private enum CodingKeys: String, CodingKey { case tokens }

    init(tokens: Double?) { self.tokens = tokens }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tokens = try? c.decodeIfPresent(Double.self, forKey: .tokens)
    }
}

/// GET /v1/sessions/:id/cost → { cost, budget }. `cost` is the web's
/// GET /api/sessions/:id/cost payload; `budget` is null when the session keeps none here.
struct SessionCostFacts: Decodable, Equatable, Sendable {
    struct Cost: Decodable, Equatable, Sendable {
        struct Model: Decodable, Equatable, Sendable {
            let model: String
            var speed: String?
            var responses: Int?
            /// nil = this model's requests have no price.
            var costUsd: Double?
        }

        struct Pending: Decodable, Equatable, Sendable {
            let readBytes: Double
            let totalBytes: Double
        }

        /// priced | partial | unpriced | empty | pending | unavailable
        let status: String
        var reason: String?
        /// nil = some requests have no price, so no total is honest.
        var totalUsd: Double?
        var responses: Int?
        var unpricedResponses: Int?
        var models: [Model]?
        var firstAt: String?
        var lastAt: String?
        var apiDurationMs: Double?
        var pending: Pending?
    }

    /// `BudgetState` (src/providers/usage-budget-store.ts), the fields the sheet reads.
    struct Budget: Decodable, Equatable, Sendable {
        /// nil = no limit set.
        var limitUsd: Double?
        var spentUsd: Double?
        /// unlimited | checking | active | paused
        let state: String
        /// limit | unpriced | unreadable, while paused.
        var reason: String?
        var unpricedModel: String?
        var checkError: String?
    }

    let cost: Cost
    var budget: Budget?
}

extension WalnutAPI {
    /// What the session cost and its budget, for the model sheet's Cost row.
    /// An older server answers 404 (a replica's older Mac, 400 needs_upgrade):
    /// callers read every failure as "no cost".
    func sessionCostFacts(id: String) async throws -> SessionCostFacts {
        try await get("/sessions/\(escape(id))/cost")
    }
}
