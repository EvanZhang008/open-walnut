import AppKit

/// The one card every Walnut notice is drawn as, here in AppKit: the web app's NoticeCard
/// (web/src/components/common/NoticeCard.tsx, web/src/styles/notice-card.css) for what the Mac
/// app draws itself, so a notice reads the same wherever it comes from (2026-11-20, the user:
/// "整个 system 就那么一个 notification system"). Frosted glass (NSVisualEffectView), a 14 pt
/// radius, one hairline all round and never a bar down one side, an avatar tile, a bold title,
/// a status as a dot and a word, and up to two lines of preview; buttons go below in `accessory`.
class NoticeCardView: NSVisualEffectView {
    enum Tone {
        case live, ok, warn, error, muted

        var color: NSColor {
            switch self {
            case .live: return .systemBlue
            case .ok: return .systemGreen
            case .warn: return .systemOrange
            case .error: return .systemRed
            case .muted: return .systemGray
            }
        }
    }

    static let radius: CGFloat = 14

    private let tile = NSView()
    private let glyph = NSImageView()
    private let titleField = NSTextField(labelWithString: "")
    private let dot = NSView()
    private let statusField = NSTextField(labelWithString: "")
    private let lineField = NSTextField(wrappingLabelWithString: "")
    private let column = NSStackView()

    /// `blending`: .behindWindow for a card that is its own window (the desktop shows through),
    /// .withinWindow for one laid over a window's content.
    init(blending: NSVisualEffectView.BlendingMode, accessory: NSView? = nil) {
        super.init(frame: .zero)
        material = .popover
        blendingMode = blending
        state = .active
        wantsLayer = true
        layer?.cornerRadius = Self.radius
        layer?.masksToBounds = true
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.cgColor
        translatesAutoresizingMaskIntoConstraints = false

        tile.wantsLayer = true
        tile.layer?.cornerRadius = 7
        tile.translatesAutoresizingMaskIntoConstraints = false
        glyph.contentTintColor = .white
        glyph.symbolConfiguration = .init(pointSize: 11, weight: .semibold)
        glyph.translatesAutoresizingMaskIntoConstraints = false
        tile.addSubview(glyph)

        titleField.font = .systemFont(ofSize: 13, weight: .semibold)
        titleField.lineBreakMode = .byTruncatingTail
        titleField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        dot.translatesAutoresizingMaskIntoConstraints = false
        statusField.font = .systemFont(ofSize: 12)
        statusField.textColor = .secondaryLabelColor
        statusField.lineBreakMode = .byTruncatingTail
        let top = NSStackView(views: [titleField, dot, statusField])
        top.orientation = .horizontal
        top.spacing = 6
        top.alignment = .centerY
        top.setCustomSpacing(8, after: titleField)
        top.setCustomSpacing(5, after: dot)

        lineField.font = .systemFont(ofSize: 13)
        lineField.textColor = .secondaryLabelColor
        lineField.maximumNumberOfLines = 2
        lineField.lineBreakMode = .byTruncatingTail
        lineField.cell?.truncatesLastVisibleLine = true

        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 2
        column.addArrangedSubview(top)
        column.addArrangedSubview(lineField)
        if let accessory {
            column.addArrangedSubview(accessory)
            column.setCustomSpacing(8, after: lineField)
        }
        column.translatesAutoresizingMaskIntoConstraints = false

        addSubview(tile)
        addSubview(column)
        NSLayoutConstraint.activate([
            tile.widthAnchor.constraint(equalToConstant: 22),
            tile.heightAnchor.constraint(equalToConstant: 22),
            tile.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            tile.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            glyph.centerXAnchor.constraint(equalTo: tile.centerXAnchor),
            glyph.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6),
            dot.heightAnchor.constraint(equalToConstant: 6),
            column.leadingAnchor.constraint(equalTo: tile.trailingAnchor, constant: 10),
            column.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            column.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            column.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            lineField.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// What the card says: who it is from, its status, its preview, and the tile's symbol.
    func set(title: String, status: String, tone: Tone, line: String, symbol: String) {
        titleField.stringValue = title
        statusField.stringValue = status
        statusField.textColor = tone == .muted || tone == .live ? .secondaryLabelColor : tone.color
        dot.layer?.backgroundColor = tone.color.cgColor
        tile.layer?.backgroundColor = tone.color.cgColor
        glyph.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        lineField.stringValue = line
        lineField.isHidden = line.isEmpty
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // A CGColor does not follow the appearance by itself: the hairline is read again.
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }

    /// The bottom left of `area`, 16 pt in, where every Walnut notice shows.
    static func bottomLeftOrigin(in area: NSRect, inset: CGFloat = 16) -> NSPoint {
        NSPoint(x: area.minX + inset, y: area.minY + inset)
    }
}
