import Foundation

/// Colour values the rich document exposes as CSS variables.
///
/// Every name the `rich-output` skill tells the model it may use is here, because
/// a variable the model uses and the document does not define renders as nothing:
/// `color: var(--fg)` with no `--fg` falls back to the initial colour, and
/// `background: var(--card-bg)` falls back to transparent, so a card the Mac shows
/// correctly would arrive on the phone as invisible text on no background.
struct RichHTMLPalette: Equatable {
    /// True for the dark-scheme values. Carried so a caller can tell which
    /// palette it holds without comparing colours.
    var dark: Bool
    var fg: String, fgSecondary: String, fgMuted: String
    var bg: String, bgSecondary: String, cardBg: String
    var border: String, borderStrong: String
    var accent: String, success: String, warning: String, error: String

    /// The neutral scale mirrors the web console (web/src/styles/globals.css), so a
    /// reply reads the same on both surfaces. The four SEMANTIC colours come from
    /// the phone's own palette (Walnut/Core/Theme.swift) instead: a card sits
    /// between native rows, and a success green that disagrees with the row above
    /// it looks like a bug.
    static let light = RichHTMLPalette(
        dark: false,
        fg: "#1D1D1F", fgSecondary: "#424245", fgMuted: "#86868B",
        bg: "#FFFFFF", bgSecondary: "#F5F5F7", cardBg: "#FFFFFF",
        border: "rgba(60,60,67,0.12)", borderStrong: "rgba(60,60,67,0.18)",
        // DELIBERATE DIVERGENCE from the web, which uses iOS blue here: on the
        // phone the accent is the app's walnut tint (Theme.tint), so an accented
        // border or heading inside a card matches the chrome around it rather than
        // introducing a second brand colour mid-conversation.
        accent: "#8B5A2B",
        success: "#34C759", warning: "#FF9F0A", error: "#FF3B30"
    )

    /// ONE static per scheme, and this is the dark one. (A static `dark` and the
    /// instance `dark` flag coexist fine — type and instance members are separate
    /// namespaces — so the name stays the obvious `RichHTMLPalette.dark`.)
    static let dark = RichHTMLPalette(
        dark: true,
        fg: "#F5F5F7", fgSecondary: "#D1D1D6", fgMuted: "#8E8E93",
        bg: "#000000", bgSecondary: "#1C1C1E", cardBg: "#1C1C1E",
        border: "rgba(84,84,88,0.42)", borderStrong: "rgba(84,84,88,0.6)",
        accent: "#C99659",
        success: "#30D158", warning: "#FFD60A", error: "#FF453A"
    )

    /// The other scheme's values. A block that is painted with the OTHER palette's
    /// ink is a surface of that palette, so it needs that palette's whole token set
    /// (see `RichHTMLContrast`), and `dark` is the only bit that selects it.
    var opposite: RichHTMLPalette { dark ? .light : .dark }

    /// Every custom property whose value depends on the scheme, name without the
    /// `--`, in ONE list because there are TWO consumers and a token missing from
    /// either one is a bug:
    ///
    ///  - `RichHTMLDocument.variables()` declares them on `:root`, so a reply can
    ///    write `var(--card-bg)` and get the scheme it is being read in;
    ///  - `RichHTMLContrast` RE-declares them inside every block it repaints, so a
    ///    block that is now a surface of the other palette resolves the app's own
    ///    `var(--…)` to that palette instead of the document's.
    ///
    /// The second consumer is why this list exists at all. Custom properties were
    /// only ever defined at `:root`, so the app's OWN chip CSS
    /// (`code { background: var(--bg-secondary) }`) kept the dark chip grey inside a
    /// light card that had just been paired with near-black ink: `#1C1C1E` under
    /// `#1D1D1F`, measured at **1.01:1** on device, on the load-bearing words of a
    /// reply (`<code>stat</code>`, a path, a `kubectl` invocation) in 13 of 69 real
    /// production rich messages. Same shape one level out for `blockquote`
    /// (`var(--fg-secondary)`, 1.42:1) and `a` (`var(--accent)`, 2.46:1).
    ///
    /// The four SEMANTIC colours are in here with the neutrals deliberately: a
    /// half-flipped palette is a worse thing to reason about than a whole one, and a
    /// reply that writes `var(--success)` inside its own light panel means the green
    /// that belongs on a light surface.
    ///
    /// NOT in here: `--radius-*` and `--font-mono`, which are identical in both
    /// palettes, so re-declaring them per block would be bytes that decide nothing.
    var colourTokens: [(name: String, value: String)] {
        [("fg", fg), ("fg-secondary", fgSecondary), ("fg-muted", fgMuted),
         ("bg", bg), ("bg-secondary", bgSecondary), ("card-bg", cardBg),
         ("border", border), ("border-strong", borderStrong), ("accent", accent),
         ("success", success), ("warning", warning), ("error", error)]
    }
}

/// The standalone document a rich-HTML segment renders inside — the chat sibling
/// of `LetterHTMLBody.documentPieces()`, and it keeps that file's security floor:
///
/// - **`.content`**: JavaScript is OFF at the web-view level AND the CSP forbids
///   scripts, frames and every network fetch (`default-src 'none'`, only `data:`
///   and `blob:` images, only inline styles, only `data:` fonts). With
///   `baseURL: nil` on the load, a `<script>` a model wrote is inert and a tracker
///   pixel cannot phone home — which is why the segmenter hands the model's markup
///   over WITHOUT sanitising it. Declared as a `<meta>` because that is honoured
///   for every load, `loadHTMLString` included.
/// - **`.island`**: inline scripts are allowed (that is the entire point of an
///   `html-app` fence) but the network stays closed, so an island can compute and
///   draw and still cannot reach Walnut data or the internet.
///
/// Body margin is zero: the timeline cell owns the outer padding, so the document
/// must not add its own or a card would sit inset from its own bubble.
enum RichHTMLDocument {
    enum Kind { case content, island }

    /// A complete standalone document wrapping a body fragment.
    ///
    /// A `.content` body is the one place inline markdown is applied
    /// (`RichHTMLSegments.inlineMarkdown`): the web runs md and html chunks through
    /// the SAME markdown renderer, so `**Bottom line:**` beside a `<div>` is bold on
    /// the Mac, and the phone showed the asterisks. It has to happen HERE and not in
    /// the segment, because the segment's html is compared byte for byte by the
    /// streaming prefix invariant and is the height cache's key; a pure function of
    /// that string keeps both honest.
    ///
    /// An `.island` body is left exactly as written. Its markup is an app the model
    /// authored, the web renders it in an iframe with no markdown pass at all, and
    /// its text is UI labels rather than prose.
    ///
    /// Both kinds then go through `RichHTMLContrast`, which repaints any author
    /// background that set no colour as a surface of whichever palette can be read on
    /// it — its ink AND its `colourTokens`. It runs on the ISLAND too, and it has to:
    /// the invisible-text bug is caused by THIS document's own
    /// `body { color: var(--fg) }` and by the `var(--bg-secondary)` chips in the base
    /// CSS below, both of which an island carries as well, so the renderer that
    /// creates the problem is the one that has to answer for it. It rewrites no text —
    /// only appends declarations to a block that already sets a background — so the
    /// "an island is as the model wrote it" contract still holds for everything the
    /// reader reads. Ordered AFTER the markdown pass so what it inspects is exactly
    /// the bytes WebKit will get; the two cannot interfere either way, since one only
    /// ever rewrites TEXT and the other only ever appends inside a declaration block.
    static func page(body: String, palette: RichHTMLPalette, kind: Kind) -> String {
        let markdown = kind == .island ? body : RichHTMLSegments.inlineMarkdown(body)
        let content = RichHTMLContrast.pairTextColours(in: markdown, palette: palette)
        return """
        <!DOCTYPE html><html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="\(csp(kind))">
        <style>
        \(variables(palette))
        \(baseCSS)
        </style>
        </head><body>
        \(content)
        </body></html>
        """
    }

    /// `media-src` matches the letter renderer's floor (LetterHTMLBody), which
    /// carries it for a reason worth repeating: the cell turns on inline playback and
    /// the base CSS styles `<video>`, but under `default-src 'none'` alone a
    /// `<video src="data:…">` renders its control and then silently refuses to play.
    /// `data:`/`blob:` only, so this is still no network: an `https://` media URL
    /// stays blocked and a card cannot report that it was read.
    private static let contentCSP = "default-src 'none'; img-src data: blob:; "
        + "media-src data: blob:; style-src 'unsafe-inline'; font-src data:"

    private static func csp(_ kind: Kind) -> String {
        switch kind {
        case .content: return contentCSP
        case .island: return contentCSP + "; script-src 'unsafe-inline'"
        }
    }

    /// The document's palette, declared once at the root. Everything scheme-dependent
    /// comes from `palette.colourTokens` rather than being spelled out here, because
    /// `RichHTMLContrast` re-declares that same set inside a block it repaints — two
    /// hand-written lists would drift, and the token that went missing would silently
    /// keep the wrong scheme's value inside a repainted card.
    private static func variables(_ palette: RichHTMLPalette) -> String {
        let tokens = palette.colourTokens
            .map { "  --\($0.name): \($0.value);" }
            .joined(separator: "\n")
        return """
        :root {
          /* The ONE scheme this document was built for, not "light dark". The
             palette below is already resolved from the app's trait, and the
             declaration also drives everything WebKit styles itself — a bare
             `<button>` in an island, a checkbox, a scrollbar. Left as "light
             dark" those arrived light-on-black in a dark transcript. */
          color-scheme: \(palette.dark ? "dark" : "light");
        \(tokens)
          --radius-sm: 8px;
          --radius-md: 12px;
          --radius-lg: 16px;
          --font-mono: ui-monospace, Menlo, monospace;
        }
        """
    }

    /// Sane defaults for everything a reply writes, so markup that sets no styles
    /// of its own still reads like the rest of the app.
    ///
    /// `font: -apple-system-body` plus the `-apple-system` family is what makes
    /// Dynamic Type apply inside the web view (the shorthand carries the user's
    /// text size; the family keeps the face consistent with the native rows), and
    /// `-webkit-text-size-adjust: 100%` stops WebKit inflating it again on top.
    /// `word-break: break-word` because a model writes long identifiers and URLs
    /// that would otherwise force a horizontal scroll in a fixed-width cell.
    private static let baseCSS = """
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      font: -apple-system-body;
      font-family: -apple-system, system-ui, sans-serif;
      line-height: 1.45;
      color: var(--fg);
      word-break: break-word;
      -webkit-text-size-adjust: 100%;
    }
    a { color: var(--accent); }
    h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1em 0 0.4em; }
    h1 { font-size: 1.35em; } h2 { font-size: 1.2em; } h3 { font-size: 1.08em; }
    p, ul, ol, blockquote, table, pre { margin: 0.55em 0; }
    ul, ol { padding-left: 1.4em; }
    li { margin: 0.2em 0; }
    /* `display: block` is not cosmetic: an inline `<svg>` sits on a line box and
       collects the font's descender, so a 86pt diagram measured 92pt and the card
       carried ~6pt of tail nobody drew. */
    img, svg, video { max-width: 100%; height: auto; display: block; }
    /* SVG text is painted by `fill`, whose initial value is black rather than
       `currentColor`, so `color` never reached a `<text>`: 1.11:1 on the dark page.
       Zero specificity, and `:not([fill], [fill] *)` so an author fill on the text or
       any ancestor still wins. `text` only — `tspan` inherits from it.

       The `:has()` guard is the expensive lesson: a label with nothing behind it is
       drawn on the PAGE and wants the page's ink, but a diagram that fills its own
       shapes draws that label on one of them, and `[fill] *` does not see a filled
       SIBLING. Handing such a label `currentColor` took four box titles of a real
       production diagram from 21.00:1 (SVG's initial black on the author's white
       rect) to 1.09:1 in dark mode. So the rule steps aside for any SVG that paints
       shapes of its own: it keeps the win where the label sits on the page, and
       leaves a drawn diagram exactly as its author coloured it. `fill="none"` and
       `transparent` are excluded from the guard, because an outline diagram paints
       nothing and its labels DO sit on the page. A WebKit without `:has()` drops the
       whole rule, which is the pre-rule behaviour. */
    :where(svg:not(:has(:is(rect, circle, ellipse, polygon, path, g)[fill]:not([fill="none"], [fill="transparent"])))
           text:not([fill], [fill] *)) { fill: currentColor; }
    /* WebKit styles its own controls from the UA stylesheet, which does NOT
       inherit the body font — so a `<button>` in an island stayed at the default
       size next to prose the reader had scaled to accessibility XXXL. */
    button, input, select, textarea { font: inherit; }
    pre, code, kbd, samp { font-family: var(--font-mono); font-size: 0.88em; }
    pre {
      overflow-x: auto;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: var(--bg-secondary);
    }
    pre code { background: none; padding: 0; }
    /* The chip background, `blockquote`'s ink, `a`'s accent and the table borders below
       follow whichever palette is in scope, which is why a repainted block redeclares
       the whole token set and not just its ink (a chip that kept `#1C1C1E` under an
       injected `#1D1D1F` measured 1.01:1). */
    code { padding: 1px 4px; border-radius: 4px; background: var(--bg-secondary); }
    blockquote {
      padding-left: 10px;
      border-left: 3px solid var(--border-strong);
      color: var(--fg-secondary);
    }
    table { border-collapse: collapse; display: block; overflow-x: auto; }
    th, td { border: 1px solid var(--border); padding: 4px 7px; text-align: left; }
    hr { border: none; border-top: 1px solid var(--border); margin: 1em 0; }
    /* A `<summary>` is usually the only thing in a card anyone TAPS, and the UI
       gate measured the real one at 183x22pt — half Apple's 44pt minimum, so a
       thumb aimed at the middle of the row lands above or below it as often as on
       it. The web never needed this: a pointer is one pixel wide and the cursor
       tells you when you are over the target, while a finger is ~10mm and has no
       feedback until it commits. Padding, NOT `height` or `display`: the
       disclosure triangle is the element's own `::marker`, which `display: block`
       or `flex` deletes, whereas vertical padding moves the marker down with the
       first line box. `min-height` keeps the floor at 22 + 11 + 11 = 44pt when the
       reader's Dynamic Type size is smaller than body. */
    summary { cursor: default; min-height: 22px; padding: 11px 0; }
    """
}
