import XCTest
@testable import Walnut

/// The phone's model menu lists the catalog in the MAC's order, weakest to
/// strongest, and says the same rows the Mac says.
///
/// The gate (2026-09-24) found the phone listing the catalog in the CLI's raw
/// order while the Mac's picker sorts it with `sortByModelStrength`
/// (`web/src/utils/model-strength-order.ts`) on the row text
/// `${value} ${resolvedModel ?? ''} ${catalogRowLabel}` (ModelPicker.tsx 630-644).
///
/// Every expected list below was PRODUCED BY THE WEB CODE: the real
/// `sortByModelStrength` and `formatModelName`, imported by a tsx script, over the
/// catalog a Mac's CLI answered on 2026-09-24, plus the web's `current` row
/// (the running model, when no catalog row matches it). A hand-written order would
/// only prove the twin agrees with its author.
@MainActor
final class ModelStrengthOrderTests: XCTestCase {

    private typealias Row = SessionModelOptions.Model

    private static let realCatalog: [(String, String, String)] = [
        ("default", "global.anthropic.claude-opus-5-5[1m]", "Default"),
        ("global.anthropic.claude-fable-5[1m]", "global.anthropic.claude-fable-5[1m]", "Fable"),
        ("global.anthropic.claude-fable-5-1[1m]", "global.anthropic.claude-fable-5-1[1m]", "Fable 5.1"),
        ("global.anthropic.claude-sonnet-5", "global.anthropic.claude-sonnet-5", "Sonnet"),
        ("opus", "global.anthropic.claude-opus-5-5[1m]", "Opus 5.5 (1M context)"),
        ("haiku", "global.anthropic.claude-haiku-4-5-20251001-v1:0", "Haiku"),
        ("gpt-6-astra", "gpt-6-astra", "GPT-6 Astra"),
        ("gpt-6-sol", "gpt-6-sol", "GPT-6 Sol"),
        ("gpt-6-luna", "gpt-6-luna", "GPT-6 Luna"),
        ("gpt-5.6-sol", "gpt-5.6-sol", "GPT-5.6 Sol"),
    ]

    private func catalog(withResolvedModel: Bool = true) -> [Row] {
        Self.realCatalog.map { id, resolved, label in
            Row(id: id, label: label, supportsEffort: nil, supportedEffortLevels: nil,
                resolvedModel: withResolvedModel ? resolved : nil)
        }
    }

    /// "id=title" for a catalog row, "current:title" for the web's current row.
    private func order(_ models: [Row], current: String?) -> [String] {
        ModelCatalogRowLabel.menuRows(models: models, currentModelID: current).map { row in
            row.kind == .current ? "current:\(row.title)" : "\(row.id)=\(row.title)"
        }
    }

    // Web output, verbatim (`tsx web-order.mts`, REAL).
    private static let webRealOrder = [
        "haiku=Haiku 4.5", "gpt-6-luna=GPT-6 Luna", "global.anthropic.claude-sonnet-5=Sonnet 5",
        "gpt-6-astra=GPT-6 Astra", "global.anthropic.claude-fable-5[1m]=Fable 5 1M",
        "global.anthropic.claude-fable-5-1[1m]=Fable 5.1 1M", "gpt-5.6-sol=GPT-5.6 Sol",
        "gpt-6-sol=GPT-6 Sol", "default=Default (Opus 5.5 1M)", "opus=Opus 5.5 1M",
    ]

    func testTheRealCatalogIsListedInTheMacsOrder() {
        XCTAssertEqual(order(catalog(), current: "global.anthropic.claude-fable-5-1[1m]"), Self.webRealOrder)
    }

    /// A primary that predates `resolvedModel` sorts on id + label alone, and the
    /// web's order for it is different (the `default` row loses its "Opus").
    func testAPrimaryWithoutResolvedModelIsListedInTheWebsOrderForIt() {
        XCTAssertEqual(order(catalog(withResolvedModel: false), current: "opus"), [
            "haiku=Haiku", "gpt-6-luna=GPT-6 Luna", "global.anthropic.claude-sonnet-5=Sonnet 5",
            "gpt-6-astra=GPT-6 Astra", "global.anthropic.claude-fable-5[1m]=Fable 5 1M",
            "global.anthropic.claude-fable-5-1[1m]=Fable 5.1 1M", "gpt-5.6-sol=GPT-5.6 Sol",
            "gpt-6-sol=GPT-6 Sol", "opus=Opus 5.5 (1M context)", "default=Default",
        ])
    }

    /// The running model matches no catalog row: the web shows it anyway, as a
    /// checked row named by `shortModelLabel`, sorted among the others by its id.
    func testACurrentModelTheCatalogDoesNotListIsShownInItsPlace() {
        XCTAssertEqual(order(catalog(), current: "global.anthropic.claude-opus-5"), [
            "haiku=Haiku 4.5", "gpt-6-luna=GPT-6 Luna", "global.anthropic.claude-sonnet-5=Sonnet 5",
            "gpt-6-astra=GPT-6 Astra", "global.anthropic.claude-fable-5[1m]=Fable 5 1M",
            "global.anthropic.claude-fable-5-1[1m]=Fable 5.1 1M", "gpt-5.6-sol=GPT-5.6 Sol",
            "gpt-6-sol=GPT-6 Sol", "current:opus-5", "default=Default (Opus 5.5 1M)", "opus=Opus 5.5 1M",
        ])
        XCTAssertEqual(order(catalog(), current: "my-proxy-model"),
                       Self.webRealOrder + ["current:my-proxy-model"],
                       "a name with no known tier goes last, as on the web")

        let rows = ModelCatalogRowLabel.menuRows(models: catalog(), currentModelID: "my-proxy-model")
        XCTAssertEqual(rows.filter(\.checked).map(\.kind), [.current], "exactly one checkmark, on the truth")
    }

    /// Ties, unknown names and the tier table, against the web's own output.
    func testTheOrderingRulesMatchTheWebOnASyntheticCatalog() {
        let synthetic: [(String, String)] = [
            ("zeta-custom", "Zeta"), ("sonnet[1m]", "Sonnet"), ("alpha-custom", "Alpha"),
            ("sonnet", "Sonnet"), ("opus", "Opus"), ("haiku", "Haiku"),
            ("gemini-3-pro", "Gemini 3 Pro"), ("gemini-3-flash", "Gemini 3 Flash"),
            ("gemini-3-flash-lite", "Gemini 3 Flash Lite"), ("gpt-5-mini", "GPT-5 mini"),
            ("gpt-5", "GPT-5"), ("qwen3-max", "Qwen3 Max"), ("claude-opus-4-8", "Opus"),
        ]
        let rows = synthetic.map { Row(id: $0.0, label: $0.1, supportsEffort: nil, supportedEffortLevels: nil) }
        XCTAssertEqual(order(rows, current: "haiku"), [
            "haiku=Haiku", "gemini-3-flash-lite=Gemini 3 Flash Lite", "gemini-3-flash=Gemini 3 Flash",
            "gpt-5-mini=GPT-5 mini", "sonnet=Sonnet", "sonnet[1m]=Sonnet 1M", "gpt-5=GPT-5",
            "gemini-3-pro=Gemini 3 Pro", "opus=Opus", "qwen3-max=Qwen3 Max", "claude-opus-4-8=Opus 4.8",
            "zeta-custom=Zeta", "alpha-custom=Alpha",
        ])
    }

    /// `strengthKey` spot checks, the same fields the web computes.
    func testStrengthKeysMatchTheWeb() {
        typealias Key = ModelStrengthOrder.Key
        XCTAssertEqual(ModelStrengthOrder.key("haiku global.anthropic.claude-haiku-4-5-20251001-v1:0 Haiku 4.5"),
                       Key(tier: 10, versionMajor: 4, versionMinor: 5, context: 0, defaultAlias: 1))
        XCTAssertEqual(ModelStrengthOrder.key("default global.anthropic.claude-opus-5-5[1m] Default (Opus 5.5 1M)"),
                       Key(tier: 70, versionMajor: 5, versionMinor: 5, context: 1, defaultAlias: 0))
        XCTAssertEqual(ModelStrengthOrder.key("gpt-6-astra gpt-6-astra GPT-6 Astra"),
                       Key(tier: 35, versionMajor: 6, versionMinor: 0, context: 0, defaultAlias: 1))
        XCTAssertNil(ModelStrengthOrder.key("my-proxy-model"))
    }

    // MARK: - The composer's menu is built from these rows

    func testTheComposerMenuListsTheRowsInTheMacsOrderWithOneCheckmark() {
        let controls = ComposerControlsModel(
            models: catalog(), currentModelID: "global.anthropic.claude-fable-5-1[1m]", currentEffort: "high",
            writeTarget: .session(id: "s")
        )
        let items = controls.modelMenu.sections.flatMap(\.items)
        XCTAssertEqual(items.map(\.title), Self.webRealOrder.map { String($0.split(separator: "=")[1]) })
        XCTAssertEqual(items.filter(\.checked).map(\.title), ["Fable 5.1 1M"])
        XCTAssertTrue(items.allSatisfy(\.enabled))
        XCTAssertEqual(controls.modelMenu.sections.map(\.title), ["Model"],
                       "one section: models only (effort has its own pill)")
    }

    /// A current model the catalog does not list is shown checked and NOT
    /// pickable, like the web's current row.
    func testTheComposerMenuShowsAnUnlistedCurrentModelAsAnInertCheckedRow() {
        let controls = ComposerControlsModel(
            models: catalog(), currentModelID: "global.anthropic.claude-opus-5", currentEffort: nil
        )
        let current = controls.modelMenu.sections.flatMap(\.items).filter(\.checked)
        XCTAssertEqual(current.map(\.title), ["opus-5"])
        XCTAssertEqual(current.map(\.enabled), [false])
        XCTAssertEqual(current.map(\.choice), [.none])
    }

    /// The runtime id is matched to its row the server's way, so an alias row
    /// gets the checkmark rather than an extra "current" row.
    func testARuntimeIDIsMatchedToItsRowTheServersWay() {
        let rows = catalog()
        XCTAssertEqual(ModelCatalogRowLabel.activeRow(in: rows, for: "global.anthropic.claude-opus-5-5[1m]")?.id,
                       "opus", "a concrete row beats the default alias that shares its resolved model")
        XCTAssertEqual(ModelCatalogRowLabel.activeRow(
            in: rows, for: "global.anthropic.claude-haiku-4-5-20251001")?.id, "haiku",
            "the provider version suffix is ignored")
        XCTAssertEqual(ModelCatalogRowLabel.activeRow(in: rows, for: "GPT-6-SOL")?.id, "gpt-6-sol")
        XCTAssertNil(ModelCatalogRowLabel.activeRow(in: rows, for: "global.anthropic.claude-opus-5"))
    }

    /// The web's `shortModelLabel`, which names the current row.
    func testShortModelLabelMatchesTheWeb() {
        XCTAssertEqual(ModelCatalogRowLabel.shortModelLabel("global.anthropic.claude-opus-5"), "opus-5")
        XCTAssertEqual(ModelCatalogRowLabel.shortModelLabel("global.anthropic.claude-opus-5-5[1m]"), "opus-5-5 1M")
        XCTAssertEqual(ModelCatalogRowLabel.shortModelLabel("global.anthropic.claude-haiku-4-5-20251001-v1:0"),
                       "haiku-4-5-20251001")
        XCTAssertEqual(ModelCatalogRowLabel.shortModelLabel("my-proxy-model"), "my-proxy-model")
    }
}
