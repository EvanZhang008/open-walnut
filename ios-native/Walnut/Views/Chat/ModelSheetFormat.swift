import Foundation

/// The words and numbers of the model sheet's Cost, Speed and Details, pure so every
/// rule is a unit test (`ModelSheetFormatTests`). Each function mirrors the web
/// picker's own, named beside it, so the phone and the Mac read the same:
/// web/src/components/sessions/session-cost-format.ts (cost, durations, token counts),
/// session-usage-model.ts (the budget line) and turn-speed-format.ts (the speed).
enum ModelSheetFormat {
    /// One label and its value on a fold's page.
    struct Line: Equatable {
        let label: String
        let value: String
    }

    // MARK: - Money (session-cost-format.ts, session-usage-model.ts)

    /// `fmtUsd`: $102, $29.19, $0.0031 (small amounts keep two significant digits), $0.
    static func usd(_ n: Double) -> String {
        if n >= 100 { return "$" + fixed(n, 0) }
        if n >= 0.01 { return "$" + fixed(n, 2) }
        if n == 0 { return "$0" }
        return "$" + significant(n, 2)
    }

    /// `fmtCost`, a table cell: $1,234.56, $0.16, $0.0031.
    static func tableUsd(_ n: Double) -> String {
        n >= 0.01 ? "$" + grouped(n, fraction: 2) : usd(n)
    }

    /// `formatUsageCost`, the budget's amounts: $1,234.56, <$0.01; nil reads "not checked yet".
    static func usageUsd(_ n: Double?) -> String {
        guard let n, n.isFinite, n >= 0 else { return "not checked yet" }
        if n > 0 && n < 0.01 { return "<$0.01" }
        return "$" + grouped(n, fraction: 2)
    }

    /// `costToggleValue`, the Cost row: the total and nothing else.
    static func costValue(_ cost: SessionCostFacts.Cost) -> String {
        switch cost.status {
        case "unavailable": return "n/a"
        case "pending": return "reading…"
        case "empty": return "$0"
        default:
            guard let total = cost.totalUsd else { return "?" }
            return usd(total) + ((cost.unpricedResponses ?? 0) > 0 ? "+" : "")
        }
    }

    /// `costHeadline`, the Cost page's first line: the amount, plus what it leaves out.
    static func costHeadline(_ cost: SessionCostFacts.Cost) -> String {
        switch cost.status {
        case "unavailable": return "Not available"
        case "pending":
            var pct = ""
            if let p = cost.pending, p.totalBytes > 0 {
                pct = " (\(min(99, Int((p.readBytes / p.totalBytes * 100).rounded(.down))))%)"
            }
            return "Reading the transcript\(pct)…"
        case "empty": return "$0 so far"
        default:
            let unpriced = cost.unpricedResponses ?? 0
            let missing = "\(unpriced) request\(unpriced == 1 ? "" : "s") without a price"
            guard let total = cost.totalUsd else { return "Unknown (\(missing))" }
            return unpriced > 0 ? "\(usd(total)) + \(missing)" : usd(total)
        }
    }

    /// `costTimes`, as two lines: first to last request, and the time the model spent answering.
    static func costTimes(_ cost: SessionCostFacts.Cost) -> [Line] {
        var lines: [Line] = []
        if let first = WalnutTask.parseISO(cost.firstAt), let last = WalnutTask.parseISO(cost.lastAt) {
            let span = last.timeIntervalSince(first) * 1000
            if span >= 1000 { lines.append(Line(label: "Span", value: duration(span))) }
        }
        if let api = cost.apiDurationMs, api >= 1000 { lines.append(Line(label: "Model time", value: duration(api))) }
        return lines
    }

    /// One line per model the session ran: its name, its requests and what they cost.
    static func costModels(_ cost: SessionCostFacts.Cost) -> [Line] {
        (cost.models ?? []).map { m in
            let n = m.responses ?? 0
            let requests = "\(n) request\(n == 1 ? "" : "s")"
            let price = m.costUsd.map(tableUsd) ?? "no price"
            return Line(label: costModelLabel(m.model, speed: m.speed), value: "\(requests) · \(price)")
        }
    }

    /// `costModelLabel`: claude-opus-5-5 → Opus 5.5; gpt-6-1-sol → GPT-6.1 Sol; anything else as reported.
    static func costModelLabel(_ model: String, speed: String?) -> String {
        var label = model
        if let g = gptPattern.firstMatch(in: model, range: NSRange(model.startIndex..., in: model)) {
            func group(_ i: Int) -> String? {
                Range(g.range(at: i), in: model).map { String(model[$0]) }
            }
            let word = group(3) ?? ""
            label = "GPT-\(group(1) ?? "")\(group(2).map { ".\($0)" } ?? "") \(word.prefix(1).uppercased())\(word.dropFirst())"
        } else if model.hasPrefix("claude-") {
            label = ModelCatalogRowLabel.formatModelName(model)
        }
        return speed == "fast" ? "\(label) fast" : label
    }

    private static let gptPattern = try! NSRegularExpression(pattern: "^gpt-([0-9]+)(?:-([0-9]+))?-([a-z]+)$")

    /// `budgetSummary` (with `budgetPauseLabel` first); nil = the session keeps no budget here.
    static func budgetSummary(_ budget: SessionCostFacts.Budget?) -> String {
        guard let b = budget else { return "No budget" }
        if let paused = budgetPauseLabel(b) { return paused }
        guard let limit = b.limitUsd else { return "No budget" }
        if b.checkError != nil { return "\(usageUsd(limit)) · usage could not be read" }
        if b.state == "checking" || b.spentUsd == nil { return "\(usageUsd(limit)) · checking" }
        return "\(usageUsd(b.spentUsd)) of \(usageUsd(limit))"
    }

    /// `budgetPauseLabel`: the one line a paused budget says; nil when it is not paused.
    static func budgetPauseLabel(_ b: SessionCostFacts.Budget) -> String? {
        guard b.state == "paused" else { return nil }
        if b.reason == "unreadable" { return "Paused: its usage could not be read" }
        guard b.limitUsd != nil else { return nil }
        if b.reason == "unpriced" { return "Paused: a request on \(b.unpricedModel ?? "a model") has no price" }
        return "Paused at budget: \(usageUsd(b.spentUsd)) of \(usageUsd(b.limitUsd))"
    }

    /// The Cost row's dot, as VoiceOver reads it (the web's `BudgetPausedMark`).
    static let budgetPausedNote = "Budget reached: the session is paused"

    // MARK: - Durations and counts

    /// `fmtDuration`: 45s, 12m, 3h 4m, 5d 11h.
    static func duration(_ ms: Double) -> String {
        guard ms.isFinite, ms >= 0 else { return "" }
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return m % 60 > 0 ? "\(h)h \(m % 60)m" : "\(h)h" }
        let d = h / 24
        return h % 24 > 0 ? "\(d)d \(h % 24)h" : "\(d)d"
    }

    /// `formatSeconds`, the speed's times: 0.6s, 2.6s, 53s, 1m 05s.
    static func seconds(_ ms: Double) -> String {
        let s = (ms.isFinite && ms >= 0 ? ms : 0) / 1000
        if s < 60 { return s < 10 ? "\(fixed(s, 1))s" : "\(Int(s.rounded()))s" }
        let m = Int((s / 60).rounded(.down))
        let rest = Int((s - Double(m) * 60).rounded())
        return "\(m)m \(rest < 10 ? "0" : "")\(rest)s"
    }

    /// `fmtTokenCount`: 767.6K, 1.2M, 828.4K, 950.
    static func tokenCount(_ n: Double) -> String {
        if n >= 1_000_000 { return trimZero(fixed(n / 1_000_000, 1)) + "M" }
        if n >= 1_000 { return trimZero(fixed(n / 1_000, 1)) + "K" }
        return String(Int(n.rounded()))
    }

    // MARK: - Speed (turn-speed-format.ts computeReadout)

    /// A rate over a shorter window is noise (`MIN_RATE_WINDOW_MS`).
    static let minRateWindowMs: Double = 500
    /// An interim rate from fewer tokens rounds to noise (`MIN_ESTIMATE_TOKENS`).
    static let minEstimateTokens = 20

    /// "239 tok/s", "~41 tok/s" (only while the first message is still open), nil when
    /// there is nothing honest to divide.
    static func tokensPerSecond(_ s: SessionTurnSpeed) -> String? {
        if s.outputTokens > 0 && s.generationMs >= minRateWindowMs {
            return "\(Int((Double(s.outputTokens) / (s.generationMs / 1000)).rounded())) tok/s"
        }
        let open = openEstimate(s)
        if !s.isFinal && s.inFlight && open >= minEstimateTokens && s.inFlightVisibleMs >= 1000 {
            return "~\(Int((Double(open) / (s.inFlightVisibleMs / 1000)).rounded())) tok/s"
        }
        return nil
    }

    /// The Speed row: the rate; "…" while a turn runs with no count yet; "—" with no
    /// measured turn (none yet, or one too short to divide).
    static func speedValue(_ s: SessionTurnSpeed?) -> String {
        guard let s else { return "—" }
        return tokensPerSecond(s) ?? (s.isFinal ? "—" : "…")
    }

    // MARK: - Average speed (turn-speed-format.ts speedAverage)

    /// The session's average on one model: "128 tok/s" over `turns` counted turns.
    struct SpeedAverage: Equatable {
        let tps: String
        let turns: Int
    }

    /// What the average covers, the line under the Speed page's rows.
    static let averageNote = "Output tokens per second of model generation, averaged over this session's turns "
        + "on this model (thinking counted; tool waits and time to first token not)."

    /// A model id read as one model for the average: no provider prefix and no bracket
    /// (an effort level or the 1M window runs the same model at the same speed).
    static func speedModelName(_ id: String) -> String {
        var bare = id.replacingOccurrences(of: "^(?:[a-z0-9]+\\.)+(?=[a-z])", with: "", options: .regularExpression)
        bare = bare.replacingOccurrences(of: "\\[[^\\]]*\\]$", with: "", options: .regularExpression)
        return ModelCatalogRowLabel.formatModelName(bare)
    }

    /// The model the session runs on now, as the server keys its totals: an ACP id
    /// without its effort, else the record's model, else the last turn's.
    static func currentModel(_ r: SessionDetail.Record) -> String? {
        if let acp = r.acpModel, !acp.isEmpty {
            // A provider/model pair in JSON ("[\"a\",\"b\"]") carries no effort.
            if acp.hasPrefix("[") { return acp }
            return acp.replacingOccurrences(of: "\\[[^\\]]+\\]$", with: "", options: .regularExpression)
        }
        if let model = r.model, !model.isEmpty { return model }
        return r.lastTurnSpeed?.model
    }

    /// The token-weighted average on `model`: its own entry, else every entry read as the
    /// same model, summed. nil while no turn on it was counted (the row shows the last turn).
    static func speedAverage(_ totals: SessionSpeedTotals?, model: String?) -> SpeedAverage? {
        guard let totals, let model, !model.isEmpty else { return nil }
        func sum(_ pick: (String) -> Bool) -> SpeedAverage? {
            var tokens = 0.0, ms = 0.0, turns = 0
            for (key, t) in totals.models where pick(key) && t.outputTokens > 0 && t.generationMs > 0 {
                tokens += t.outputTokens
                ms += t.generationMs
                turns += max(0, t.turns)
            }
            guard tokens > 0, ms >= Self.minRateWindowMs else { return nil }
            return SpeedAverage(tps: "\(Int((tokens / (ms / 1000)).rounded())) tok/s", turns: turns)
        }
        if let own = sum({ $0 == model }) { return own }
        let want = speedModelName(model)
        return want.isEmpty ? nil : sum({ Self.speedModelName($0) == want })
    }

    static func speedAverage(_ r: SessionDetail.Record) -> SpeedAverage? {
        speedAverage(r.speedTotals, model: currentModel(r))
    }

    /// The Speed row: the session's average on its model ("128 tok/s avg"), else the last
    /// turn's rate (`speedValue(_:)`); "—" with no measured turn.
    static func speedValue(_ r: SessionDetail.Record) -> String {
        if r.lastTurnSpeed != nil, let average = speedAverage(r) { return "\(average.tps) avg" }
        return speedValue(r.lastTurnSpeed)
    }

    /// The Speed page's "Session average" rows: "Average 128 tok/s", "Turns 42 on Fable 5.1 1M".
    static func averageLines(_ a: SpeedAverage, modelName: String?) -> [Line] {
        [
            Line(label: "Average", value: a.tps),
            Line(label: "Turns", value: grouped(Double(a.turns), fraction: 0) + (modelName.map { " on \($0)" } ?? "")),
        ]
    }

    // MARK: - Speed table (SessionSpeedReadout.tsx: Model | Tokens | First token | Speed | Time)

    /// One row of the Speed page's table: the turn, or the subagents that ran on one model
    /// (`computeReadout` and `computeLaneRows` in turn-speed-format.ts). An empty cell is "".
    struct SpeedRow: Equatable {
        /// One label by the row's state: "Last turn" once final, "This turn" while it runs;
        /// "Agent", "Agents ×2".
        let label: String
        /// The model it ran on, when known.
        let model: String?
        /// Small grey words: "partial", "stopped", "last call"; an agent's "running", "failed".
        let states: [String]
        /// Still running: the row's dot.
        let running: Bool
        let tokens: String
        let first: String
        let speed: String
        let time: String
    }

    /// The table's column titles after the row's label.
    static let speedColumns = ["Tokens", "First token", "Speed", "Time"]

    /// The turn's row, then one row per model its subagents ran on. `now` is epoch ms, for a
    /// row still running; `name` names a model id the way the sheet does.
    static func speedRows(_ s: SessionTurnSpeed, now: Double, name: (String?) -> String?) -> [SpeedRow] {
        let live = !s.isFinal
        let real = s.isFinal ? (s.turnOutputTokens ?? s.outputTokens) : s.outputTokens
        let estimate = openEstimate(s) + (s.estimatedTokens ?? 0)
        let tokens = (estimate > 0 ? "~" : "") + grouped(Double(real + estimate), fraction: 0)
        var first = ""
        if let ttft = s.ttftMs { first = seconds(ttft) } else if live, let start = s.startedAt { first = seconds(now - start) + "…" }
        var time = ""
        if s.isFinal {
            if let wall = s.durationMs ?? s.endedAt.flatMap({ end in s.startedAt.map { end - $0 } }) { time = seconds(wall) }
        } else if let start = s.startedAt {
            time = seconds(now - start)
        }
        var states: [String] = []
        if s.interrupted { states.append("stopped") } else if s.partial { states.append("partial") }
        if s.tokenScope == "last-call" { states.append("last call") }
        let turn = SpeedRow(label: live ? "This turn" : "Last turn", model: name(s.model), states: states, running: live,
                            tokens: tokens, first: first, speed: tokensPerSecond(s) ?? "", time: time)
        return [turn] + laneRows(s.lanes, now: now, name: name)
    }

    /// `computeLaneRows`: the lanes grouped by model, in the order each model first ran.
    static func laneRows(_ lanes: [SessionTurnSpeedLane], now: Double, name: (String?) -> String?) -> [SpeedRow] {
        var keys: [String] = []
        var groups: [String: [SessionTurnSpeedLane]] = [:]
        for (index, lane) in lanes.enumerated() {
            let key = lane.model ?? "lane:\(index)"
            if groups[key] == nil { keys.append(key) }
            groups[key, default: []].append(lane)
        }
        return keys.compactMap { key -> SpeedRow? in
            guard let group = groups[key], let head = group.first else { return nil }
            let running = group.contains { $0.status == "running" }
            let total = group.reduce(0) { $0 + $1.estimatedTokens }
            let firsts = group.compactMap(\.firstReplyMs)
            let earliest = group.map(\.startedAt).min() ?? 0
            var first = ""
            if let soonest = firsts.min() { first = seconds(soonest) } else if running { first = seconds(now - earliest) + "…" }
            let generation = group.reduce(0) { $0 + $1.generationMs }
            let speed = total >= minEstimateTokens && generation >= minRateWindowMs
                ? "~\(Int((Double(total) / (generation / 1000)).rounded())) tok/s" : ""
            let end = running ? now : (group.map { $0.endedAt ?? $0.startedAt }.max() ?? earliest)
            let status = running ? "running"
                : group.contains { $0.status == "failed" } ? "failed"
                : group.contains { $0.status == "stopped" } ? "stopped" : "done"
            return SpeedRow(
                label: group.count > 1 ? "Agents ×\(group.count)" : "Agent",
                model: name(head.model) ?? group.compactMap(\.label).first,
                states: status == "done" ? [] : [status], running: running,
                tokens: "~" + grouped(Double(total), fraction: 0), first: first, speed: speed,
                time: end > earliest ? seconds(end - earliest) : ""
            )
        }
    }

    /// What VoiceOver reads for a row: "Last turn, GPT-6.1 Sol, last call".
    static func speedRowTitle(_ row: SpeedRow) -> String {
        ([row.label] + [row.model].compactMap { $0 } + row.states).joined(separator: ", ")
    }

    private static func openEstimate(_ s: SessionTurnSpeed) -> Int {
        !s.isFinal && s.inFlight ? Int((Double(s.inFlightChars) / 4).rounded()) : 0
    }

    /// A model id as the sheet names it: the menu's own row title when the catalog
    /// lists it, else the id read the way the pill reads one, without its provider
    /// prefix ("openai.") or a setting in brackets ("[xhigh]"; "[1m]" is part of the name).
    static func modelName(_ id: String?, menu: PillMenu) -> String? {
        guard let id, !id.isEmpty else { return nil }
        for section in menu.sections {
            for item in section.items where item.choice == .model(id) { return item.title }
        }
        var bare = id
        bare = bare.replacingOccurrences(of: "^(?:[a-z0-9]+\\.)+(?=[a-z])", with: "", options: .regularExpression)
        bare = bare.replacingOccurrences(of: "\\[(?!1m\\])[^\\]]*\\]$", with: "", options: .regularExpression)
        return ModelCatalogRowLabel.formatModelName(bare)
    }

    // MARK: - Details

    /// Context at or past this share of the window puts a dot on the Details row
    /// (the web picker's CONTEXT_WARN_PCT).
    static let contextWarnPercent = 90

    struct Context: Equatable {
        let used: Double
        let window: Double?

        var percent: Int? {
            guard let window, window > 0 else { return nil }
            return Int((used / window * 100).rounded())
        }

        /// The bar's fill, 0 to 1.
        var fraction: Double? {
            guard let window, window > 0 else { return nil }
            return min(1, max(0, used / window))
        }

        /// "767.6K / 828.4K (93%)", or "767.6K" with no window known.
        var text: String {
            guard let window, let percent else { return tokenCount(used) }
            return "\(tokenCount(used)) / \(tokenCount(window)) (\(percent)%)"
        }

        /// The Details row's dot, as VoiceOver reads it: "Context 93% full".
        var warning: String? {
            guard let percent, percent >= contextWarnPercent else { return nil }
            return "Context \(percent)% full"
        }
    }

    /// The session's context: an ACP engine's own count, else a Claude Code session's
    /// prompt size at its last request; nil when the record carries neither.
    static func context(_ record: SessionDetail.Record) -> Context? {
        guard let used = record.contextTokens ?? record.promptCache?.tokens, used > 0 else { return nil }
        return Context(used: used, window: record.modelMaxWindow)
    }

    /// `engineName`: absent is Claude Code, as the server reads a record without one.
    static func engineName(_ engine: String?) -> String {
        switch engine ?? "claude" {
        case "claude": return "Claude Code"
        case "codex": return "Codex"
        case "opencode": return "OpenCode"
        case let other: return other
        }
    }

    /// A permission mode's name ("Bypass"), the launcher's spelling.
    static func modeName(_ mode: String) -> String {
        NewSessionSheet.PermissionMode(rawValue: mode)?.label ?? mode
    }

    // MARK: - Number spelling (en-US, whatever the phone's locale: the web's spelling)

    private static func fixed(_ n: Double, _ digits: Int) -> String {
        String(format: "%.\(digits)f", n)
    }

    private static func trimZero(_ s: String) -> String {
        s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }

    private static func grouped(_ n: Double, fraction: Int) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.minimumFractionDigits = fraction
        f.maximumFractionDigits = fraction
        return f.string(from: NSNumber(value: n)) ?? fixed(n, fraction)
    }

    /// `toPrecision(digits)` for an amount under a cent: 0.0031, 0.0030.
    private static func significant(_ n: Double, _ digits: Int) -> String {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.usesSignificantDigits = true
        f.minimumSignificantDigits = digits
        f.maximumSignificantDigits = digits
        f.usesGroupingSeparator = false
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }
}
