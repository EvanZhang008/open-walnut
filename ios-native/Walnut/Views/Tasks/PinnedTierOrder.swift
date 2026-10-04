import Foundation

/// The order of a pinned tier's rows, identical to the Mac's home panel.
///
/// # A twin, line for line
///
/// This is the Swift twin of `web/src/utils/pinned-tier-order.ts` (`orderPinnedTier`,
/// `clusterTierByGroup`, `clusterTierByProject`), which is what the console's pinned tiers
/// run. The phone used to invent its own order under `By project` (Inbox first, then
/// projects A to Z, rows by recent activity) and no order at all for folders under
/// `Custom order`, so the same tier read in a different order on each device. Both
/// implementations now run over one fixture (`tests/fixtures/pinned-tier-order/`)
/// in `tests/web/pinned-tier-order.test.ts` and `PinnedTierOrderTests`, which is the
/// only evidence of parity worth having: an order that "reads the same" is how the
/// two drifted in the first place.
///
/// # JavaScript semantics are part of the rule
///
/// Two string operations are the web's, not Swift's, on purpose:
///  - project identity is EXACT (UTF-16 code units, like a JS `Map` key). Swift's
///    `String ==` treats canonically equivalent spellings as one string, which would
///    merge two projects the console keeps apart;
///  - the case fold of `projectOrder` is JS `toLowerCase()`, which `NSString.lowercased`
///    matches and Swift's `String.lowercased()` does not (it skips the Greek final-sigma
///    rule, so "ΟΔΟΣ" would miss its own entry).
enum PinnedTierOrder {

    /// The three fields the order reads.
    struct Row: Equatable {
        let id: String
        /// `""` = Inbox.
        let project: String
        /// The row's folder (`group_id`), nil when it is in none. An empty id is no
        /// folder, as it is on the web (`if (t.group_id)`).
        let folder: String?
    }

    /// `project` = "By project", `custom` = "Custom order" (the web's `PinnedTierMode`).
    enum Mode: String {
        case project, custom
    }

    /// The tier's row ids in the order the console draws them. `rows` are the tier's rows
    /// in pin order; see the web module for the rule in words.
    static func order(_ rows: [Row], mode: Mode, projectOrder: [String]) -> [String] {
        let grouped = clusterByFolder(rows, sinkFolders: mode == .project)
        return mode == .custom
            ? grouped
            : clusterByProject(grouped, rows: rows, projectOrder: projectOrder)
    }

    /// Same-folder rows made contiguous, anchored at the folder's first member; with
    /// `sinkFolders` every loose row comes first and the folder blocks follow. The web's
    /// `clusterTierByGroup`.
    static func clusterByFolder(_ rows: [Row], sinkFolders: Bool) -> [String] {
        var byFolder: [Exact: [String]] = [:]
        for row in rows {
            guard let folder = folderKey(row) else { continue }
            byFolder[folder, default: []].append(row.id)
        }
        var emitted = Set<Exact>()
        var out: [String] = []
        out.reserveCapacity(rows.count)
        if sinkFolders {
            for row in rows where folderKey(row) == nil { out.append(row.id) }
            for row in rows {
                guard let folder = folderKey(row), !emitted.contains(folder) else { continue }
                emitted.insert(folder)
                out.append(contentsOf: byFolder[folder] ?? [])
            }
            return out
        }
        for row in rows {
            if let folder = folderKey(row) {
                guard !emitted.contains(folder) else { continue }
                emitted.insert(folder)
                out.append(contentsOf: byFolder[folder] ?? [])
            } else {
                out.append(row.id)
            }
        }
        return out
    }

    /// Group an id order into project runs, first appearance first, a contiguous
    /// same-folder run moving as one block; then the projects listed in `projectOrder`
    /// take their listed places ahead of every other one. The web's `clusterTierByProject`.
    static func clusterByProject(_ ids: [String], rows: [Row], projectOrder: [String]) -> [String] {
        // A JS Map built from pairs: a repeated id keeps the LAST row.
        var rowById: [Exact: Row] = [:]
        for row in rows { rowById[Exact(row.id)] = row }

        struct Block { let key: Exact; let ids: [String] }
        var blocks: [Block] = []
        var i = 0
        while i < ids.count {
            guard let row = rowById[Exact(ids[i])] else {
                // An id no row names inherits the previous block's project.
                blocks.append(Block(key: blocks.last?.key ?? Exact(""), ids: [ids[i]]))
                i += 1
                continue
            }
            if let folder = folderKey(row) {
                var run = [ids[i]]
                var j = i + 1
                while j < ids.count,
                      let next = rowById[Exact(ids[j])], folderKey(next) == folder {
                    run.append(ids[j])
                    j += 1
                }
                blocks.append(Block(key: Exact(row.project), ids: run))
                i = j
            } else {
                blocks.append(Block(key: Exact(row.project), ids: [ids[i]]))
                i += 1
            }
        }

        var byKey: [Exact: [String]] = [:]
        var keyOrder: [Exact] = []
        for block in blocks {
            if byKey[block.key] == nil {
                byKey[block.key] = []
                keyOrder.append(block.key)
            }
            byKey[block.key]?.append(contentsOf: block.ids)
        }

        if !projectOrder.isEmpty {
            // `new Map(projectOrder.map(...))`: a name listed twice keeps its LAST index.
            var rank: [Exact: Int] = [:]
            for (index, name) in projectOrder.enumerated() { rank[Exact(jsLowercased(name))] = index }
            // Array.prototype.sort is stable, so the occurrence index is the final
            // tie-break (two keys that fold to one listed name keep their occurrence order).
            keyOrder = keyOrder.enumerated().sorted { a, b in
                let ra = rank[Exact(jsLowercased(a.element.string))]
                let rb = rank[Exact(jsLowercased(b.element.string))]
                switch (ra, rb) {
                case let (x?, y?) where x != y: return x < y
                case (_?, nil): return true
                case (nil, _?): return false
                default: return a.offset < b.offset
                }
            }.map(\.element)
        }
        return keyOrder.flatMap { byKey[$0] ?? [] }
    }

    // MARK: - JavaScript string semantics

    /// A string compared the way a JS `Map` compares keys: by UTF-16 code units.
    struct Exact: Hashable {
        let units: [UInt16]
        let string: String
        init(_ string: String) {
            self.string = string
            self.units = Array(string.utf16)
        }
        static func == (a: Exact, b: Exact) -> Bool { a.units == b.units }
        func hash(into hasher: inout Hasher) { hasher.combine(units) }
    }

    /// JS `String.prototype.toLowerCase()`: the full Unicode mapping with its context
    /// rules, which `NSString.lowercased` implements and `String.lowercased()` does not.
    static func jsLowercased(_ string: String) -> String {
        (string as NSString).lowercased
    }

    private static func folderKey(_ row: Row) -> Exact? {
        guard let folder = row.folder, !folder.isEmpty else { return nil }
        return Exact(folder)
    }
}
