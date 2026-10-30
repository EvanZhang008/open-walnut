import Foundation

/// The lines the CLI put into a session's conversation itself (a loaded skill's
/// text, a hook's added context, a continuation summary) as rows of their own.
///
/// The transcript never sends them as rows: an older app draws any user row as the
/// person's bubble, so each rides the row before it (`injectedAfter`), or the first
/// row of a read when nothing of the read came before it (`injectedBefore`). This
/// pass puts each one back where it was, as a `.injected` row the builder draws as
/// one closed line that opens to its text, and that turn shaping treats as a quiet
/// step (never sent, never a person's bubble, never a turn's last word), the way
/// the web chat draws and folds them (`injected-context.ts`, `process-fold.ts`).
///
/// It runs over the whole list the timeline draws, not per read, because the
/// store stitches reads together: Load earlier puts a page in front of the head,
/// and a refetch overlaps what is held. Two reads can then describe one stretch of
/// lines twice: the older row's `injectedAfter` holds the lines after it (all of
/// them, or those written by the time it was read), and the newer row's
/// `injectedBefore` holds the ones its own read began with, the last of them. The
/// longest run that ends the first and starts the second is drawn once. Each row is
/// named by its carrier's place and its index (`locationKey`, never its text, which
/// a slim read clips shorter), so it keeps its identity and its open state across
/// refetches and pages: a line from `injectedBefore` keeps the name it had while
/// its carrier led the list.
enum TimelineInjectedLines {
    /// Every carrier's lines as rows of their own, in place. Unchanged (the same
    /// array) when no row carries any.
    static func expand(_ messages: [ChatMessage]) -> [ChatMessage] {
        guard messages.contains(where: { $0.injectedAfter?.isEmpty == false || $0.injectedBefore?.isEmpty == false })
        else { return messages }
        var counts: [String: Int] = [:]
        let keys: [String] = messages.map { m in
            let base = TimelineTurnFold.locationKey(m)
            let n = counts[base, default: 0]
            counts[base] = n + 1
            return "\(base)#\(n)"
        }
        var out: [ChatMessage] = []
        out.reserveCapacity(messages.count + 8)
        for (i, m) in messages.enumerated() {
            let before = m.injectedBefore ?? []
            if i > 0, let after = messages[i - 1].injectedAfter, !after.isEmpty {
                let carrier = messages[i - 1]
                let shared = overlap(after, before)
                for (n, item) in after.prefix(after.count - shared).enumerated() {
                    out.append(row(item, id: rowID(keys[i - 1], "after", n), carrier: carrier))
                }
            }
            for (n, item) in before.enumerated() {
                out.append(row(item, id: rowID(keys[i], "before", n), carrier: m))
            }
            out.append(m)
        }
        if let last = messages.last, let after = last.injectedAfter {
            for (n, item) in after.enumerated() {
                out.append(row(item, id: rowID(keys[keys.count - 1], "after", n), carrier: last))
            }
        }
        return out
    }

    /// A drawn line's id: its carrier's place, which side of it, and its index.
    static func rowID(_ carrierKey: String, _ side: String, _ index: Int) -> String {
        "injected|\(carrierKey)|\(side)|\(index)"
    }

    /// The row a line is drawn as: `detail` its label, `source` its kind, `text` its
    /// words, at its carrier's time.
    static func row(_ item: CliInjectedItem, id: String, carrier: ChatMessage) -> ChatMessage {
        ChatMessage(id: id, role: "user", text: item.text, createdAt: carrier.createdAt,
                    kind: .injected, source: item.kind, detail: item.label)
    }

    /// The line a drawn row stands for.
    static func item(_ m: ChatMessage) -> CliInjectedItem? {
        guard m.kind == .injected else { return nil }
        return CliInjectedItem(kind: m.source ?? "context", label: m.detail ?? "", text: m.text)
    }

    /// How many lines end `after` and start `before`: the same lines read twice.
    static func overlap(_ after: [CliInjectedItem], _ before: [CliInjectedItem]) -> Int {
        var k = min(after.count, before.count)
        while k > 0 {
            if zip(after.suffix(k), before.prefix(k)).allSatisfy(sameLine) { return k }
            k -= 1
        }
        return 0
    }

    /// One line read twice: the same kind and label, and the same words, or one
    /// read's clip of them (its text minus the "…" starts the other's).
    static func sameLine(_ a: CliInjectedItem, _ b: CliInjectedItem) -> Bool {
        guard a.kind == b.kind, a.label == b.label else { return false }
        if a.text == b.text { return true }
        let (short, long) = a.text.utf8.count < b.text.utf8.count ? (a.text, b.text) : (b.text, a.text)
        guard short.unicodeScalars.last == "\u{2026}" else { return false }
        return long.unicodeScalars.starts(with: short.unicodeScalars.dropLast())
    }
}
