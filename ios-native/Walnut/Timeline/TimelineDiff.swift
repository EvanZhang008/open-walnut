import Foundation

/// Minimal-edit diff between two row arrays: identity by id, "reload me" by
/// revision / height / content digest (see `changed`).
/// Chat timelines mutate almost exclusively at the TAIL (append rows, reload
/// the live tail, occasionally trim the head when the render cap bites), so
/// the algorithm is anchor-based rather than a general LCS: find the common
/// head prefix / tail suffix by id, treat the middle as delete+insert.
/// O(n) always — never quadratic, whatever the input.
struct TimelineDiff {
    var deletes: [Int] = []           // old indices, ascending
    var inserts: [(Int, TimelineRow)] = [] // new indices, ascending
    var reloads: [(Int, TimelineRow)] = [] // NEW index + new row (same id, changed content)

    var isEmpty: Bool { deletes.isEmpty && inserts.isEmpty && reloads.isEmpty }
    var changeCount: Int { deletes.count + inserts.count + reloads.count }

    /// Must this row be handed to its cell again? Revision and height are the
    /// declared change signals, but neither is sufficient on its own: a
    /// same-id row can carry DIFFERENT TEXT at the same revision and the same
    /// height (equal line counts measure equal), which is how a conversation
    /// switch used to leave the previous conversation on screen. `contentKey`
    /// closes that hole and is a single Int compare, so the walk stays O(n).
    private static func changed(_ old: TimelineRow, _ new: TimelineRow) -> Bool {
        old.revision != new.revision
            || old.height != new.height
            || old.contentKey != new.contentKey
    }

    static func compute(old: [TimelineRow], new: [TimelineRow]) -> TimelineDiff {
        var diff = TimelineDiff()

        // Common prefix by id.
        var prefix = 0
        while prefix < old.count, prefix < new.count, old[prefix].id == new[prefix].id {
            if changed(old[prefix], new[prefix]) {
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
            if changed(oldRow, newRow) {
                diff.reloads.append((newEnd + k, newRow))
            }
        }
        return diff
    }
}
