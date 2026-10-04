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
}
