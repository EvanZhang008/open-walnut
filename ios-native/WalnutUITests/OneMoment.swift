import XCTest

// Frames compared across two element queries are read at two moments: each `.frame` resolves the
// element again. A row that redraws between them (a line added under its text) moves one key and
// not the other in what the test reads (2026-11-27, CI run on iOS 26.5: TalkToWalnutUITests read
// Delete before an automatic retry's "Tried again at" line came and Send Now after it, so a
// stacked row read as Delete above Send Now). A test that compares frames reads them from ONE
// snapshot here.

extension XCUIElementSnapshot {
    /// This node and every node under it, parents before their children.
    var allNodes: [XCUIElementSnapshot] {
        var out: [XCUIElementSnapshot] = []
        var stack: [XCUIElementSnapshot] = [self]
        while let node = stack.popLast() {
            out.append(node)
            stack.append(contentsOf: node.children.reversed())
        }
        return out
    }

    /// The first node with this identifier that is drawn (a closed sheet's ghost has an empty frame).
    func first(id: String) -> XCUIElementSnapshot? {
        allNodes.first { $0.identifier == id && !$0.frame.isEmpty }
    }
}

/// The app's tree at one moment, once every element named in `ids` is drawn, `ready` holds, and
/// those elements read the same frames as in the snapshot taken 0.3 s before; nil if that never
/// happens within `timeout`.
func stillSnapshot(
    _ app: XCUIApplication, ids: [String], timeout: TimeInterval,
    ready: (XCUIElementSnapshot) -> Bool = { _ in true }
) -> XCUIElementSnapshot? {
    let end = Date().addingTimeInterval(timeout)
    var last: [CGRect]?
    while Date() < end {
        if let root = try? app.snapshot(), ready(root) {
            let frames = ids.compactMap { root.first(id: $0)?.frame }
            if frames.count == ids.count {
                if frames == last { return root }
                last = frames
            } else {
                last = nil
            }
        } else {
            last = nil
        }
        // A pause between two reads, not a wait for the work: the loop ends on what it reads.
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    }
    return nil
}
