import XCTest
@testable import Walnut

/// How the "Select model" sheet lays out a pill's menu (`PillMenuSheet.Layout`).
///
/// The bug class: a sheet that shows a different set of choices than the pill's
/// state allows (levels for a model without an effort axis, a Retry state
/// rendered as a model list) or that loses the reason a state exists.
@MainActor
final class PillMenuSheetTests: XCTestCase {

    private func model(_ id: String, _ label: String, levels: [String]? = nil) -> SessionModelOptions.Model {
        SessionModelOptions.Model(id: id, label: label, supportsEffort: levels != nil, supportedEffortLevels: levels)
    }

    /// A catalog with an effort axis: the models are the list, the levels are
    /// the one Effort row, which names the current level.
    func testTheModelsAreTheListAndTheLevelsAreTheEffortRow() {
        let controls = ComposerControlsModel(
            models: [
                model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["low", "high", "max"]),
                model("global.anthropic.claude-haiku-4-5", "Haiku"),
            ],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertEqual(layout.lists.count, 1)
        XCTAssertTrue(PillMenuSheet.Layout.isModelList(layout.lists[0]))
        XCTAssertEqual(layout.lists[0].items.filter(\.checked).count, 1)
        XCTAssertEqual(layout.effort?.items.map(\.choice), [.effort("low"), .effort("high"), .effort("max")])
        XCTAssertEqual(layout.effortValue, "High")
    }

    /// An unreported level reads the CLI's default rather than a level nobody set.
    func testAnUnreportedLevelReadsDefault() {
        let controls = ComposerControlsModel(
            models: [model("a", "A", levels: ["low", "high"])], currentModelID: "a", currentEffort: nil
        )
        XCTAssertEqual(PillMenuSheet.Layout(controls.combinedMenu).effortValue, "Default")
    }

    /// No effort axis: no Effort row at all, never a row of levels it rejects.
    func testAModelWithoutEffortHasNoEffortRow() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-haiku-4-5", "Haiku")],
            currentModelID: "global.anthropic.claude-haiku-4-5", currentEffort: nil
        )
        let layout = PillMenuSheet.Layout(controls.combinedMenu)
        XCTAssertNil(layout.effort)
        XCTAssertNil(layout.effortValue)
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

    /// The new-session draft's menu (models only) is one list with no Effort row.
    func testTheDraftMenuIsOneModelList() {
        let layout = PillMenuSheet.Layout(NewSessionChatView.modelMenu(selected: "sonnet"))
        XCTAssertNil(layout.effort)
        XCTAssertEqual(layout.lists.flatMap(\.items).map(\.title), ["Default", "Opus", "Sonnet", "Haiku"])
        XCTAssertEqual(layout.lists.flatMap(\.items).filter(\.checked).map(\.title), ["Sonnet"])
    }
}
