import Foundation
@testable import Walnut

extension TimelineInput {
    /// The same input with every folded tool run OPENED (the transcript's runs and
    /// the live turn's), so a test about the member rows themselves (a chip's
    /// payload, a reasoning row's excerpt, a row's measured height) sees them laid
    /// out the way a reader who tapped the run does. The fold itself is pinned by
    /// `ToolRunFoldTests`; every other gate asserts on the rows a run opens to.
    func openingAllRuns() -> TimelineInput {
        var copy = self
        for part in TimelineToolRunFold.fold(messages) {
            if case .run(let key, _) = part {
                copy.expandedRowIDs.insert(TimelineToolRunFold.rowID(scope: scope, key: key))
            }
        }
        copy.expandedRowIDs.insert(TimelineScope.namespace(scope, TimelineRowBuilder.liveRunID))
        return copy
    }

    /// The same input with every thought that stands on its own OPENED: each saved
    /// thought's "Thinking" fold line and the live turn's (2026-11-20, a lone thought
    /// is a fold line with its thinking row inside), so a test about the thinking row
    /// itself (its excerpt, its height, its id) sees it under its opened line. The
    /// line itself is pinned by `LoneThoughtFoldTests`.
    func openingAllThoughts() -> TimelineInput {
        var copy = self
        for message in messages where message.kind == .thinking {
            copy.expandedRowIDs.insert(TimelineRowBuilder.thoughtFoldID(scope: scope, messageID: message.id))
        }
        copy.expandedRowIDs.insert(TimelineScope.namespace(scope, TimelineRowBuilder.liveThoughtFoldID))
        return copy
    }
}
