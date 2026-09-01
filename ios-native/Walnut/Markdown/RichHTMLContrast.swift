import Foundation

/// Pairs a readable text colour with every author background that sets none.
///
/// THE INCIDENT (rich HTML on the phone, dark mode). `RichHTMLDocument`'s base CSS
/// sets `body { color: var(--fg) }` and the dark palette bakes `--fg: #F5F5F7`. A
/// reply that puts a background on a `<tr>`, `<td>` or `<div>` and omits `color`
/// therefore paints near-white text onto the author's near-white background. The UI
/// gate measured it on real production replies: **1.02:1 to 1.05:1** contrast where
/// WCAG's body minimum is 4.5:1, **15 of 20** table cells unreadable, and **16 of 25**
/// real rich messages (64%) carrying at least one light hex background with no paired
/// `color`. Rich output is the DEFAULT reply style, so a dark-mode reader was worse
/// off with the feature than with plain markdown.
///
/// The reply is not wrong to write that. It reads fine on the web in light mode, and
/// the `rich-output` skill only ASKS the model to pin both ends of the pair.
/// Instruction is not enforcement, so the renderer defends itself here — the same
/// posture the base CSS already takes for other author omissions
/// (`button, input, select, textarea { font: inherit }`,
/// `img, svg, video { display: block }`).
///
/// SHAPE OF THE FIX: a pure function of the body string, run where the document is
/// assembled. It only ever INSERTS bytes; every byte the model wrote is copied
/// through in order, so anything this file cannot fully understand comes back
/// **identical** rather than repaired. That is not tidiness, it is the streaming
/// contract: the body is routinely a PARTIAL document (the model is still writing
/// it) and the same growing string is re-rendered several times a second, so a
/// half-arrived attribute or rule must pass through untouched and a completed one
/// must reach the same decision every time.
///
/// SYMMETRY: the rule runs in BOTH palettes. An author DARK background under the
/// light palette's dark inherited ink is the same bug seen from the other end, and
/// one symmetric rule is one thing to reason about.
///
/// WHEN IT FIRES, in one sentence: if any block in this document needs an ink other
/// than the one it inherits, then EVERY background-setting block in the document is
/// repainted explicitly; otherwise nothing is touched at all. Both halves earn
/// their keep. The "otherwise" is why light mode does not change — for a light
/// background the winning ink already IS the light palette's `--fg`, so a light-mode
/// document comes back byte for byte identical. The "every" is what stops the fix
/// from causing the bug: once a light card carries an injected near-black, a dark
/// chip NESTED in it would inherit that near-black and go invisible in turn, so as
/// soon as one block needs pairing, no block is left depending on inheritance.
///
/// A BLOCK IS A SURFACE, NOT A TEXT COLOUR — the correction the second gate round
/// forced. Appending `color` alone MOVED the defect instead of removing it, because
/// the app's own base CSS styles itself in theme tokens that are only defined at
/// `:root`: `code`/`pre` take `background: var(--bg-secondary)`, `blockquote` takes
/// `color: var(--fg-secondary)`, `a` takes `color: var(--accent)`, `th`/`td` take
/// `var(--border)`. Those tokens are on this file's skip list (a token already flips
/// with the scheme, so pairing a colour against one scheme's value would be wrong in
/// the other), so a chip inside a repainted light card kept the DARK chip grey and
/// merely inherited the near-black ink the card had just been given: `#1C1C1E` under
/// `#1D1D1F`, **1.01:1**, measured on device on 26 text nodes across 13 of 69 real
/// production rich messages, and on the load-bearing words (`<code>stat</code>`, a
/// `/tmp/…` path, a `kubectl` invocation, `SKILL.md`). `blockquote` on an author's
/// light background measured 1.42:1 and `a` 2.46:1 the same way.
///
/// So pairing declares the whole palette, not one property: `color`, `fill`, the
/// matching `color-scheme`, and every token in `RichHTMLPalette.colourTokens`.
/// Custom properties INHERIT, so one appended declaration list fixes every
/// descendant at once — the app's own chips, and equally an author who writes
/// `var(--card-bg)` or `var(--fg-muted)` inside their own light panel, which no
/// amount of instruction in the `rich-output` skill could make reliable. The palette
/// declared is chosen by the INK, not by the document: the mirror direction (a dark
/// panel under the light palette) gets the dark token set for the same reason.
enum RichHTMLContrast {

    // MARK: - Entry point

    /// The body with a readable surface (ink, `color-scheme` and the matching palette
    /// tokens) appended to every declaration block that sets a background colour and
    /// no colour of its own. Never `fill`: SVG paint is inherited, so emitting it here
    /// would repaint the SHAPES inside a card, which is a drawing change nobody asked
    /// for. SVG labels are handled by one guarded rule in the base CSS instead.
    static func pairTextColours(in body: String, palette: RichHTMLPalette) -> String {
        let bytes = Array(body.utf8)
        // The pass can only fire on a `background` declaration, and an ordinary
        // reply has none — so the common case pays one byte scan and returns the
        // same string instance. Case-insensitive: CSS property names are.
        guard containsFold(bytes, asciiBackground) else { return body }
        var edits: [Insertion] = []
        scanMarkup(bytes, palette: palette, into: &edits)
        // Nothing in this document is unreadable, so nothing in it is rewritten:
        // this is the whole of light mode's light cards, and of a dark card in the
        // dark palette. The blocks whose surface merely RESTATES what they inherit
        // are dropped with it — they only matter once a sibling broke inheritance.
        guard edits.contains(where: { $0.required }) else { return body }

        // Splice by copying spans between insertion points. Structurally
        // incapable of dropping, reordering or rewriting an author byte.
        var out: [UInt8] = []
        out.reserveCapacity(bytes.count + edits.count * 320)
        var copied = 0
        for edit in edits.sorted(by: { $0.at < $1.at })
        where edit.at >= copied && edit.at <= bytes.count {
            out.append(contentsOf: bytes[copied..<edit.at])
            out.append(contentsOf: edit.text.utf8)
            copied = edit.at
        }
        out.append(contentsOf: bytes[copied..<bytes.count])
        return String(decoding: out, as: UTF8.self)
    }

    /// Where a surface's declarations are inserted, and what to insert. Positions are
    /// UTF-8 byte offsets into the body.
    private struct Insertion {
        let at: Int
        let text: String
        /// False when the surface chosen is the palette the block already inherits,
        /// so on its own the insertion would change no pixel. Kept anyway (when some
        /// other block DOES need pairing) so that no block in a paired document is
        /// left inheriting an ink or a token a sibling's injection changed.
        let required: Bool
    }

    // MARK: - Colour

    /// An sRGB colour, channels and alpha in 0…1.
    struct RGBA: Equatable {
        var r: Double, g: Double, b: Double, a: Double

        init(r: Double, g: Double, b: Double, a: Double = 1) {
            self.r = r; self.g = g; self.b = b; self.a = a
        }

        init(hex: UInt32, a: Double = 1) {
            self.init(r: Double((hex >> 16) & 0xFF) / 255,
                      g: Double((hex >> 8) & 0xFF) / 255,
                      b: Double(hex & 0xFF) / 255, a: a)
        }
    }

    /// WCAG relative luminance: linearise each channel, then weight
    /// 0.2126/0.7152/0.0722. Alpha plays no part — a text/background pair is opaque
    /// by the time it is judged (see `composite`).
    static func relativeLuminance(_ colour: RGBA) -> Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(colour.r) + 0.7152 * linear(colour.g) + 0.0722 * linear(colour.b)
    }

    static func contrastRatio(_ a: RGBA, _ b: RGBA) -> Double {
        let la = relativeLuminance(a), lb = relativeLuminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// Convenience for tests and gates: the ratio between two CSS colour literals,
    /// or nil if either is not one this file parses.
    static func contrastRatio(_ a: String, _ b: String) -> Double? {
        guard let x = parse(a), let y = parse(b) else { return nil }
        return contrastRatio(x, y)
    }

    /// Which of the app's two palettes `paint` is a surface OF: the one whose `--fg`
    /// can be read on it. Returning the PALETTE rather than a colour is the whole
    /// point — the block gets that palette's ink and that palette's tokens, because
    /// those two answers can never be allowed to disagree.
    ///
    /// The candidates are the app's own two text colours: the palette's `--fg` and
    /// the OTHER palette's `--fg`. Nothing else would match the native rows the card
    /// sits between, and picking pure black/white for a slightly better number would
    /// introduce ink the app uses nowhere else.
    ///
    /// nil means "leave this block alone", and it has exactly one cause: a
    /// TRANSLUCENT paint whose answer depends on what it is drawn over. This flat
    /// scan has no DOM, so it does not know an element's backdrop — but it does know
    /// the bounds. Compositing is linear in the backdrop per channel and luminance is
    /// monotonic per channel, so the darkest surface the paint can produce is over
    /// black and the lightest is over white; when those two ends want the SAME
    /// palette, no backdrop can change the answer and the block is repainted, and
    /// when they disagree the block keeps whatever it inherits. That is strictly
    /// safer than judging it against the page: a 6%-black veil nested inside an
    /// author's light card composites to near-black over the page and would have been
    /// given light ink on what actually renders near-white — the invisibility this
    /// file exists to remove, introduced BY the fix. `rgba(0,0,0,0)` falls out of the
    /// same rule: a fully transparent background is not a surface at all.
    ///
    /// WHAT THE PAIR GUARANTEES (all measured, `#1D1D1F` / `#F5F5F7`):
    ///  - on the incident's `#fff5f5`: **15.73:1**, against the 1.02:1 measured today
    ///  - on white: 16.83:1 · on the `#1C1C1E` card grey: 15.63:1
    ///  - on mid-grey `#808080`: **4.26:1** (the dark ink wins)
    ///  - true worst case: a background at luminance ≈0.195 (sRGB grey ≈ `#7A7A7A`),
    ///    where the two inks tie at **3.94:1** — AA for large text and UI controls,
    ///    short of the 4.5 body floor, and still ~4x what the reader has today. Only
    ///    20 of the 256 greys fall short of 4.5:1, the band `#717171`…`#848484`.
    static func pairedSurface(for paint: RGBA, palette: RichHTMLPalette) -> RichHTMLPalette? {
        let opposite = palette.opposite
        // A palette whose own `--fg` cannot be parsed cannot be claimed to be
        // inherited, so the pairing is treated as needed rather than cosmetic.
        guard let own = parse(palette.fg), let other = parse(opposite.fg) else { return opposite }
        func surface(over backdrop: RGBA) -> RichHTMLPalette {
            let rendered = composite(paint, over: backdrop)
            // A tie keeps today's palette: never churn a document for nothing.
            return contrastRatio(other, rendered) > contrastRatio(own, rendered) ? opposite : palette
        }
        // An opaque paint IS its own surface, so both bounds ask the same question and
        // always agree — every real card takes this path unchanged.
        let darkest = surface(over: RGBA(hex: 0x000000))
        let lightest = surface(over: RGBA(hex: 0xFFFFFF))
        guard darkest.dark == lightest.dark else { return nil }
        return darkest
    }

    /// The palette whose `--fg` an ink already IS, for a block whose AUTHOR pinned it.
    ///
    /// Such a block is still a surface, and the app's own tokens inside it still have
    /// to match — this is the half of the defect that pairing alone never reached. A
    /// reply that does exactly what the `rich-output` skill asks and writes
    /// `background:#fff5f5;color:#1d1d1f` is never repainted (correctly), so its
    /// `<code>` chip kept `var(--bg-secondary)` at the DARK `#1C1C1E` under the
    /// author's own near-black: **1.01:1**, measured in WebKit, in the cohort that got
    /// it RIGHT.
    ///
    /// Chosen from the INK and not from the background, which matters exactly where
    /// the two disagree: a mid-grey card carrying the author's white text is a DARK
    /// surface (their ink is the dark palette's), and choosing by background would
    /// have handed it the light chip grey and hidden their own ink on it.
    static func inkSurface(for ink: RGBA) -> RichHTMLPalette {
        guard let light = parse(RichHTMLPalette.light.fg),
              let dark = parse(RichHTMLPalette.dark.fg) else { return .light }
        // "Already is" = nearest, and the nearest of two inks is the one this ink has
        // the LEAST contrast against.
        return contrastRatio(ink, light) <= contrastRatio(ink, dark)
            ? RichHTMLPalette.light : RichHTMLPalette.dark
    }

    /// `colour` drawn over `backdrop` in sRGB space, which is what the browser draws.
    ///
    /// Deliberately NOT "ignore the alpha": `rgba(255,255,255,0.06)` is a stock model
    /// idiom for a subtle card, and read as opaque white it would have earned
    /// near-black ink on a black page — the same invisibility this file exists to
    /// remove, just mirrored. At alpha 1 (nearly every real case) this is identity.
    static func composite(_ colour: RGBA, over backdrop: RGBA) -> RGBA {
        guard colour.a < 0.999 else { return colour }
        let a = max(0, colour.a)
        return RGBA(r: colour.r * a + backdrop.r * (1 - a),
                    g: colour.g * a + backdrop.g * (1 - a),
                    b: colour.b * a + backdrop.b * (1 - a))
    }

    // MARK: - What a repainted block declares

    /// Everything a repainted block declares, as one `;`-joined declaration list:
    /// the ink, the scheme, and the palette's tokens.
    ///
    /// NOT `fill`, even though SVG text is painted by `fill` and SVG's initial fill is
    /// black rather than `currentColor`, so an injected `color` alone leaves a `<text>`
    /// black. That defect is REAL (measured at 1.11:1 in production) but it is not
    /// this pass's to fix: it is equally broken in the documents this pass correctly
    /// leaves alone — a dark `<svg>` panel in dark mode needs no repaint and still had
    /// black labels — so it is fixed at the root, in the base CSS's
    /// `:where(svg text:not([fill], [fill] *)) { fill: currentColor }`. That covers
    /// strictly more (any svg, paired or not, inline or from a sheet), costs no bytes
    /// per block, steps aside for an author's `fill` on the text or any ancestor, and
    /// repaints no SHAPE — which an inherited `fill` from here would have done.
    ///
    /// `color-scheme` because the block IS a surface of that scheme, and the property
    /// inherits: a form control, a checkbox or a `pre`'s scrollbar inside a light card
    /// should be WebKit's light one.
    ///
    /// `skipping` is the set of properties the author's own block already declares,
    /// and they are never restated. The file's whole posture is that an author who
    /// pinned something meant it, and that reaches their tokens too: a reply that
    /// defines its own `--accent` inside its panel keeps it. It is also what makes the
    /// pass idempotent on a block it has already repainted — every property it would
    /// add is already there, so the list comes back empty.
    static func surfaceDeclarations(_ surface: RichHTMLPalette,
                                    skipping declared: Set<String> = []) -> String {
        var parts: [(property: String, value: String)] = [
            ("color", surface.fg),
            ("color-scheme", surface.dark ? "dark" : "light"),
        ]
        parts += surface.colourTokens.map { ("--" + $0.name, $0.value) }
        return parts
            .filter { !declared.contains($0.property) }
            .map { "\($0.property):\($0.value)" }
            .joined(separator: ";")
    }

    /// A CSS colour literal this file is willing to judge: `#rgb`, `#rgba`,
    /// `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`, and a named colour from the table
    /// below. Anything else is nil, and nil always means "leave the author alone".
    static func parse(_ css: String) -> RGBA? {
        firstColour(in: Array(css.lowercased().utf8))
    }

    /// The first parseable colour in a property value, or nil.
    ///
    /// `background` is a shorthand, so the colour can sit anywhere among layout
    /// keywords (`no-repeat`, `center`, `border-box`) — those are skipped. An
    /// unrecognised FUNCTION is fatal rather than skippable, because `hsl()`,
    /// `oklch()`, `color-mix()` and `light-dark()` all ARE the colour and guessing
    /// which end is light would be worse than not touching the block.
    private static func firstColour(in bytes: [UInt8]) -> RGBA? {
        var i = 0
        while i < bytes.count {
            let c = bytes[i]
            if c == uHash {
                var j = i + 1
                while j < bytes.count, isHexDigit(bytes[j]) { j += 1 }
                return hexColour(bytes, i + 1, j)
            }
            if isIdentStart(c) {
                var j = i
                while j < bytes.count, isNameByte(bytes[j]) { j += 1 }
                let ident = string(bytes, i, j)
                if j < bytes.count, bytes[j] == uLParen {
                    guard let close = endOfBlock(bytes, j, bytes.count,
                                                 open: uLParen, close: uRParen) else { return nil }
                    guard ident == "rgb" || ident == "rgba" else { return nil }
                    return rgbFunction(string(bytes, j + 1, close))
                }
                if let named = namedColours[ident] { return RGBA(hex: named) }
                // `transparent` reveals the page, `inherit`/`currentcolor`/`none`
                // are answers this pass cannot resolve: skip the block entirely.
                if inkOpaqueKeywords.contains(ident) { return nil }
                i = j
                continue
            }
            i += 1
        }
        return nil
    }

    private static func hexColour(_ bytes: [UInt8], _ lo: Int, _ hi: Int) -> RGBA? {
        func nib(_ i: Int) -> UInt32 {
            let c = bytes[i]
            if c >= 0x30 && c <= 0x39 { return UInt32(c - 0x30) }
            return UInt32((c | 0x20) - 0x61 + 10)
        }
        switch hi - lo {
        case 3, 4:
            let r = nib(lo), g = nib(lo + 1), b = nib(lo + 2)
            let a = hi - lo == 4 ? Double(nib(lo + 3) * 17) / 255 : 1
            return RGBA(hex: (r * 17) << 16 | (g * 17) << 8 | (b * 17), a: a)
        case 6, 8:
            var value: UInt32 = 0
            for i in lo..<(lo + 6) { value = value << 4 | nib(i) }
            var a = 1.0
            if hi - lo == 8 { a = Double(nib(lo + 6) << 4 | nib(lo + 7)) / 255 }
            return RGBA(hex: value, a: a)
        default:
            // `#12345` looked like a colour and is not one: judging it would be a
            // guess, so the block keeps whatever it has.
            return nil
        }
    }

    /// `rgb()`/`rgba()` in either syntax: commas or spaces, numbers or percentages,
    /// with or without a `/ alpha`. One unparseable component fails the whole value.
    private static func rgbFunction(_ inner: String) -> RGBA? {
        let parts = inner
            .replacingOccurrences(of: ",", with: " ")
            .replacingOccurrences(of: "/", with: " ")
            .split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" || $0 == "\r" })
        guard parts.count == 3 || parts.count == 4 else { return nil }
        var channels: [Double] = []
        for (index, part) in parts.enumerated() {
            let isAlpha = index == 3
            let percent = part.hasSuffix("%")
            let text = percent ? String(part.dropLast()) : String(part)
            guard let number = Double(text) else { return nil }
            let full = percent ? 100.0 : (isAlpha ? 1.0 : 255.0)
            channels.append(min(1, max(0, number / full)))
        }
        return RGBA(r: channels[0], g: channels[1], b: channels[2],
                    a: channels.count == 4 ? channels[3] : 1)
    }

    /// The named colours a reply actually writes. NOT the full 148-name CSS table:
    /// a name that is missing parses as "no colour I can judge", which SKIPS the
    /// block — the safe direction — so the table only has to cover what shows up.
    /// The neutrals are covered thoroughly because that is where the incident lives.
    private static let namedColours: [String: UInt32] = [
        "white": 0xFFFFFF, "snow": 0xFFFAFA, "ivory": 0xFFFFF0, "floralwhite": 0xFFFAF0,
        "ghostwhite": 0xF8F8FF, "azure": 0xF0FFFF, "aliceblue": 0xF0F8FF, "honeydew": 0xF0FFF0,
        "mintcream": 0xF5FFFA, "seashell": 0xFFF5EE, "oldlace": 0xFDF5E6, "linen": 0xFAF0E6,
        "beige": 0xF5F5DC, "lavender": 0xE6E6FA, "lavenderblush": 0xFFF0F5, "mistyrose": 0xFFE4E1,
        "lightyellow": 0xFFFFE0, "lightcyan": 0xE0FFFF, "cornsilk": 0xFFF8DC,
        "lemonchiffon": 0xFFFACD, "papayawhip": 0xFFEFD5, "antiquewhite": 0xFAEBD7,
        "blanchedalmond": 0xFFEBCD, "bisque": 0xFFE4C4, "moccasin": 0xFFE4B5,
        "navajowhite": 0xFFDEAD, "peachpuff": 0xFFDAB9, "wheat": 0xF5DEB3,
        "whitesmoke": 0xF5F5F5, "gainsboro": 0xDCDCDC, "lightgray": 0xD3D3D3,
        "lightgrey": 0xD3D3D3, "silver": 0xC0C0C0, "lightsteelblue": 0xB0C4DE,
        "powderblue": 0xB0E0E6, "paleturquoise": 0xAFEEEE, "lightblue": 0xADD8E6,
        "lightgreen": 0x90EE90, "palegreen": 0x98FB98, "lightpink": 0xFFB6C1, "pink": 0xFFC0CB,
        "thistle": 0xD8BFD8, "khaki": 0xF0E68C, "lightgoldenrodyellow": 0xFAFAD2,
        "plum": 0xDDA0DD, "aquamarine": 0x7FFFD4, "greenyellow": 0xADFF2F,
        "darkgray": 0xA9A9A9, "darkgrey": 0xA9A9A9, "gray": 0x808080, "grey": 0x808080,
        "dimgray": 0x696969, "dimgrey": 0x696969, "lightslategray": 0x778899,
        "lightslategrey": 0x778899, "slategray": 0x708090, "slategrey": 0x708090,
        "darkslategray": 0x2F4F4F, "darkslategrey": 0x2F4F4F, "black": 0x000000,
        "navy": 0x000080, "darkblue": 0x00008B, "midnightblue": 0x191970, "indigo": 0x4B0082,
        "purple": 0x800080, "darkmagenta": 0x8B008B, "maroon": 0x800000, "darkred": 0x8B0000,
        "brown": 0xA52A2A, "firebrick": 0xB22222, "crimson": 0xDC143C, "red": 0xFF0000,
        "tomato": 0xFF6347, "coral": 0xFF7F50, "orangered": 0xFF4500, "darkorange": 0xFF8C00,
        "orange": 0xFFA500, "gold": 0xFFD700, "yellow": 0xFFFF00, "olive": 0x808000,
        "darkolivegreen": 0x556B2F, "green": 0x008000, "darkgreen": 0x006400,
        "forestgreen": 0x228B22, "seagreen": 0x2E8B57, "mediumseagreen": 0x3CB371,
        "limegreen": 0x32CD32, "lime": 0x00FF00, "springgreen": 0x00FF7F, "teal": 0x008080,
        "darkcyan": 0x008B8B, "cyan": 0x00FFFF, "aqua": 0x00FFFF, "turquoise": 0x40E0D0,
        "steelblue": 0x4682B4, "royalblue": 0x4169E1, "dodgerblue": 0x1E90FF,
        "deepskyblue": 0x00BFFF, "skyblue": 0x87CEEB, "cornflowerblue": 0x6495ED,
        "blue": 0x0000FF, "mediumblue": 0x0000CD, "slateblue": 0x6A5ACD,
        "darkslateblue": 0x483D8B, "mediumpurple": 0x9370DB, "rebeccapurple": 0x663399,
        "blueviolet": 0x8A2BE2, "violet": 0xEE82EE, "orchid": 0xDA70D6, "magenta": 0xFF00FF,
        "fuchsia": 0xFF00FF, "hotpink": 0xFF69B4, "deeppink": 0xFF1493, "salmon": 0xFA8072,
        "lightsalmon": 0xFFA07A, "darksalmon": 0xE9967A, "lightcoral": 0xF08080,
        "indianred": 0xCD5C5C, "rosybrown": 0xBC8F8F, "tan": 0xD2B48C, "burlywood": 0xDEB887,
        "sandybrown": 0xF4A460, "peru": 0xCD853F, "chocolate": 0xD2691E, "sienna": 0xA0522D,
        "saddlebrown": 0x8B4513, "goldenrod": 0xDAA520, "darkgoldenrod": 0xB8860B,
        "yellowgreen": 0x9ACD32,
    ]

    /// Values that are an answer, but not one this pass can act on.
    private static let inkOpaqueKeywords: Set<String> = [
        "transparent", "inherit", "initial", "unset", "revert", "revert-layer",
        "currentcolor", "none", "auto",
    ]

    /// A value containing any of these is left alone: a theme token already flips
    /// with the palette, and an image or a gradient has no single colour to judge.
    private static let opaqueValueMarkers = [
        "var(", "url(", "gradient(", "image(", "image-set(", "element(", "cross-fade(",
        "paint(", "attr(", "env(",
    ]

    // MARK: - Markup scan

    /// Elements whose text is not markup, so a `<div style="…">` inside one is a
    /// SAMPLE (or a JavaScript string) and must not be rewritten. `<style>` is
    /// handled separately: its body is the other place a background is set.
    private static let opaqueBodyTags: Set<String> = ["script", "textarea", "title"]

    /// Bound on recursion through nested rules — a reply never nests this deep, and
    /// the cap is what keeps a pathological brace run from recursing per byte.
    private static let maxNesting = 8

    private static func scanMarkup(_ b: [UInt8], palette: RichHTMLPalette,
                                  into edits: inout [Insertion]) {
        let n = b.count
        var i = 0
        while i < n {
            guard let lt = indexOf(uLT, in: b, from: i) else { return }
            if matchesFold(b, at: lt, asciiCommentOpen) {
                // An unterminated comment means the rest of the body is inside it.
                guard let close = findFold(b, asciiCommentClose, from: min(lt + 4, n)) else { return }
                i = close + 3
                continue
            }
            if lt + 1 < n, b[lt + 1] == uBang || b[lt + 1] == uQuestion {
                guard let gt = indexOf(uGT, in: b, from: lt + 1) else { return }
                i = gt + 1
                continue
            }
            switch scanTag(b, at: lt) {
            case .notATag:
                // A `<` that opens nothing: `a < b`, `<3`, `Array<T>`.
                i = lt + 1
            case .incomplete:
                // No `>` and no closing quote anywhere after `lt`, so everything
                // from here is ONE half-arrived tag. Nothing later can be markup.
                return
            case .tag(let tag):
                if !tag.closing, let value = tag.styleValue {
                    scanDeclarations(b, value.lowerBound, value.upperBound,
                                     palette: palette, depth: 0, into: &edits)
                }
                i = tag.end
                guard !tag.closing else { continue }
                if tag.name == "style" {
                    let body = rawtextBody(b, from: tag.end, name: "style")
                    scanRuleList(b, body.lo, body.hi, palette: palette, depth: 0, into: &edits)
                    i = body.resume
                } else if opaqueBodyTags.contains(tag.name) {
                    i = rawtextBody(b, from: tag.end, name: tag.name).resume
                }
            }
        }
    }

    private struct Tag {
        var name: String
        var closing: Bool
        /// Just past the `>`.
        var end: Int
        /// The VALUE bytes of the first quoted `style` attribute.
        var styleValue: Range<Int>?
    }

    private enum TagScan {
        case notATag
        case incomplete
        case tag(Tag)
    }

    /// Walks a tag the way a browser tokenises one, which is the only way to be
    /// right about two shapes the gate found in real replies: a `>` INSIDE a quoted
    /// attribute value does not end the tag, and a value quoted with `'` may contain
    /// `"` (and the reverse). Scanning for the next `>` gets both wrong and would
    /// splice a `color` into the middle of someone's `title`.
    private static func scanTag(_ b: [UInt8], at lt: Int) -> TagScan {
        let n = b.count
        var i = lt + 1
        var closing = false
        if i < n, b[i] == uSlash { closing = true; i += 1 }
        guard i < n, isLetter(b[i]) else { return .notATag }
        let nameStart = i
        while i < n, isNameByte(b[i]) { i += 1 }
        let name = string(b, nameStart, i)
        var styleValue: Range<Int>?
        while i < n {
            if b[i] == uGT {
                return .tag(Tag(name: name, closing: closing, end: i + 1, styleValue: styleValue))
            }
            if isSpaceByte(b[i]) || b[i] == uSlash { i += 1; continue }
            let attrStart = i
            while i < n, !isSpaceByte(b[i]), b[i] != uEquals, b[i] != uGT, b[i] != uSlash {
                i += 1
            }
            let attribute = string(b, attrStart, i)
            var j = i
            while j < n, isSpaceByte(b[j]) { j += 1 }
            guard j < n else { return .incomplete }
            guard b[j] == uEquals else { i = j; continue } // a boolean attribute
            j += 1
            while j < n, isSpaceByte(b[j]) { j += 1 }
            guard j < n else { return .incomplete }
            if b[j] == uQuote || b[j] == uApostrophe {
                guard let close = indexOf(b[j], in: b, from: j + 1) else { return .incomplete }
                // HTML keeps the FIRST of duplicate attributes; so does this.
                if attribute == "style", styleValue == nil { styleValue = (j + 1)..<close }
                i = close + 1
            } else {
                // An UNQUOTED value is never extended: its end is defined by the
                // next space, so appending to it could change where the attribute
                // stops. A model always quotes, and skipping only costs a fix.
                while j < n, !isSpaceByte(b[j]), b[j] != uGT { j += 1 }
                i = j
            }
        }
        return .incomplete
    }

    /// The body of a rawtext element, plus where scanning resumes after it.
    /// A missing closer means the element is still arriving: the body is everything
    /// that has, and scanning stops there.
    private static func rawtextBody(_ b: [UInt8], from: Int,
                                   name: String) -> (lo: Int, hi: Int, resume: Int) {
        let closer = Array("</\(name)".utf8)
        var i = from
        while let at = findFold(b, closer, from: i) {
            let after = at + closer.count
            guard after < b.count else { return (from, at, b.count) }
            if isSpaceByte(b[after]) || b[after] == uGT || b[after] == uSlash {
                guard let gt = indexOf(uGT, in: b, from: after) else { return (from, at, b.count) }
                return (from, at, gt + 1)
            }
            i = at + 1
        }
        return (from, b.count, b.count)
    }

    // MARK: - CSS scan

    /// A rule list: the body of a `<style>` element or of a conditional at-rule.
    private static func scanRuleList(_ b: [UInt8], _ lo: Int, _ hi: Int,
                                     palette: RichHTMLPalette, depth: Int,
                                     into edits: inout [Insertion]) {
        guard depth <= maxNesting else { return }
        var i = lo
        while i < hi {
            i = skipTrivia(b, i, hi)
            guard i < hi else { return }
            if b[i] == uSemicolon { i += 1; continue }
            var atRule = ""
            if b[i] == uAt {
                var j = i + 1
                let start = j
                while j < hi, isNameByte(b[j]) { j += 1 }
                atRule = string(b, start, j)
            }
            // A prelude that never reaches `{` or `;` is a rule still arriving.
            guard let stop = firstTopLevel(b, i, hi, stops: [uLBrace, uSemicolon]) else { return }
            if b[stop] == uSemicolon { i = stop + 1; continue } // `@import …;`
            guard let close = endOfBlock(b, stop, hi, open: uLBrace, close: uRBrace) else { return }
            if atRule.isEmpty {
                scanDeclarations(b, stop + 1, close, palette: palette, depth: depth + 1, into: &edits)
            } else if conditionalAtRules.contains(atRule) {
                // A media query or `@supports` wraps ORDINARY rules, so the same
                // treatment has to reach inside it.
                scanRuleList(b, stop + 1, close, palette: palette, depth: depth + 1, into: &edits)
            }
            // Every other at-rule keeps its block exactly as written: a
            // `background` inside `@keyframes` or `@font-face` is not an element's
            // background, and a `color` beside it would mean nothing.
            i = close + 1
        }
    }

    /// A rule list wrapping ordinary rules rather than defining something else.
    private static let conditionalAtRules: Set<String> = [
        "media", "supports", "container", "layer", "scope", "document", "when", "else",
    ]

    /// The shared decision, for BOTH places an author sets a background: the value
    /// of a `style="…"` attribute and the body of a `{…}` rule are the same thing —
    /// a declaration block — so they get one implementation and cannot drift.
    ///
    /// Injects only when the block itself sets a background colour, and always by
    /// APPENDING: an author declaration is never rewritten, removed or reordered, so
    /// the cascade inside the block is unchanged, and every property that could be
    /// appended is already present on a second run — so the appended list comes back
    /// empty and the pass is idempotent.
    ///
    /// An author's own `color` no longer ABANDONS the block, it only decides two
    /// things: their ink is not restated (`skipping`), and their ink rather than their
    /// background picks the surface. That is the difference between fixing the chip in
    /// a card the pass repainted and fixing it in a card the author paired correctly
    /// themselves — measured at 1.01:1 in both.
    private static func scanDeclarations(_ b: [UInt8], _ lo: Int, _ hi: Int,
                                         palette: RichHTMLPalette, depth: Int,
                                         into edits: inout [Insertion]) {
        guard depth <= maxNesting, lo < hi, hi <= b.count else { return }
        var declarations: [(property: String, value: String)] = []
        var i = lo
        var segmentStart = lo
        var lastMeaningful = -1

        while i < hi {
            let c = b[i]
            // A string or a comment is skipped whole, and one that never closes is a
            // block still arriving: leave the whole thing alone.
            guard let past = pastAtomicRun(b, i, hi) else { return }
            if past != i {
                lastMeaningful = past - 1
                i = past
            } else if c == uLParen {
                guard let close = endOfBlock(b, i, hi, open: uLParen, close: uRParen) else { return }
                lastMeaningful = close
                i = close + 1
            } else if c == uLBrace {
                // CSS nesting: the text before the brace was a selector, not a
                // declaration, and the block inside is a declaration block of its own.
                guard let close = endOfBlock(b, i, hi, open: uLBrace, close: uRBrace) else { return }
                scanDeclarations(b, i + 1, close, palette: palette, depth: depth + 1, into: &edits)
                lastMeaningful = close
                i = close + 1
                segmentStart = i
            } else if c == uSemicolon {
                if let declaration = declaration(b, segmentStart, i) { declarations.append(declaration) }
                lastMeaningful = i
                i += 1
                segmentStart = i
            } else {
                if !isSpaceByte(c) { lastMeaningful = i }
                i += 1
            }
        }
        // A final declaration with no trailing `;` (`style="background:#eee"`).
        if let declaration = declaration(b, segmentStart, hi) { declarations.append(declaration) }
        guard lastMeaningful >= lo else { return } // empty block

        var background: RGBA?
        var sawBackground = false
        // Every property the author's block declares, so none of them is restated.
        var declared: Set<String> = []
        // The ink the author pinned, if they pinned one this file can read. Nil also
        // covers a `var(--…)` ink, which needs no reading: a token FOLLOWS the surface
        // this pass declares, so the background is the right thing to judge.
        var authorInk: RGBA?
        for declaration in declarations {
            // An empty value is not a declaration the browser keeps, so it pins nothing
            // and blocks nothing: `style="background:#eee;color:"` still gets an ink.
            if !declaration.value.isEmpty { declared.insert(declaration.property) }
            switch declaration.property {
            // An author who pinned the ink — however they spelled it — is never
            // second-guessed. `-webkit-text-fill-color` paints the text whatever
            // `color` says, so it counts as pinning `color` too.
            case "color", "-webkit-text-fill-color":
                guard !declaration.value.isEmpty else { break }
                declared.insert("color")
                if declaration.value.lowercased().contains("var(") {
                    authorInk = nil
                } else if let ink = parse(declaration.value) {
                    authorInk = ink
                } else {
                    // `hsl()`, `oklch()`, `currentColor`, `inherit`: an answer this
                    // file cannot read, so it cannot say which surface the block is.
                    return
                }
            case "all":
                // A deliberate reset of every property; appending a palette to it
                // would contradict it.
                if !declaration.value.isEmpty { return }
            case "background", "background-color":
                sawBackground = true
                background = backgroundPaint(declaration.value)
            case "background-image":
                // An image covers the colour, so the colour proves nothing.
                guard declaration.value == "none" else { return }
            default:
                break
            }
        }
        guard sawBackground, let paint = background else { return }
        // Their ink decides when they pinned a readable one; otherwise the background
        // does, which is also right for a `var(--…)` ink because the token this pass
        // declares is the one that ink resolves through.
        let chosen: RichHTMLPalette?
        if let ink = authorInk {
            chosen = inkSurface(for: ink)
        } else {
            chosen = pairedSurface(for: paint, palette: palette)
        }
        guard let surface = chosen else { return }
        let appended = surfaceDeclarations(surface, skipping: declared)
        guard !appended.isEmpty else { return }
        let separator = b[lastMeaningful] == uSemicolon || b[lastMeaningful] == uRBrace ? "" : ";"
        edits.append(Insertion(at: lastMeaningful + 1, text: separator + appended,
                               required: surface.dark != palette.dark))
    }

    /// One `property: value` pair, or nil when the segment is not a declaration.
    private static func declaration(_ b: [UInt8], _ lo: Int,
                                    _ hi: Int) -> (property: String, value: String)? {
        guard lo < hi, let colon = firstTopLevel(b, lo, hi, stops: [uColon]) else { return nil }
        let property = string(b, lo, colon).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !property.isEmpty, property.allSatisfy(isPropertyCharacter) else { return nil }
        let value = string(b, colon + 1, hi).trimmingCharacters(in: .whitespacesAndNewlines)
        return (property, value)
    }

    private static func isPropertyCharacter(_ c: Character) -> Bool {
        c.isLetter || c.isNumber || c == "-" || c == "_"
    }

    /// The background colour a value sets, or nil for "do not touch this block".
    private static func backgroundPaint(_ value: String) -> RGBA? {
        let lowered = value.lowercased()
        guard !opaqueValueMarkers.contains(where: { lowered.contains($0) }) else { return nil }
        return firstColour(in: Array(lowered.utf8))
    }

    // MARK: - Byte helpers

    private static let uLT: UInt8 = 0x3C, uGT: UInt8 = 0x3E, uSlash: UInt8 = 0x2F
    private static let uBang: UInt8 = 0x21, uQuestion: UInt8 = 0x3F, uEquals: UInt8 = 0x3D
    private static let uQuote: UInt8 = 0x22, uApostrophe: UInt8 = 0x27, uStar: UInt8 = 0x2A
    private static let uLBrace: UInt8 = 0x7B, uRBrace: UInt8 = 0x7D
    private static let uLParen: UInt8 = 0x28, uRParen: UInt8 = 0x29
    private static let uLBracket: UInt8 = 0x5B, uRBracket: UInt8 = 0x5D
    private static let uSemicolon: UInt8 = 0x3B, uColon: UInt8 = 0x3A
    private static let uAt: UInt8 = 0x40, uHash: UInt8 = 0x23, uBackslash: UInt8 = 0x5C
    private static let asciiBackground = Array("background".utf8)
    private static let asciiCommentOpen = Array("<!--".utf8)
    private static let asciiCommentClose = Array("-->".utf8)
    private static let asciiCommentEndCSS = Array("*/".utf8)

    private static func isSpaceByte(_ c: UInt8) -> Bool {
        c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D || c == 0x0C
    }

    private static func isLetter(_ c: UInt8) -> Bool {
        let lower = c | 0x20
        return lower >= 0x61 && lower <= 0x7A
    }

    private static func isIdentStart(_ c: UInt8) -> Bool {
        isLetter(c) || c == 0x2D || c == 0x5F
    }

    /// Tag and property name bytes. `-`/`_`/digits/`:` so `background-color`,
    /// `data-x` and a namespaced tag all read as one name.
    private static func isNameByte(_ c: UInt8) -> Bool {
        isLetter(c) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F || c == uColon
    }

    private static func isHexDigit(_ c: UInt8) -> Bool {
        if c >= 0x30 && c <= 0x39 { return true }
        let lower = c | 0x20
        return lower >= 0x61 && lower <= 0x66
    }

    /// Lowercased ASCII text of a byte range. Multi-byte UTF-8 passes through
    /// untouched: every continuation byte is ≥ 0x80, so no ASCII fold can reach it.
    private static func string(_ b: [UInt8], _ lo: Int, _ hi: Int) -> String {
        guard lo < hi, lo >= 0, hi <= b.count else { return "" }
        var out = [UInt8]()
        out.reserveCapacity(hi - lo)
        for i in lo..<hi {
            let c = b[i]
            out.append(c >= 0x41 && c <= 0x5A ? c + 32 : c)
        }
        return String(decoding: out, as: UTF8.self)
    }

    private static func indexOf(_ needle: UInt8, in b: [UInt8], from: Int) -> Int? {
        var i = max(0, from)
        while i < b.count {
            if b[i] == needle { return i }
            i += 1
        }
        return nil
    }

    /// ASCII case fold, letters only — `|= 0x20` would also fold punctuation into
    /// control bytes and let `<` match 0x1C.
    private static func fold(_ c: UInt8) -> UInt8 {
        (c >= 0x41 && c <= 0x5A) ? c + 32 : c
    }

    private static func matchesFold(_ b: [UInt8], at: Int, _ ascii: [UInt8]) -> Bool {
        guard at >= 0, at + ascii.count <= b.count else { return false }
        for k in 0..<ascii.count where fold(b[at + k]) != fold(ascii[k]) { return false }
        return true
    }

    private static func findFold(_ b: [UInt8], _ ascii: [UInt8], from: Int) -> Int? {
        guard !ascii.isEmpty, b.count >= ascii.count else { return nil }
        var i = max(0, from)
        while i + ascii.count <= b.count {
            if matchesFold(b, at: i, ascii) { return i }
            i += 1
        }
        return nil
    }

    private static func containsFold(_ b: [UInt8], _ ascii: [UInt8]) -> Bool {
        findFold(b, ascii, from: 0) != nil
    }

    /// Index of the closing quote of the string starting at `at`, honouring CSS
    /// backslash escapes, or nil if it never closes.
    private static func endOfString(_ b: [UInt8], _ at: Int, _ hi: Int) -> Int? {
        let quote = b[at]
        var i = at + 1
        while i < hi {
            if b[i] == uBackslash { i += 2; continue }
            if b[i] == quote { return i }
            i += 1
        }
        return nil
    }

    /// Past a run that must be skipped WHOLE, because a delimiter inside it means
    /// nothing: a quoted string or a `/*…*/` comment. Returns `i` unchanged when the
    /// byte starts neither, and nil when the run never closes — the one answer every
    /// caller turns into "still arriving, leave it alone". ONE implementation, because
    /// a `}` inside a CSS string and a `;` inside a comment have to be invisible to
    /// every scanner below or they disagree about where a block ends.
    private static func pastAtomicRun(_ b: [UInt8], _ i: Int, _ hi: Int) -> Int? {
        if b[i] == uQuote || b[i] == uApostrophe {
            guard let end = endOfString(b, i, hi) else { return nil }
            return end + 1
        }
        if b[i] == uSlash, i + 1 < hi, b[i + 1] == uStar {
            guard let end = findFold(b, asciiCommentEndCSS, from: i + 2), end + 1 < hi else { return nil }
            return end + 2
        }
        return i
    }

    /// Index of the delimiter matching the one at `at`, skipping atomic runs and
    /// nested pairs. Nil when it never closes.
    private static func endOfBlock(_ b: [UInt8], _ at: Int, _ hi: Int,
                                  open: UInt8, close: UInt8) -> Int? {
        guard at >= 0, at < hi, hi <= b.count, b[at] == open else { return nil }
        var depth = 0
        var i = at
        while i < hi {
            guard let past = pastAtomicRun(b, i, hi) else { return nil }
            if past != i { i = past; continue }
            if b[i] == open { depth += 1 }
            else if b[i] == close {
                depth -= 1
                if depth == 0 { return i }
            }
            i += 1
        }
        return nil
    }

    /// The first top-level byte from `stops`, skipping atomic runs and anything
    /// inside `(…)`/`[…]` — a `;` in `[data-a=";"]` ends no prelude, and the `:` in
    /// `url(data:…)` is not a declaration's colon. Nil when none arrives before `hi`,
    /// which for both callers means the rule is incomplete.
    private static func firstTopLevel(_ b: [UInt8], _ lo: Int, _ hi: Int,
                                     stops: [UInt8]) -> Int? {
        var i = lo
        while i < hi {
            guard let past = pastAtomicRun(b, i, hi) else { return nil }
            if past != i { i = past; continue }
            if b[i] == uLParen || b[i] == uLBracket {
                let close: UInt8 = b[i] == uLParen ? uRParen : uRBracket
                guard let end = endOfBlock(b, i, hi, open: b[i], close: close) else { return nil }
                i = end + 1
                continue
            }
            if stops.contains(b[i]) { return i }
            i += 1
        }
        return nil
    }

    /// Whitespace and `/*…*/`. An unterminated comment swallows the rest.
    private static func skipTrivia(_ b: [UInt8], _ from: Int, _ hi: Int) -> Int {
        var i = from
        while i < hi {
            if isSpaceByte(b[i]) { i += 1; continue }
            if b[i] == uSlash, i + 1 < hi, b[i + 1] == uStar {
                guard let end = findFold(b, asciiCommentEndCSS, from: i + 2) else { return hi }
                i = end + 2
                continue
            }
            return i
        }
        return hi
    }
}
