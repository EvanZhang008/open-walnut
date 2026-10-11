import Foundation

/// Which board groups are folded down to their heading, and what the board draws for it.
///
/// A group is the board's TOP level: a tier band under tier grouping, a whole project
/// (its loose rows and every folder band under it) under project grouping. Folding a
/// project folds its folders with it, so "collapse all" leaves one heading per project
/// and the board reads as an outline the user can scan, which is what it is for (the
/// user: one key collapses it all, which makes things easier to find).
///
/// Pure, so the rules are tested without a view (`BoardCollapseTests`).
enum BoardCollapse {

    /// The group a band belongs to: its project for a folder band, itself otherwise.
    static func groupKey(_ band: BoardBand) -> String {
        band.nest?.projectBandId ?? band.bandId
    }

    /// The groups on screen, in board order, each once.
    static func groupKeys(_ bands: [BoardBand]) -> [String] {
        var seen = Set<String>()
        return bands.map(groupKey).filter { seen.insert($0).inserted }
    }

    /// One band as the list draws it.
    struct Entry: Identifiable, Equatable {
        let band: BoardBand
        /// Folded: draw the group's heading only, no rows.
        let collapsed: Bool
        /// Rows the folded group holds across all of its bands, for the heading's count.
        let groupCount: Int

        var id: String { band.bandId }
    }

    /// What to draw. A folded group keeps its FIRST band (the one that draws the group's
    /// heading: the tier band, the project's loose band, or the folder band that leads the
    /// project) and drops the rest of its bands.
    ///
    /// - Parameter collapsed: the folded group keys. Pass `[]` while a search is live: a
    ///   hit hidden inside a folded group would read as "no match".
    static func entries(_ bands: [BoardBand], collapsed: Set<String>) -> [Entry] {
        guard !collapsed.isEmpty else {
            return bands.map { Entry(band: $0, collapsed: false, groupCount: $0.count) }
        }
        var counts: [String: Int] = [:]
        for band in bands { counts[groupKey(band), default: 0] += band.count }
        var drawn = Set<String>()
        var out: [Entry] = []
        for band in bands {
            let key = groupKey(band)
            guard collapsed.contains(key) else {
                out.append(Entry(band: band, collapsed: false, groupCount: band.count))
                continue
            }
            guard drawn.insert(key).inserted else { continue }
            out.append(Entry(band: band, collapsed: true, groupCount: counts[key] ?? band.count))
        }
        return out
    }

    /// Every group on screen is folded (so the board's button offers "Expand all").
    static func allCollapsed(_ bands: [BoardBand], collapsed: Set<String>) -> Bool {
        let keys = groupKeys(bands)
        return !keys.isEmpty && keys.allSatisfy(collapsed.contains)
    }

    /// The one button: fold every group on screen, or unfold them all when they already
    /// are. Groups that are not on screen keep whatever the user left them as.
    static func togglingAll(_ bands: [BoardBand], collapsed: Set<String>) -> Set<String> {
        let keys = groupKeys(bands)
        if allCollapsed(bands, collapsed: collapsed) {
            return collapsed.subtracting(keys)
        }
        return collapsed.union(keys)
    }

    static func toggling(_ key: String, in collapsed: Set<String>) -> Set<String> {
        var next = collapsed
        if next.remove(key) == nil { next.insert(key) }
        return next
    }

    /// Is `taskId` a row of these bands?
    static func contains(taskId: String, in bands: [BoardBand]) -> Bool {
        bands.contains { band in band.rows.contains { $0.task?.id == taskId } }
    }

    /// The folds left once the group holding `taskId` is opened: a row just made (a todo
    /// saved from the `+` page) is one the user went to the board to see.
    static func unfolding(taskId: String, in bands: [BoardBand], collapsed: Set<String>) -> Set<String> {
        guard !collapsed.isEmpty,
              let band = bands.first(where: { band in band.rows.contains { $0.task?.id == taskId } })
        else { return collapsed }
        return collapsed.subtracting([groupKey(band)])
    }

    // MARK: - Persistence (@AppStorage holds a string)

    static let storageKey = "tasks.board.collapsedGroups"

    static func decode(_ raw: String) -> Set<String> {
        guard let data = raw.data(using: .utf8),
              let keys = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(keys)
    }

    static func encode(_ keys: Set<String>) -> String {
        guard !keys.isEmpty, let data = try? JSONEncoder().encode(keys.sorted()) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
