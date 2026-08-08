import Foundation

/// Minimal-edit diff between two row arrays, computed by id + revision.
/// Chat timelines mutate almost exclusively at the TAIL (append rows, reload
/// the live tail, occasionally trim the head when the render cap bites), so
/// the algorithm is anchor-based rather than a general LCS: find the common
/// head prefix / tail suffix by id, treat the middle as delete+insert.
/// O(n) always — never quadratic, whatever the input.
struct TimelineDiff {
    var deletes: [Int] = []           // old indices, ascending
    var inserts: [(Int, TimelineRow)] = [] // new indices, ascending
    var reloads: [(Int, TimelineRow)] = [] // NEW index + new row (same id, changed revision)

    var isEmpty: Bool { deletes.isEmpty && inserts.isEmpty && reloads.isEmpty }
    var changeCount: Int { deletes.count + inserts.count + reloads.count }

    static func compute(old: [TimelineRow], new: [TimelineRow]) -> TimelineDiff {
        var diff = TimelineDiff()

        // Common prefix by id.
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix].id == new[prefix].id {
            if old[prefix].revision != new[prefix].revision
                || old[prefix].height != new[prefix].height {
                diff.reloads.append((prefix, new[prefix]))
            }
            prefix += 1
        }
        // Common suffix by id (not overlapping the prefix).
        var oldEnd = old.count
        var newEnd = new.count
        while oldEnd > prefix, newEnd > prefix, old[oldEnd - 1].id == new[newEnd - 1].id {
            oldEnd -= 1
            newEnd -= 1
        }
        for i in stride(from: oldEnd - 1, through: prefix, by: -1) where i >= prefix {
            diff.deletes.append(i)
        }
        diff.deletes.reverse()
        for i in prefix..<newEnd {
            diff.inserts.append((i, new[i]))
        }
        // Suffix revisions (indices are NEW positions).
        let suffixLen = old.count - oldEnd
        for k in 0..<suffixLen {
            let oldRow = old[oldEnd + k]
            let newRow = new[newEnd + k]
            if oldRow.revision != newRow.revision || oldRow.height != newRow.height {
                diff.reloads.append((newEnd + k, newRow))
            }
        }
        return diff
    }
}
