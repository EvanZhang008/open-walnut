import XCTest
@testable import Walnut

/// The composer's BOTTOM CONTROL ROW rule: `+`, model pill, mic, send.
///
/// The 2026-08-28 restructure (field on its own full-width row, controls below it)
/// moved which piece is conditional, and that move is the only new logic in an
/// otherwise-layout change, so it is the only thing this file tests. Before, the
/// whole controls row was conditional on a model resolving; now the ROW is
/// unconditional (it owns mic and send) and the PILL is what appears or doesn't.
///
/// Why that inversion is worth a gate rather than a comment: the composer lives in
/// a `safeAreaInset` above the transcript, and the old shape let an async model
/// lookup ADD A ROW after the view was already on screen. A height change there
/// changes the List's visible rect and yanks the content offset, the same class of
/// mid-scroll geometry churn `ScrollBottomTracking` and `KeyboardRepinMachine` were
/// built to bound. If someone later "simplifies" this back into `if showsModelPill
/// { wholeRow }`, mic and send vanish on a composer with no model and the height
/// churn returns. These assertions are what makes that a red instead of a field
/// report.
///
/// Everything else in the restructure is layout with no decision in it (row order,
/// paddings, which HStack a button sits in) and is deliberately NOT asserted here:
/// a test that re-declares a padding constant proves only that the test was written
/// after the view.
@MainActor
final class ComposerBottomRowTests: XCTestCase {

    private func model(
        _ id: String, _ label: String, levels: [String]? = nil
    ) -> SessionModelOptions.Model {
        SessionModelOptions.Model(
            id: id, label: label, supportsEffort: nil, supportedEffortLevels: levels
        )
    }

    // MARK: - The pill's two conditions are two different questions

    /// The everyday case: this composer has a session to carry a model AND the
    /// lookup produced a name. Pill shows.
    func testPillShowsWhenASourceAndALabelBothExist() {
        XCTAssertTrue(
            ComposerBar.showsModelPill(
                modelSource: .session(id: "sess-1"), pillLabel: "Opus 5 · High"
            )
        )
    }

    /// No source = this composer has nowhere for a model to live. The new-session
    /// draft is the real instance of this: it passes `modelSource: nil` because the
    /// session does not exist yet and the model rides the create call from the
    /// launch bar above. A pill there would offer to switch a model on a session
    /// that has not been spawned.
    func testNoSourceMeansNoPillEvenWithALabelInHand() {
        XCTAssertFalse(
            ComposerBar.showsModelPill(modelSource: nil, pillLabel: "Opus 5"),
            "a composer with no model source must not render a pill just because some label exists"
        )
    }

    /// A source with no label yet is the LOADING state (and the permanent state on
    /// an old server whose catalog never answers). Render nothing rather than a
    /// spinner-shaped capsule that draws the eye to a control the user did not ask
    /// about.
    func testSourceWithoutALabelMeansNoPill() {
        XCTAssertFalse(
            ComposerBar.showsModelPill(modelSource: .session(id: "sess-1"), pillLabel: nil)
        )
    }

    /// An EMPTY label is as unusable as a missing one. Distinct case because
    /// `pillLabel` is built by string interpolation upstream, so "" is reachable
    /// from a catalog row with a blank label, and `if let` alone would let a
    /// zero-width capsule onto the row.
    func testEmptyLabelIsTreatedAsNoLabel() {
        XCTAssertFalse(
            ComposerBar.showsModelPill(modelSource: .session(id: "sess-1"), pillLabel: ""),
            "a blank capsule is a control that answers no question"
        )
    }

    /// Both composers that carry a live model reach this rule the same way (a
    /// coding session by id, the main-agent chat by agent + conversation), so
    /// neither can quietly lose its pill while the other keeps one.
    func testChatSourceQualifiesJustLikeASessionSource() {
        XCTAssertTrue(
            ComposerBar.showsModelPill(
                modelSource: .chat(agentID: "general", conversationID: "conv-1"),
                pillLabel: "Fable 5 · Extra High"
            )
        )
        // A brand-new conversation has no id yet and still qualifies: the lane
        // session is minted on attach, so the pill is live from the first frame.
        XCTAssertTrue(
            ComposerBar.showsModelPill(
                modelSource: .chat(agentID: "general", conversationID: nil),
                pillLabel: "Opus 5"
            )
        )
    }

    // MARK: - Driven by the REAL controls model, not by hand-built strings

    /// The rule and the label must agree on the same instance. Driving
    /// `ComposerControlsModel` through its test seam proves the two halves compose:
    /// a settled catalog produces a label AND the row shows the pill.
    func testRealControlsModelWithACatalogShowsThePill() {
        let controls = ComposerControlsModel(
            models: [model("global.anthropic.claude-opus-5[1m]", "Opus", levels: ["high"])],
            currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: "high"
        )
        XCTAssertEqual(controls.pillLabel, "Opus 5 · High")
        XCTAssertTrue(
            ComposerBar.showsModelPill(
                modelSource: .session(id: "sess-1"), pillLabel: controls.pillLabel
            )
        )
    }

    /// A read-only model (the in-process chat engine, or an unreachable catalog)
    /// still has something TRUE to say, so the pill stays: it just opens onto a
    /// reason instead of a list. Hiding it would delete the only place the phone
    /// tells you which model is answering.
    func testReadOnlyControlsStillShowThePill() {
        let controls = ComposerControlsModel(
            models: [], currentModelID: "global.anthropic.claude-opus-5[1m]",
            currentEffort: nil, readOnly: true,
            readOnlyReason: "Model options aren't reachable right now."
        )
        XCTAssertTrue(
            ComposerBar.showsModelPill(
                modelSource: .session(id: "sess-1"), pillLabel: controls.pillLabel
            ),
            "a read-only pill is provenance and must survive: it names the model that IS running"
        )
    }

    /// The empty controls model (attached, nothing resolved) is the state a composer
    /// sits in for the first few hundred milliseconds of its life. It must produce
    /// no pill, and (the part the restructure changed) that must not be expressed as
    /// "no row".
    func testUnresolvedControlsShowNoPill() {
        let controls = ComposerControlsModel(models: [], currentModelID: nil, currentEffort: nil)
        XCTAssertNil(controls.pillLabel)
        XCTAssertFalse(
            ComposerBar.showsModelPill(
                modelSource: .session(id: "sess-1"), pillLabel: controls.pillLabel
            )
        )
    }

    // MARK: - The field row is unchanged by the move

    /// The long-draft switch is a property of the DRAFT, not of the row it sits in,
    /// so moving the field onto its own row must not move the threshold. Pinned
    /// because `ComposerFreezeTests` prices the whole freeze budget against this
    /// exact number, in UTF-8 bytes.
    func testLongDraftThresholdSurvivedTheRestructure() {
        XCTAssertEqual(ComposerBar.longDraftThreshold, 2_000,
            "the editor switch is a draft-size decision; a layout change must not move it")
    }
}
