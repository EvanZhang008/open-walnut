import XCTest
@testable import Walnut

/// Gates for whether a rich reply can be READ and TAPPED on the phone.
///
/// The incident behind the file under test: `body { color: var(--fg) }` plus a dark
/// `--fg` of #F5F5F7 meant that a card which set a light background and no `color`
/// painted near-white on near-white. The UI gate measured 1.02:1 to 1.05:1 contrast
/// against WCAG's 4.5:1 body minimum, 15 of 20 table cells unreadable, and 16 of 25
/// real rich messages (64%) carrying at least one such block — and rich output is the
/// DEFAULT reply style, so dark mode was worse off with the feature than without it.
///
/// Every ratio here is COMPUTED from the colours the document actually carries, never
/// hardcoded: a test that asserts a literal hex would still pass after someone
/// changed the palette to something unreadable.
final class RichHTMLContrastTests: XCTestCase {

    /// WCAG AA for body text.
    private let bodyMinimum = 4.5

    // MARK: - Helpers

    private func paired(_ body: String, _ palette: RichHTMLPalette) -> String {
        RichHTMLContrast.pairTextColours(in: body, palette: palette)
    }

    private func document(_ body: String, _ palette: RichHTMLPalette) -> String {
        RichHTMLDocument.page(body: body, palette: palette, kind: .content)
    }

    /// The colour the pass paired with `background`, read back OUT of the markup, so
    /// the assertion is about what WebKit is handed rather than what the code meant.
    private func ink(pairedWith background: String, in html: String) -> String? {
        guard let hit = html.range(of: background + ";color:") else { return nil }
        let value = html[hit.upperBound...].prefix {
            $0 != "\"" && $0 != "'" && $0 != ";" && $0 != "}" && !$0.isWhitespace
        }
        return value.isEmpty ? nil : String(value)
    }

    /// Every declaration a block carries after `marker`, read back out of the markup.
    /// A repainted block declares a whole PALETTE, not one colour, and the tokens are
    /// what the app's own `var(--…)` CSS resolves against — so the tests read the
    /// tokens WebKit will resolve rather than trusting the ink alone.
    private func declarations(after marker: String, in html: String) -> [String: String] {
        guard let hit = html.range(of: marker) else { return [:] }
        let rest = html[hit.upperBound...].prefix { $0 != "\"" && $0 != "'" && $0 != "}" }
        var out: [String: String] = [:]
        for part in rest.split(separator: ";") {
            let bits = part.split(separator: ":", maxSplits: 1)
            guard bits.count == 2 else { continue }
            out[bits[0].trimmingCharacters(in: .whitespaces)] =
                bits[1].trimmingCharacters(in: .whitespaces)
        }
        return out
    }

    /// The `--x: y` pairs the document declares on `:root`.
    private func rootTokens(_ palette: RichHTMLPalette) -> [String: String] {
        let page = document("", palette)
        guard let start = page.range(of: ":root {"),
              let end = page.range(of: "}", range: start.upperBound..<page.endIndex) else { return [:] }
        var out: [String: String] = [:]
        for line in page[start.upperBound..<end.lowerBound].split(separator: ";") {
            let bits = line.split(separator: ":", maxSplits: 1)
            guard bits.count == 2 else { continue }
            let name = bits[0].trimmingCharacters(in: .whitespacesAndNewlines)
            guard name.hasPrefix("--") else { continue }
            out[name] = bits[1].trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return out
    }

    private func ratio(_ a: String, _ b: String) -> Double {
        guard let value = RichHTMLContrast.contrastRatio(a, b) else {
            XCTFail("\(a) / \(b) is not a colour pair this file can judge")
            return 0
        }
        return value
    }

    /// The ratio between two declarations of the same block, failing loudly when one
    /// of them was never written.
    private func ratio(_ a: String?, _ b: String?, _ what: String) -> Double {
        guard let a, let b else {
            XCTFail("\(what): a repainted block did not declare both ends (\(a ?? "nil") / \(b ?? "nil"))")
            return 0
        }
        return ratio(a, b)
    }

    // MARK: - The measured failure

    /// The gate's real case: a `<tr>` with a light background and no colour, in the
    /// dark palette. The row must come out carrying an ink that clears the body
    /// minimum against that background.
    ///
    /// Reverting the pass puts the reader back at the measured 1.02:1 — the
    /// precondition asserts that, so this test cannot pass by accident on a palette
    /// where the bug never existed.
    func testALightBackgroundInTheDarkPaletteIsPairedWithReadableInk() {
        let body = "<table><tr style=\"background:#fff5f5\"><td>Failed</td></tr></table>"

        // Precondition: inheritance really is what the gate measured.
        let inherited = ratio("#fff5f5", RichHTMLPalette.dark.fg)
        XCTAssertLessThan(inherited, 1.1,
                          "fixture no longer reproduces the incident (inherited ink is \(inherited):1)")

        let html = document(body, .dark)
        guard let ink = ink(pairedWith: "background:#fff5f5", in: html) else {
            return XCTFail("no colour was paired with the row's background:\n\(html)")
        }
        XCTAssertGreaterThanOrEqual(ratio("#fff5f5", ink), bodyMinimum,
                                    "paired \(ink) reads at \(ratio("#fff5f5", ink)):1 on #fff5f5")
        // The ink is one the app actually uses, not an invented black.
        XCTAssertEqual(ink, RichHTMLPalette.light.fg)
        XCTAssertTrue(html.contains("<td>Failed</td>"), "the row's content was rewritten")
    }

    /// Same defect through the other three ways a model writes a colour: a named
    /// colour, a functional colour, and a hex with an alpha channel.
    ///
    /// Reverting the parser to hex-only leaves `background:whitesmoke` — which the
    /// gate found in real replies — unreadable while looking fixed.
    func testEveryColourNotationAModelWritesIsPaired() {
        for background in ["whitesmoke", "#f0f0f0", "#eee", "rgb(240,240,240)",
                           "rgb(240 240 240)", "#f0f0f0ff", "rgba(240,240,240,1)"] {
            let html = paired("<td style=\"background:\(background)\">3 failed</td>", .dark)
            guard let ink = ink(pairedWith: "background:\(background)", in: html) else {
                return XCTFail("\(background) was left unpaired: \(html)")
            }
            XCTAssertGreaterThanOrEqual(ratio(background, ink), bodyMinimum,
                                        "\(background) + \(ink) reads at \(ratio(background, ink)):1")
        }
    }

    /// The mirror of the same bug, and the reason the rule is symmetric: an author
    /// DARK background under the light palette inherits the light palette's near-black.
    ///
    /// Reverting to a dark-mode-only pass leaves a dark panel in light mode reading
    /// at the same ~1:1 it always did, and leaves two rules to reason about instead
    /// of one.
    func testADarkBackgroundInTheLightPaletteIsPairedWithLightInk() {
        let background = "#1f2933"
        XCTAssertLessThan(ratio(background, RichHTMLPalette.light.fg), 1.6,
                          "fixture must actually be unreadable under the light palette")

        let html = paired("<div style=\"background:\(background)\">Offline</div>", .light)
        guard let ink = ink(pairedWith: "background:\(background)", in: html) else {
            return XCTFail("the mirror case was left unpaired: \(html)")
        }
        XCTAssertEqual(ink, RichHTMLPalette.dark.fg)
        XCTAssertGreaterThanOrEqual(ratio(background, ink), bodyMinimum)
    }

    // MARK: - A repainted block is a SURFACE, not a text colour

    /// The second gate round's regression: pairing appended `color` and nothing else,
    /// so the app's OWN chips — `code`/`pre`, styled `background: var(--bg-secondary)`
    /// in the base CSS — kept the DOCUMENT's chip grey inside a card that had just been
    /// given the other palette's ink. `#1C1C1E` under `#1D1D1F`: 1.01:1, measured on
    /// device, on 26 text nodes of real replies and on the load-bearing words
    /// (`<code>stat</code>`, a `/tmp/…` path, a `kubectl` invocation).
    ///
    /// A `var(--…)` background is deliberately never PAIRED (a token already flips with
    /// the scheme), so the only thing that can fix it is the token itself: a repainted
    /// block redeclares the whole matching palette, and custom properties inherit.
    ///
    /// Reverting to `;color:<ink>` alone restores exactly 1.01:1 here while every
    /// round-one test still passes — which is how it shipped.
    func testTheAppsOwnChipsInsideARepaintedCardAreReadable() {
        let body = "<div style=\"background:#fff5f5\">Run <code>stat</code>"
            + "<pre>kubectl get --raw /apis/</pre></div>"

        // Precondition 1: the chip really does ride the token.
        XCTAssertTrue(document(body, .dark).contains("background: var(--bg-secondary)"),
                      "the base CSS no longer styles the chip from a token")
        // Precondition 2: the document's own chip grey under the paired ink is the
        // measured defect.
        XCTAssertLessThan(ratio(RichHTMLPalette.dark.bgSecondary, RichHTMLPalette.light.fg), 1.1,
                          "fixture no longer reproduces the chip defect")

        let html = paired(body, .dark)
        let block = declarations(after: "background:#fff5f5", in: html)
        XCTAssertEqual(block["--bg-secondary"], RichHTMLPalette.light.bgSecondary,
                       "the chip token still resolves to the document's palette:\n\(html)")
        XCTAssertGreaterThanOrEqual(ratio(block["--bg-secondary"], block["color"], "chip"),
                                    bodyMinimum,
                                    "chip \(block["--bg-secondary"] ?? "-") under ink "
                                        + "\(block["color"] ?? "-")")
        XCTAssertTrue(html.contains("<code>stat</code>"), "the card's content was rewritten")
    }

    /// The mirror, for the same reason the pairing rule is symmetric: a dark card under
    /// the light palette is repainted with the dark palette's ink, so its chips must be
    /// the DARK chip grey. Driven off the chosen INK, never off the document.
    func testTheAppsOwnChipsInsideARepaintedDarkCardAreReadable() {
        let body = "<div style=\"background:#161b22\">Read <code>SKILL.md</code></div>"
        XCTAssertLessThan(ratio(RichHTMLPalette.light.bgSecondary, RichHTMLPalette.dark.fg), 1.1,
                          "fixture no longer reproduces the mirror of the chip defect")

        let block = declarations(after: "background:#161b22", in: paired(body, .light))
        XCTAssertEqual(block["--bg-secondary"], RichHTMLPalette.dark.bgSecondary)
        XCTAssertEqual(block["color-scheme"], "dark",
                       "a dark surface must tell WebKit which scheme its own controls are")
        XCTAssertGreaterThanOrEqual(ratio(block["--bg-secondary"], block["color"], "chip"),
                                    bodyMinimum)
    }

    /// One level out from the chips, and the same cause: `blockquote` pins
    /// `color: var(--fg-secondary)` and `a` pins `color: var(--accent)`, so both
    /// OVERRIDE the ink a repainted card was given and keep the document's own token.
    /// Measured on the author's light card in dark mode: 1.42:1 and 2.46:1.
    ///
    /// Reverting the token block leaves both — a quote and a link are the two things a
    /// reply is most likely to put inside a coloured callout.
    func testAQuoteAndALinkInsideARepaintedCardAreReadable() {
        let card = "background:#fff5f5"
        XCTAssertLessThan(ratio("#fff5f5", RichHTMLPalette.dark.fgSecondary), 1.6)
        XCTAssertLessThan(ratio("#fff5f5", RichHTMLPalette.dark.accent), 3.0)

        let body = "<div style=\"\(card)\"><blockquote>refused</blockquote>"
            + "<p>see <a href=\"https://example.com\">the runbook</a></p></div>"
        let page = document(body, .dark)
        XCTAssertTrue(page.contains("color: var(--fg-secondary)"))
        XCTAssertTrue(page.contains("a { color: var(--accent); }"))

        let block = declarations(after: card, in: paired(body, .dark))
        XCTAssertEqual(block["--fg-secondary"], RichHTMLPalette.light.fgSecondary)
        XCTAssertEqual(block["--accent"], RichHTMLPalette.light.accent)
        XCTAssertGreaterThanOrEqual(ratio("#fff5f5", block["--fg-secondary"], "quote"), bodyMinimum)
        XCTAssertGreaterThanOrEqual(ratio("#fff5f5", block["--accent"], "link"), bodyMinimum)
    }

    /// The part instruction alone could never solve: an author who writes the app's own
    /// tokens INSIDE their own light panel. The `rich-output` skill can only warn about
    /// it; the renderer can make it true, because the token they name is the token the
    /// repainted block redeclares.
    ///
    /// Note what is NOT claimed: `--fg-muted` is a deliberately quiet ink (3.6:1 on its
    /// own page), so the guarantee for it is that it MATCHES THE SURFACE and reads at
    /// least as well as it does on the palette it belongs to — not that muted text
    /// reaches the 4.5 body floor, which it does not in either palette.
    func testAnAuthorsOwnTokensFollowTheSurfaceTheyWroteOn() {
        let card = "background:#fff5f5"
        let body = "<div style=\"\(card)\">"
            + "<div style=\"background:var(--card-bg)\">panel</div>"
            + "<span style=\"color:var(--fg-muted)\">optional</span>"
            + "<b style=\"color:var(--fg)\">headline</b></div>"
        let html = paired(body, .dark)
        let block = declarations(after: card, in: html)

        // The nested panel is NOT paired — a token background is always left alone —
        // so the only thing that can fix it is the token declared on its ancestor.
        XCTAssertNil(ink(pairedWith: "background:var(--card-bg)", in: html),
                     "a token background was paired against one scheme's value")
        XCTAssertEqual(block["--card-bg"], RichHTMLPalette.light.cardBg)
        XCTAssertGreaterThanOrEqual(ratio(block["--card-bg"], block["color"], "panel"), bodyMinimum)
        // Their `color: var(--fg)` resolves through the block's OWN declaration, so it
        // lands on the ink of the surface they wrote on rather than the document's.
        XCTAssertEqual(block["--fg"], RichHTMLPalette.light.fg)
        XCTAssertGreaterThanOrEqual(ratio("#fff5f5", block["--fg"], "headline"), bodyMinimum)
        // The muted token: matches the surface, and strictly better than before.
        XCTAssertEqual(block["--fg-muted"], RichHTMLPalette.light.fgMuted)
        XCTAssertGreaterThan(ratio("#fff5f5", block["--fg-muted"], "muted"),
                             ratio("#fff5f5", RichHTMLPalette.dark.fgMuted))
        XCTAssertGreaterThanOrEqual(ratio("#fff5f5", block["--fg-muted"], "muted"), 3.0,
                                    "a quiet ink may be quiet, not invisible")
    }

    /// An author who did exactly what the skill asks — pinned BOTH ends on their own
    /// card — is still a surface, and the app's chips inside it were still wrong:
    /// `#1C1C1E` under their own `#1d1d1f`, 1.01:1, in the 36% of real replies that got
    /// it RIGHT. So their ink is never restated and never overridden, and the tokens are
    /// declared anyway.
    ///
    /// Reverting to "an author colour abandons the block" leaves that whole cohort at
    /// 1.01:1 while every other test here passes.
    func testAnAuthorWhoPairedTheirOwnCardStillGetsTheMatchingTokens() {
        let body = "<div style=\"background:#fff5f5;color:#1d1d1f\">Run <code>stat</code></div>"
        XCTAssertLessThan(ratio(RichHTMLPalette.dark.bgSecondary, "#1d1d1f"), 1.1,
                          "fixture no longer reproduces the author-paired chip defect")

        let html = paired(body, .dark)
        XCTAssertTrue(html.contains("background:#fff5f5;color:#1d1d1f;"),
                      "the author's own ink was rewritten or reordered:\n\(html)")
        XCTAssertEqual(html.components(separatedBy: "color:").count - 1, 1,
                       "a second `color` was appended beside the author's:\n\(html)")
        let block = declarations(after: "color:#1d1d1f", in: html)
        XCTAssertEqual(block["--bg-secondary"], RichHTMLPalette.light.bgSecondary)
        XCTAssertGreaterThanOrEqual(ratio(block["--bg-secondary"], "#1d1d1f", "chip"), bodyMinimum)
    }

    /// When the author's ink and their background disagree about which palette they are
    /// on, the INK decides. A mid-grey card carrying the author's white text is a DARK
    /// surface: choosing by background would have handed it the light chip grey and
    /// hidden the author's own ink on it.
    ///
    /// Reverting to "the background decides" turns this fixture from 18:1 into 1.05:1 —
    /// the fix causing the bug, in the one case where the two signals differ.
    func testTheAuthorsInkPicksTheSurfaceWhenItDisagreesWithTheBackground() {
        let body = "<div style=\"background:#808080;color:#fff\">Run <code>stat</code></div>"
        let block = declarations(after: "color:#fff", in: paired(body, .light))
        XCTAssertEqual(block["--bg-secondary"], RichHTMLPalette.dark.bgSecondary,
                       "the surface was chosen from the background, not the ink in force")
        XCTAssertGreaterThanOrEqual(ratio(block["--bg-secondary"], "#fff", "chip"), bodyMinimum)
        XCTAssertLessThan(ratio(RichHTMLPalette.light.bgSecondary, "#fff"), 1.2,
                          "fixture no longer distinguishes the two signals")
        // In dark mode that card already sits on the palette it wants: nothing to do.
        XCTAssertEqual(paired(body, .dark), body)
    }

    /// The drift ratchet. Any `--x` whose value DIFFERS between the two documents is
    /// scheme-dependent, so a block that is a surface of the other scheme must
    /// redeclare it — otherwise that one token silently keeps the document's palette
    /// inside the card, which is this whole file's defect in miniature.
    ///
    /// This is the test that catches the NEXT token: add `--fg-tertiary` to the palette
    /// and forget `colourTokens`, and it fails here rather than on someone's phone.
    func testEveryPaletteDependentTokenIsRedeclaredByARepaintedBlock() {
        let light = rootTokens(.light), dark = rootTokens(.dark)
        XCTAssertFalse(light.isEmpty, "the document no longer declares tokens on :root")
        let schemeDependent = light.filter { dark[$0.key] != $0.value }
        XCTAssertGreaterThanOrEqual(schemeDependent.count, 10,
                                    "expected the palette to be scheme-dependent: \(schemeDependent)")

        let block = declarations(after: "background:#fff5f5",
                                 in: paired("<div style=\"background:#fff5f5\">x</div>", .dark))
        for (name, lightValue) in schemeDependent {
            XCTAssertEqual(block[name], lightValue,
                           "\(name) keeps the document's scheme inside a repainted block")
        }
        // …and nothing scheme-INDEPENDENT is repeated per block: those would be bytes
        // that decide nothing, on every card of every streaming frame.
        for (name, value) in light where dark[name] == value {
            XCTAssertNil(block[name], "\(name) is the same in both palettes and need not be repeated")
        }
    }

    /// SVG text is painted by `fill`, and SVG's INITIAL fill is BLACK — not
    /// `currentColor` — so the document's `color` never reached a `<text>` and a diagram
    /// label rendered black: 1.11:1 on the dark palette's page, measured in WebKit on 6
    /// text nodes of real replies.
    ///
    /// Fixed in the base CSS rather than by the pass, and that placement IS the
    /// invariant: it has to hold for the documents the pass correctly leaves ALONE (a
    /// dark `<svg>` panel in dark mode needs no repaint and still had black labels) and
    /// for a `<style>` rule where no element tag is knowable. Zero specificity via
    /// `:where`, and it steps aside for an author `fill` on the text or any ancestor.
    ///
    /// The pass itself must never emit `fill`: inherited SVG paint would repaint SHAPES
    /// inside a card, which is a drawing change nobody asked for.
    ///
    /// The `:has()` guard is not decoration, and this is the case that proves the
    /// rule cannot be judged from the rule alone: a fill-less label sitting on the
    /// author's OWN filled shape was drawn in SVG's initial black at 21.00:1, and
    /// handing it `currentColor` took a real production diagram's four box titles to
    /// 1.09:1 in dark mode. `[fill] *` cannot see it, because the shape is a SIBLING.
    /// Verified in WebKit (a unit test cannot resolve a selector): a bare label and
    /// an outline diagram (`fill="none"`, so nothing is painted) take the page ink,
    /// a label on a filled sibling keeps black, and an author `fill` on the text or
    /// an ancestor `<g>` wins in every case.
    func testSVGTextFollowsTheDocumentInkAndTheAuthorsFillStillWins() {
        let page = document("", .dark)
        XCTAssertTrue(page.contains("text:not([fill], [fill] *)) { fill: currentColor; }"),
                      "the document no longer makes SVG text follow the ink")
        // The guard, spelled out: a diagram that paints its own shapes is exempt, and
        // `fill="none"`/`transparent` paint nothing so they must NOT exempt it.
        XCTAssertTrue(page.contains(":has(:is(rect, circle, ellipse, polygon, path, g)[fill]"),
                      "the rule no longer steps aside for a diagram that fills its own shapes")
        XCTAssertTrue(page.contains("[fill=\"none\"], [fill=\"transparent\"]"),
                      "an outline diagram paints nothing, so it must keep the page ink")
        // A bare `svg { fill }` or an unwrapped `svg text { fill }` would outrank the
        // author's own rules and repaint deliberate art.
        XCTAssertFalse(page.contains("svg { fill"), "an unscoped svg fill overrides author art")
        XCTAssertFalse(page.contains("\nsvg text {"), "an unwrapped rule outranks the author")

        for palette in [RichHTMLPalette.dark, RichHTMLPalette.light] {
            let repainted = paired("<div style=\"background:#fff5f5\">"
                + "<svg><text>label</text></svg></div>", palette)
            XCTAssertFalse(repainted.contains("fill:"),
                           "the pass emitted an inherited SVG paint, which repaints shapes")
        }
    }

    // MARK: - What it must never do

    /// An author who set a colour is never second-guessed, in either order, in
    /// either place a background can be set, and however the ink was spelled: the ink
    /// is never rewritten, never reordered, and never restated beside theirs.
    ///
    /// What their block DOES get is the token set of the surface they described, which
    /// is the only way the app's own chips inside it can be right (see
    /// `testAnAuthorWhoPairedTheirOwnCardStillGetsTheMatchingTokens`). So the
    /// invariant here is "the ink is untouched", not "the block is untouched" — and in
    /// the palette their card already belongs to, nothing is touched at all.
    ///
    /// Reverting the same-block check turns the pass from a defence into a
    /// vandal: it would overwrite the deliberate palette of every card that got
    /// this right, which the gate found is 36% of real rich messages.
    func testAnAuthorColourIsNeverOverridden() {
        for (body, ink) in [
            ("<div style=\"background:#fff;color:#333\">x</div>", "#333"),
            ("<div style=\"color:#333;background:#fff\">x</div>", "#333"),
            ("<div style=\"background:#fff;-webkit-text-fill-color:#333\">x</div>", "#333"),
            ("<div style=\"background:#fff;color:var(--accent)\">x</div>", "var(--accent)"),
            ("<style>.c{background:#f0f0f0;color:#222}</style><div class=\"c\">x</div>", "#222"),
        ] {
            for palette in [RichHTMLPalette.dark, RichHTMLPalette.light] {
                let out = paired(body, palette)
                XCTAssertTrue(out.contains("color:" + ink), "the author's ink was rewritten: \(out)")
                XCTAssertEqual(out.components(separatedBy: "color:" + ink).count - 1, 1)
                // Never a second ink beside theirs (`color-scheme:` does not count).
                XCTAssertEqual(out.components(separatedBy: "color:").count - 1,
                               body.components(separatedBy: "color:").count - 1,
                               "an ink was appended beside the author's: \(out)")
            }
            // A light card in the light palette is the surface it already was.
            XCTAssertEqual(paired(body, .light), body, "rewrote a document that needed nothing")
        }
        // An EMPTY value is not a declaration the browser keeps, so it pins no ink and
        // must not suppress one either — or the card is unreadable BECAUSE the author
        // typed a property they never finished.
        let unfinished = "<div style=\"background:#fff5f5;color:\">x</div>"
        XCTAssertEqual(ink(pairedWith: "color:", in: paired(unfinished, .dark)),
                       RichHTMLPalette.light.fg, paired(unfinished, .dark))
    }

    /// A `var(--…)` background is the theme's own token: it already flips with the
    /// palette, so a colour paired against its LIGHT value would be wrong in dark
    /// mode. Same for anything else this pass cannot resolve to one colour.
    ///
    /// Reverting the guard makes `background: var(--card-bg)` — the shape the
    /// rich-output skill actually tells models to use — the worst case in the app:
    /// dark ink on the dark card colour.
    func testAThemeTokenOrUnresolvableBackgroundIsLeftAlone() {
        for background in [
            "var(--bg-secondary)", "var(--card-bg)", "var(--bg, #fff)",
            "linear-gradient(#fff, #eee)", "url(data:image/png;base64,AA==)",
            "transparent", "inherit", "currentColor", "none",
            "hsl(210 40% 96%)", "color-mix(in srgb, #fff 50%, #000)",
            "light-dark(#fff, #000)", "#12345",
        ] {
            for palette in [RichHTMLPalette.dark, RichHTMLPalette.light] {
                let body = "<div style=\"background:\(background)\">x</div>"
                XCTAssertEqual(paired(body, palette), body,
                               "guessed an ink for a background it cannot judge")
            }
        }
        // A colour under an image proves nothing about what the reader sees.
        let layered = "<div style=\"background:#fff;background-image:url(x.png)\">x</div>"
        XCTAssertEqual(paired(layered, .dark), layered)
        // Neither `border-color` nor `background-position` sets a background colour.
        for body in ["<div style=\"border-color:#fff\">x</div>",
                     "<div style=\"background-position:center\">x</div>"] {
            XCTAssertEqual(paired(body, .dark), body)
        }
    }

    /// A translucent background does not hide what is behind it, and a flat scan has no
    /// DOM — so it is only repainted when NO backdrop could change the answer.
    /// Compositing is linear in the backdrop per channel and luminance is monotonic per
    /// channel, so over black and over white bound every surface the paint can produce:
    /// when both ends want the same palette the block is repainted, and when they
    /// disagree it keeps what it inherits.
    ///
    /// Reverting to "judge it against `--bg`" reintroduces the hazard the gate flagged:
    /// a 6%-BLACK veil nested inside an author's light card composites to near-black
    /// against the page, so it would be given LIGHT ink on what actually renders
    /// near-white — the invisibility this file exists to remove, introduced BY the fix,
    /// and it can only appear once some other block has made the document fire.
    func testATranslucentBackgroundIsOnlyRepaintedWhenNoBackdropCanChangeTheAnswer() {
        let nested = "<div style=\"background:#fff5f5\">"
            + "<div style=\"background:rgba(0,0,0,0.06)\">veiled</div></div>"
        let html = paired(nested, .dark)
        XCTAssertNil(ink(pairedWith: "background:rgba(0,0,0,0.06)", in: html),
                     "a veil was judged against the page instead of its real backdrop:\n\(html)")
        // What it inherits instead is readable on what it ACTUALLY renders over.
        guard let veil = RichHTMLContrast.parse("rgba(0,0,0,0.06)"),
              let card = RichHTMLContrast.parse("#fff5f5"),
              let cardInk = RichHTMLContrast.parse(declarations(after: "background:#fff5f5",
                                                               in: html)["color"] ?? "") else {
            return XCTFail("the card itself was not repainted:\n\(html)")
        }
        XCTAssertGreaterThanOrEqual(
            RichHTMLContrast.contrastRatio(cardInk, RichHTMLContrast.composite(veil, over: card)),
            bodyMinimum)

        // A subtle veil on its own changes nothing: over black the ink it would be
        // given is the ink it already has.
        let subtleOnDark = "<div style=\"background:rgba(255,255,255,0.06)\">x</div>"
        XCTAssertEqual(paired(subtleOnDark, .dark), subtleOnDark,
                       "a 6% white veil over black was treated as white")
        let subtleOnLight = "<div style=\"background:rgba(0,0,0,0.05)\">x</div>"
        XCTAssertEqual(paired(subtleOnLight, .light), subtleOnLight)
        // A fully transparent background is not a surface at all.
        let clear = "<div style=\"background:rgba(0,0,0,0)\">x</div>"
        XCTAssertEqual(paired(clear, .dark), clear)
        // Opaque enough to actually cover the page: repainted as the colour it is.
        let solid = "<div style=\"background:rgba(255,255,255,0.97)\">x</div>"
        XCTAssertNotNil(ink(pairedWith: "background:rgba(255,255,255,0.97)", in: paired(solid, .dark)))
        // A veil that lands on the same side whatever it covers IS repainted: a 50%
        // white one is light over white and mid-grey over black, and near-black ink
        // wins on both.
        let half = "<div style=\"background:rgba(255,255,255,0.5)\">x</div>"
        XCTAssertEqual(ink(pairedWith: "background:rgba(255,255,255,0.5)", in: paired(half, .dark)),
                       RichHTMLPalette.light.fg)
    }

    /// A document whose every surface is the one it already sits on must not change AT
    /// ALL — not its pixels and not its bytes. That is the whole of light mode's light
    /// cards, and of a dark card in the dark palette.
    ///
    /// The boundary is exact and worth stating, because it moved: a LIGHT-mode document
    /// that contains a DARK author card is the mirror of the incident and is repainted
    /// (it always was), and now that an author's own ink also names a surface, a dark
    /// card carrying the author's light ink counts too. What never changes is a
    /// document with no opposite-surface block in it.
    ///
    /// Reverting to "always inject" would still be readable, but it would rewrite
    /// every light-mode card in the app to prove a point, and the winning ink there
    /// is already the light palette's own `--fg`.
    func testALightCardInTheLightPaletteIsByteIdentical() {
        for body in [
            "<div style=\"background:#fff\">x</div>",
            "<tr style=\"background:#f0f0f0\"><td>a</td></tr>",
            "<td style=\"background:whitesmoke\">x</td>",
            "<style>.card{background:#fafafa;padding:8px}</style><div class=\"card\">x</div>",
        ] {
            XCTAssertEqual(paired(body, .light), body)
        }
        // The ink such a card shows is the SAME one it shows today, and it always
        // did clear the minimum — which is why there is nothing to fix here.
        XCTAssertGreaterThanOrEqual(ratio("#f0f0f0", RichHTMLPalette.light.fg), bodyMinimum)
        // The symmetric statement for the other palette: a dark card in dark mode.
        let darkCard = "<div style=\"background:#222;padding:8px\">x</div>"
        XCTAssertEqual(paired(darkCard, .dark), darkCard)
    }

    // MARK: - Both places a background is set

    /// A rule inside a `<style>` block gets exactly the treatment an inline
    /// `style="…"` gets. Both arrive in the same body string (the segmenter harvests
    /// message-level `<style>` blocks into every html segment), so a fix that only
    /// covered attributes would miss the half of real replies that write a sheet.
    ///
    /// Reverting the CSS scan leaves a `.card { background:#f0f0f0 }` reply exactly
    /// as unreadable as before, while the inline test still passes.
    func testAStyleBlockRuleIsTreatedLikeAnInlineAttribute() {
        let sheet = """
        <style>
        .card { background:#f0f0f0; padding:8px }
        @media (prefers-color-scheme: light) { .hint { background:#fff8e1 } }
        @keyframes pulse { from { background:#ffffff } to { background:#eeeeee } }
        </style>
        <div class="card">All checks ran<span class="hint">note</span></div>
        """
        let html = paired(sheet, .dark)
        guard let cardInk = ink(pairedWith: "padding:8px", in: html) else {
            return XCTFail("the sheet's rule was left unpaired:\n\(html)")
        }
        XCTAssertGreaterThanOrEqual(ratio("#f0f0f0", cardInk), bodyMinimum)
        // A media query wraps ORDINARY rules, so the pass has to reach inside it.
        guard let hintInk = ink(pairedWith: "background:#fff8e1", in: html) else {
            return XCTFail("a rule inside @media was left unpaired:\n\(html)")
        }
        XCTAssertGreaterThanOrEqual(ratio("#fff8e1", hintInk), bodyMinimum)
        // A keyframe step is not an element, so a colour beside it would mean
        // nothing: its blocks stay exactly as written.
        XCTAssertTrue(html.contains("from { background:#ffffff } to { background:#eeeeee }"),
                      "@keyframes was rewritten:\n\(html)")
    }

    /// Once a light card carries injected near-black ink, a DARK block nested inside
    /// it inherits that ink and goes invisible in turn. So the moment any block in a
    /// document needs pairing, every background-setting block in that document is
    /// given its ink explicitly and none is left depending on inheritance.
    ///
    /// Reverting to "only pair the blocks that need it" makes the fix cause the bug
    /// it fixes, one level down — and it is silent, because the card itself looks right.
    func testANestedOppositeBackgroundIsPairedExplicitlyToo() {
        let inline = "<div style=\"background:#fff5f5\">Failed <span style=\"background:#222\">3</span></div>"
        for palette in [RichHTMLPalette.dark, RichHTMLPalette.light] {
            let html = paired(inline, palette)
            guard let cardInk = ink(pairedWith: "background:#fff5f5", in: html),
                  let chipInk = ink(pairedWith: "background:#222", in: html) else {
                return XCTFail("a nested pair was left to inheritance:\n\(html)")
            }
            XCTAssertGreaterThanOrEqual(ratio("#fff5f5", cardInk), bodyMinimum)
            XCTAssertGreaterThanOrEqual(ratio("#222", chipInk), bodyMinimum)
            XCTAssertNotEqual(cardInk, chipInk, "both halves cannot want the same ink")
        }
        // Same shape written as a stylesheet.
        let sheet = "<style>.card{background:#fff5f5}.chip{background:#222}</style>"
            + "<div class=\"card\">Failed <b class=\"chip\">3</b></div>"
        let html = paired(sheet, .dark)
        XCTAssertNotNil(ink(pairedWith: "background:#fff5f5", in: html))
        XCTAssertNotNil(ink(pairedWith: "background:#222", in: html), html)
    }

    // MARK: - Never corrupt markup

    /// Markup this pass cannot fully understand comes back byte for byte. The body
    /// is routinely a PARTIAL document — the model is still writing it and the same
    /// growing string is re-rendered several times a second — so a half-arrived
    /// attribute or rule must be passed through, never repaired.
    ///
    /// Reverting to "find the next `>`" or "split declarations on `;`" corrupts
    /// these: a `color` spliced into someone's `title`, a `<style>` truncated at a
    /// brace inside a string, or a mid-arrival attribute closed on the model's behalf
    /// and then contradicted by the next chunk.
    func testMalformedOrPartialMarkupPassesThroughByteIdentical() {
        for body in [
            // Mid-arrival: an attribute, a tag, a rule, an at-rule, a comment.
            "<div style=\"background:#fff",
            "<div style=\"background:#fff\"",
            "<div class=\"a\" style=\"background:#eee",
            "<style>.c{background:#f0f0f0",
            "<style>.c{background:#f0f0f0;",
            "<style>@media (min-width:600px){ .c{background:#eee}",
            "<style>/* background:#fff",
            // A brace inside a CSS string, and a `;`/`{` inside a selector.
            "<style>.c{content:\"}\";background:#eee",
            // Nothing to pair: an empty block.
            "<style>.c{}</style><div class=\"c\">x</div>",
            // Not markup at all: a comment, script text, textarea text, prose `<`.
            "<!-- <div style=\"background:#fff\"> --><p>x</p>",
            "<script>var s = '<div style=\"background:#fff\">'</script>",
            "<textarea><div style=\"background:#fff\"></textarea>",
            "<p>a < b, Array<T>, and 2 < 3</p>",
            // At-rules that define something other than an element.
            "<style>@font-face{font-family:x;background:#fff}</style>",
            "<style>@import url(theme.css);</style>",
        ] {
            XCTAssertEqual(paired(body, .dark), body, "rewrote markup it cannot judge")
        }
        // …and the shapes it CAN judge are judged correctly, which is the other half
        // of the same requirement: a `>` inside a quoted value does not end the tag,
        // and a value quoted with `'` may contain `"`.
        let angled = paired("<div title=\"a>b\" style=\"background:#f0f0f0\">x</div>", .dark)
        XCTAssertTrue(angled.hasPrefix("<div title=\"a>b\" style=\"background:#f0f0f0;color:"), angled)
        let mixedQuotes = paired("<div title='say \"hi\"' style='background:#f0f0f0'>x</div>", .dark)
        XCTAssertTrue(mixedQuotes.contains("title='say \"hi\"'"), mixedQuotes)
        XCTAssertNotNil(ink(pairedWith: "background:#f0f0f0", in: mixedQuotes), mixedQuotes)
        // Non-ASCII content is spliced around, never through.
        let cjk = paired("<div style=\"background:#f0f0f0\">检查完成 ✅ 🎉</div>", .dark)
        XCTAssertTrue(cjk.hasSuffix(">检查完成 ✅ 🎉</div>"), cjk)
    }

    /// Every prefix of a streaming reply may only GAIN colour declarations: the pass
    /// never drops, reorders or edits an author byte, at any arrival point.
    ///
    /// This is the property that lets the document be rebuilt from the growing body
    /// several times a second without the card flickering or losing content. Reverting
    /// to any transform that rewrites in place breaks it at some prefix, which is
    /// precisely the failure that is impossible to reproduce by hand.
    func testEveryStreamingPrefixOnlyGainsColourDeclarations() {
        let reply = "<style>.c{background:#fff8e1}</style>"
            + "<div style=\"background:#fff5f5\">Row one</div>"
            + "<div class=\"c\">Row two</div>"
        // Exactly the bytes the pass adds for either surface, so any OTHER edit — a
        // dropped byte, a reorder, a repaired attribute — survives the strip and fails.
        let injected = [RichHTMLPalette.light, RichHTMLPalette.dark]
            .flatMap { surface -> [String] in
                let list = RichHTMLContrast.surfaceDeclarations(surface)
                return [";" + list, list]
            }
        let bytes = Array(reply.utf8)
        for length in 1...bytes.count {
            let prefix = String(decoding: bytes[0..<length], as: UTF8.self)
            let out = paired(prefix, .dark)
            var stripped = out
            for run in injected { stripped = stripped.replacingOccurrences(of: run, with: "") }
            XCTAssertEqual(stripped, prefix, "prefix of \(length) bytes was rewritten: \(out)")
        }
    }

    /// Running the pass on its own output changes nothing: the injected `color` is
    /// exactly the declaration that makes the block ineligible next time.
    ///
    /// It has to hold because the same body is re-rendered on every streaming delta
    /// and re-rendered again when the turn settles. Reverting to a rule that keys on
    /// anything other than "this block already sets a colour" stacks a second
    /// declaration per render.
    func testThePassIsIdempotent() {
        let body = """
        <style>.card{background:#f0f0f0}@media (min-width:400px){.b{background:#ffffff}}</style>
        <div style="background:#fff5f5"><span style="background:#222">3</span></div>
        <table><tr style="background:whitesmoke"><td>ok</td></tr></table>
        """
        for palette in [RichHTMLPalette.dark, RichHTMLPalette.light] {
            let once = paired(body, palette)
            XCTAssertEqual(paired(once, palette), once, "a second pass changed the document again")
            XCTAssertEqual(paired(paired(once, palette), palette), once)
            // And through the real document builder, which is where it runs: exactly
            // one paired ink per background-setting block in the fixture. A pass
            // that stacked a declaration per render would count 10 here.
            let page = RichHTMLDocument.page(body: body, palette: palette, kind: .content)
            XCTAssertEqual(page.components(separatedBy: "color:\(RichHTMLPalette.light.fg)").count - 1
                            + page.components(separatedBy: "color:\(RichHTMLPalette.dark.fg)").count - 1,
                           5, page)
            // The token block is the part that is new and the part that could stack:
            // one `--fg` per repainted block in the BODY, and one on `:root`.
            XCTAssertEqual(page.components(separatedBy: "--fg:").count - 1, 5 + 1, page)
            XCTAssertEqual(once.components(separatedBy: "--fg:").count - 1, 5, once)
        }
    }

    // MARK: - Tap target

    /// A `<summary>` is the one thing in a card a reader taps, and the gate measured
    /// the real one at 183x22pt — half Apple's 44pt minimum. The web never needed
    /// this: a pointer is one pixel and the cursor shows when it is over the target.
    ///
    /// Reverting to `summary { cursor: default }` alone halves the target again.
    /// `display` must stay unset: the disclosure triangle is the element's own
    /// `::marker`, which `display: block` or `flex` deletes.
    func testSummaryTapTargetReachesTheApplePlatformMinimum() {
        let css = RichHTMLDocument.page(body: "", palette: .dark, kind: .content)
        guard let start = css.range(of: "summary {"),
              let end = css.range(of: "}", range: start.upperBound..<css.endIndex) else {
            return XCTFail("the document no longer styles `summary`")
        }
        let rule = String(css[start.upperBound..<end.lowerBound])

        func points(_ property: String) -> Double? {
            guard let hit = rule.range(of: property + ":") else { return nil }
            let value = rule[hit.upperBound...].prefix { $0 != ";" }
            let first = value.split(separator: " ").first { !$0.isEmpty } ?? ""
            return Double(first.replacingOccurrences(of: "px", with: ""))
        }
        guard let padding = points("padding"), let minHeight = points("min-height") else {
            return XCTFail("summary sets no vertical padding or no floor: \(rule)")
        }
        XCTAssertGreaterThanOrEqual(minHeight + padding * 2, 44,
                                    "summary tap target is \(minHeight + padding * 2)pt: \(rule)")
        XCTAssertFalse(rule.contains("display"),
                       "`display` on summary deletes the disclosure triangle: \(rule)")
    }
}
