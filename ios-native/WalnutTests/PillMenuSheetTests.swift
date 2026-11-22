import XCTest
@testable import Walnut

/// How the "Select model" sheet lays out a pill's menu (`PillMenuSheet.Layout`):
/// the model column, the effort column beside it, and any other section as a list.
///
/// The bug class: a sheet that shows a different set of choices than the pill's
/// state allows (levels for a model without an effort axis, a Retry state
/// rendered as a model list) or that loses the reason a state exists.
@MainActor
final class PillMenuSheetTests: XCTestCase {

    private func model(_ id: String, _ label: String, levels: [String]? = nil) -> SessionModelOptions.Model {
        SessionModelOptions.Model(id: id, label: label, supportsEffort: levels != nil, supportedEffortLevels: levels)
    }

    /// A catalog with an effort axis: the models are the left column, the levels
    /// the right one, each with the current row checked; nothing else is a list.
    func testTheModelsAndTheLevelsAreTheTwoColumns() throws {
        let controls = ComposerControlsModel(
            models: [
                model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"]),
                model("global.anthropic.claude-haiku-4-5", "Haiku"),
            ],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertEqual(layout.lists, [], "a list beside the columns")
        let models = try XCTUnwrap(layout.models)
        XCTAssertTrue(PillMenuSheet.Layout.isModelList(models))
        XCTAssertEqual(models.items.filter(\.checked).count, 1)
        XCTAssertEqual(layout.effort?.items.map(\.choice), [.effort("low"), .effort("high"), .effort("max")])
        XCTAssertEqual(layout.effort?.items.filter(\.checked).map(\.title), ["High"])
    }

    /// An unreported level checks no level: none was set, the CLI's default runs.
    func testAnUnreportedLevelChecksNoLevel() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", levels: ["low", "high"])], currentModelID: "a", currentEffort: nil
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertEqual(layout.effort?.items.map(\.title), ["Low", "High"])
        XCTAssertEqual(layout.effort?.items.filter(\.checked), [])
    }

    /// No effort axis: no Effort column at all (the models take the card), never
    /// a column of levels it rejects.
    func testAModelWithoutEffortHasNoEffortColumn() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-haiku-4-5", "Haiku")],
            currentModelID: "global.anthropic.claude-haiku-4-5", currentEffort: nil
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertNil(layout.effort)
        XCTAssertEqual(layout.models?.items.map(\.title).isEmpty, false)
        XCTAssertEqual(layout.lists, [])
    }

    /// The Mac away: the sheet is the reason and the Retry, headed by the reason
    /// (it is not a model list, so its title shows).
    func testTheRetryStateIsItsReasonAndRetry() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", levels: ["low"])], currentModelID: "a", currentEffort: "low",
            unreachable: true, statusNote: ComposerControlsModel.unreachableNote
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertNil(layout.effort, "levels with nowhere to be written")
        XCTAssertNil(layout.models, "models with nowhere to be written")
        XCTAssertEqual(layout.lists.flatMap(\.items).map(\.choice), [.retry])
        XCTAssertFalse(PillMenuSheet.Layout.isModelList(layout.lists[0]))
        XCTAssertEqual(layout.lists[0].title, ComposerControlsModel.unreachableNote)
    }

    /// A demo session launched from the draft's "Sonnet" runs as the catalog's
    /// Sonnet, so its sheet checks that row; kept as the alias, the sheet listed
    /// an unknown, greyed "sonnet" row above "Sonnet 5.5".
    func testADemoDraftAliasLaunchesAsACatalogRow() {
        XCTAssertEqual(DemoServer.launchModel("sonnet"), "claude-sonnet-5-5")
        XCTAssertEqual(DemoServer.launchModel(nil), DemoFixtures.mainModel)
        XCTAssertEqual(DemoServer.launchModel("haiku"), DemoFixtures.fastModel)
        let rows = ModelCatalogRowLabel.menuRows(
            models: DemoFixtures.models, currentModelID: DemoServer.launchModel("sonnet")
        )
        XCTAssertEqual(rows.filter(\.checked).map(\.title), ["Sonnet 5.5"])
        XCTAssertFalse(rows.contains { $0.kind == .current }, "an unlisted current row")
    }

    /// The new-session draft's menu is the same two columns (its effort Default until picked).
    func testTheDraftMenuIsTheTwoColumns() {
        let layout = PillMenuSheet.Layout(NewSessionChatView.modelMenu(selected: "sonnet"))
        XCTAssertEqual(layout.effort?.items.filter(\.checked).map(\.title), ["Default"])
        let low = PillMenuSheet.Layout(NewSessionChatView.modelMenu(selected: "sonnet", effort: "low"))
        XCTAssertEqual(low.effort?.items.filter(\.checked).map(\.title), ["Low"])
        XCTAssertEqual(layout.models?.items.map(\.title), ["Default", "Opus", "Sonnet", "Haiku"])
        XCTAssertEqual(layout.models?.items.filter(\.checked).map(\.title), ["Sonnet"])
        XCTAssertEqual(layout.lists, [])
    }

    /// A model list whose current model is not in the catalog keeps its unlisted
    /// row in the column, disabled, and stays the model column (not a list).
    func testAnUnlistedCurrentModelStaysInTheModelColumn() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", levels: ["low"])], currentModelID: "proxy-model-x", currentEffort: nil
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertEqual(layout.models?.items.contains { !$0.enabled && $0.checked }, true, "the unlisted current row")
        XCTAssertEqual(layout.lists, [])
    }
}
