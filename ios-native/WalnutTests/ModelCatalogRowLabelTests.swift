import XCTest
@testable import Walnut

/// The phone's model menu rows must read EXACTLY as the Mac's picker reads them.
///
/// The user's ask is literally "whatever the Mac shows, the phone shows". Before
/// this, the same catalog read "Fable", "Opus 5.5 (1M context)", "Haiku" on the
/// phone and "Fable 5 1M", "Opus 5.5 1M", "Haiku 4.5" on the Mac, because the
/// phone printed the catalog's bare `label` while the web derives a versioned
/// name (`catalogRowLabel` over `formatModelName`).
///
/// Every expected string below was PRODUCED BY THE WEB CODE, not written by hand:
/// `web/src/utils/model-name.ts`'s `formatModelName` run through a verbatim copy of
/// `catalogRowLabel` over the real catalog a Mac's CLI answered on 2026-09-24. A
/// hand-written expectation would only prove the twin agrees with its author.
@MainActor
final class ModelCatalogRowLabelTests: XCTestCase {

    private typealias Row = SessionModelOptions.Model

    /// (id, resolvedModel, catalog label) exactly as the CLI answered, in its order.
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

    /// What the web's `catalogRowLabel` returns for each row WITH `resolvedModel`.
    private static let webLabels = [
        "Default (Opus 5.5 1M)", "Fable 5 1M", "Fable 5.1 1M", "Sonnet 5", "Opus 5.5 1M",
        "Haiku 4.5", "GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Sol",
    ]

    /// …and WITHOUT it (a primary that predates the field): alias rows keep their
    /// catalog label, versioned ids keep their version.
    private static let webLabelsWithoutResolvedModel = [
        "Default", "Fable 5 1M", "Fable 5.1 1M", "Sonnet 5", "Opus 5.5 (1M context)",
        "Haiku", "GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Sol",
    ]

    private func rows(withResolvedModel: Bool) -> [Row] {
        Self.realCatalog.map { id, resolved, label in
            Row(id: id, label: label, supportsEffort: nil, supportedEffortLevels: nil,
                resolvedModel: withResolvedModel ? resolved : nil)
        }
    }

    func testTheRealCatalogReadsExactlyAsTheWebPickerReadsIt() {
        XCTAssertEqual(rows(withResolvedModel: true).map(ModelCatalogRowLabel.label(for:)), Self.webLabels)
    }

    func testAPrimaryWithoutResolvedModelFallsBackToTheWebRuleOverTheId() {
        XCTAssertEqual(
            rows(withResolvedModel: false).map(ModelCatalogRowLabel.label(for:)),
            Self.webLabelsWithoutResolvedModel
        )
    }

    /// `formatModelName` outputs, including the web's quirks (a dated id reads
    /// "Opus 4.20250514" there, so it must here too: a twin, not an improvement).
    func testFormatModelNameMatchesTheWebForEveryShape() {
        let golden: [(String, String)] = [
            ("global.anthropic.claude-opus-5-5[1m]", "Opus 5.5 1M"),
            ("global.anthropic.claude-fable-5[1m]", "Fable 5 1M"),
            ("global.anthropic.claude-sonnet-5", "Sonnet 5"),
            ("global.anthropic.claude-haiku-4-5-20251001-v1:0", "Haiku 4.5"),
            ("global.anthropic.claude-opus-4-20250514", "Opus 4.20250514"),
            ("claude-3-5-sonnet-20241022", "Sonnet 20241022"),
            ("sonnet[1m]", "Sonnet 1M"),
            ("OPUS", "Opus"),
            ("fable", "Fable"),
            ("claude-opus-4-6-v1[1m]", "Opus 4.6 1M"),
            ("global.anthropic.claude-mythos-1", "global.anthropic.claude-mythos-1"),
            ("gpt-6-astra", "GPT-6 Astra"),
            ("gpt-5.6-sol", "GPT-5.6 Sol"),
            ("Default", "Default"),
            ("", ""),
        ]
        for (id, expected) in golden {
            XCTAssertEqual(ModelCatalogRowLabel.formatModelName(id), expected, "formatModelName(\(id))")
        }
        XCTAssertEqual(ModelCatalogRowLabel.formatModelName(nil), "")
    }

    /// Why this is its own twin instead of reusing the pill's name function: the
    /// two disagree on exactly the rows the user looks at.
    func testShortModelNameIsNotATwinOfFormatModelName() {
        XCTAssertEqual(WalnutSession.shortModelName("global.anthropic.claude-fable-5-1[1m]"), "Fable 5.1")
        XCTAssertEqual(ModelCatalogRowLabel.formatModelName("global.anthropic.claude-fable-5-1[1m]"), "Fable 5.1 1M")
    }

    /// A `default` row with no derivable version and an empty label still says
    /// something (the web's `displayName || 'Default'`).
    func testADefaultRowWithNothingToDeriveSaysDefault() {
        let row = Row(id: "default", label: "", supportsEffort: nil, supportedEffortLevels: nil)
        XCTAssertEqual(ModelCatalogRowLabel.label(for: row), "Default")
    }

    // MARK: - The pill agrees with the checked row

    /// The real catalog with its real effort axes (rows the CLI reports no effort
    /// for carry none, like haiku and the smaller GPT rows).
    private func realRows(withResolvedModel: Bool) -> [Row] {
        let levels = ["low", "medium", "high", "xhigh", "max"]
        let noEffort: Set<String> = ["haiku", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]
        return Self.realCatalog.map { id, resolved, label in
            let hasEffort = !noEffort.contains(id)
            return Row(id: id, label: label, supportsEffort: hasEffort ? true : nil,
                       supportedEffortLevels: hasEffort ? levels : nil,
                       resolvedModel: withResolvedModel ? resolved : nil)
        }
    }

    /// What the composer row says: the model pill, then the effort pill if any.
    private func pill(selecting id: String, withResolvedModel: Bool) -> String? {
        let controls = ComposerControlsModel(
            models: realRows(withResolvedModel: withResolvedModel),
            currentModelID: id, currentEffort: "high"
        )
        guard let name = controls.pillLabel else { return nil }
        return controls.effortPillLabel.map { "\(name) · \($0)" } ?? name
    }

    /// Selecting the `opus` alias used to put "Opus · High" on the pill beside a
    /// checked "Opus 5.5 1M" row. The pill reads `resolvedModel` first now.
    func testThePillNamesTheResolvedModelOfTheSelectedRow() {
        XCTAssertEqual(pill(selecting: "opus", withResolvedModel: true), "Opus 5.5 · High")
        XCTAssertEqual(pill(selecting: "default", withResolvedModel: true), "Opus 5.5 · High",
                       "the default row resolves to Opus 5.5, as its row says")
        XCTAssertEqual(pill(selecting: "haiku", withResolvedModel: true), "Haiku 4.5",
                       "no effort axis, so no effort pill")
        XCTAssertEqual(pill(selecting: "global.anthropic.claude-fable-5-1[1m]", withResolvedModel: true),
                       "Fable 5.1 · High")
        XCTAssertEqual(pill(selecting: "gpt-6-astra", withResolvedModel: true), "GPT-6 Astra · High",
                       "nothing versioned to derive: the catalog label, as before")
    }

    /// A primary that predates `resolvedModel`: the pill is exactly what it was.
    func testWithoutResolvedModelThePillIsUnchanged() {
        XCTAssertEqual(pill(selecting: "opus", withResolvedModel: false), "Opus · High")
        XCTAssertEqual(pill(selecting: "default", withResolvedModel: false), "Default · High")
        XCTAssertEqual(pill(selecting: "haiku", withResolvedModel: false), "Haiku")
        XCTAssertEqual(pill(selecting: "global.anthropic.claude-fable-5-1[1m]", withResolvedModel: false),
                       "Fable 5.1 · High")
        XCTAssertEqual(pill(selecting: "gpt-6-astra", withResolvedModel: false), "GPT-6 Astra · High")
    }

    // MARK: - Decoding (additive)

    func testModelOptionsDecodeResolvedModelWhenPresentAndNilWhenAbsent() throws {
        let json = """
        {"models":[
          {"id":"opus","label":"Opus 5.5 (1M context)","resolvedModel":"global.anthropic.claude-opus-5-5[1m]",
           "supportsEffort":true,"supportedEffortLevels":["high","max"]},
          {"id":"gpt-6-luna","label":"GPT-6 Luna"}
         ],"current":"opus","currentEffort":"high"}
        """
        let options = try JSONDecoder().decode(SessionModelOptions.self, from: Data(json.utf8))
        XCTAssertEqual(options.models[0].resolvedModel, "global.anthropic.claude-opus-5-5[1m]")
        XCTAssertNil(options.models[1].resolvedModel, "an old primary's row decodes with no resolved model")
        XCTAssertEqual(options.models.map(ModelCatalogRowLabel.label(for:)), ["Opus 5.5 1M", "GPT-6 Luna"])
    }
}
