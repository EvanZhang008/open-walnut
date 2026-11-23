import SwiftUI

/// The phone's design tokens: the same scale as the web's `globals.css` `:root`
/// (.claude/skills/walnut-ui-requirements/standard.md, the iOS column). A view takes its corners,
/// spacing, text sizes and control heights from here and its colours from `Theme`; it never writes
/// a number of its own. `tests/web/ios-ui-standard-ratchet.test.ts` counts the views that still do.
///
/// Why (2026-11-21, the user): everything should be consistent; the phone had colours and no other
/// rule, so each view picked any corner (15 different ones). Then (2026-11-22, the user): the round
/// look was cute, controls should be round, not squares. The rule (standard.md, "Shapes"): what you
/// press and every tag is round (a capsule; a square one a circle); what you type or read in is a
/// rounded rectangle from the corners below; no corner in between on a key.
extension Theme {
    /// Corners of surfaces (cards, fields, boxes, list rows). A control, a chip and a badge are never
    /// given one of these: they are round.
    enum Radius {
        /// Checks and code spans (web `--radius-xs`).
        static let xs: CGFloat = 4
        /// A row of a list, even one that is a button (web `--radius-sm`).
        static let sm: CGFloat = 8
        /// Single-line fields, menus, tiles, file and email cards, thumbnails (web `--radius-md`).
        static let md: CGFloat = 12
        /// Sheets' own panels and large blocks (web `--radius-lg`).
        static let lg: CGFloat = 16
        /// A card (the ask card, a thread card, a letter's block): the web's card corner.
        static let card: CGFloat = 16
        /// A notice (the shared notice card): the web's `notice-card.css` and the Mac's native
        /// notice card corner, the same on all three.
        static let notice: CGFloat = 14

        /// The continuous rounded rectangle of one of the corners above.
        static func shape(_ radius: CGFloat) -> RoundedRectangle {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
        }
    }

    /// Spacing on the web's 2 pt grid: 2, 4, 6 and 10 inside a control or a dense row, multiples
    /// of 4 between blocks.
    enum Space {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let s: CGFloat = 6
        static let sm: CGFloat = 8
        static let m: CGFloat = 10
        static let md: CGFloat = 12
        static let lg: CGFloat = 16
        static let xl: CGFloat = 20
        static let xxl: CGFloat = 24
        static let xxxl: CGFloat = 32
    }

    /// Text sizes: the web's scale is iOS's own text styles at their default size, so each grows
    /// with Dynamic Type (11 / 12 / 13 / 15 / 17 / 20).
    enum TextSize {
        /// 11: badges, small labels (web `--font-size-xs`).
        static let xs: Font = .caption2
        /// 12: secondary text, an option's line of why (web `--font-size-sm`).
        static let sm: Font = .caption
        /// 13: dense body text, chips (web `--font-size-md`).
        static let md: Font = .footnote
        /// 15: controls, card titles (web `--font-size-lg`).
        static let lg: Font = .subheadline
        /// 17: body and section headings (web `--font-size-xl`).
        static let xl: Font = .body
        /// 20: page titles (web `--font-size-2xl`).
        static let xxl: Font = .title3
        /// A control's words: every button, option row and chip of the family.
        static let control: Font = .subheadline.weight(.medium)
    }

    /// An icon drawn at a fixed point size (a glyph that must not grow with the text, inside a key
    /// of fixed size). Text never takes these: it takes a `TextSize`.
    enum Glyph {
        case xs, sm, md, lg, xl, hero

        var points: CGFloat {
            switch self {
            case .xs: 9
            case .sm: 12
            case .md: 15
            case .lg: 18
            case .xl: 22
            case .hero: 40
            }
        }

        func font(_ weight: Font.Weight = .regular) -> Font {
            .system(size: points, weight: weight)
        }
    }

    /// Control heights. On the phone a control is a finger's 44 pt; a small one draws 32 pt and
    /// still takes a 44 pt touch.
    enum Control {
        static let height: CGFloat = 44
        static let smallHeight: CGFloat = 32
        /// A quiet tool on a card's last line (Snooze, a pager arrow, pin): web 28 px.
        static let toolHeight: CGFloat = 28
        /// The least touch target.
        static let target: CGFloat = 44
    }
}
