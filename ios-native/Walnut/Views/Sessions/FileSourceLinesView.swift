import SwiftUI

/// Sheet payload for "open this arbitrary absolute path as text".
///
/// The HTML preview has `FilePreviewTarget` (and a dock seat that remembers a
/// scroll position); a text file needs less state but MORE context: the session
/// whose transcript mentioned the path, so an unresolvable reference can be
/// re-resolved host-side instead of dead-ending in an error.
struct TextFileTarget: Identifiable, Equatable {
    let ref: FilePathRef
    /// nil/"" = the primary box; otherwise the session's exec-host alias.
    let host: String?
    /// The mentioning session's working directory, for `files/resolve-path`.
    let cwd: String?
    /// The mentioning session's id — unlocks the resolver's transcript layer.
    let sessionID: String?

    init(ref: FilePathRef, host: String? = nil, cwd: String? = nil, sessionID: String? = nil) {
        self.ref = ref
        self.host = host
        self.cwd = cwd
        self.sessionID = sessionID
    }

    /// Identity includes the LINE: tapping `foo.ts:10` and then `foo.ts:900`
    /// must re-present, not silently reuse the first sheet's scroll position.
    var id: String { "\(host ?? "")\u{1}\(ref.path)\u{1}\(ref.line ?? 0)" }
}

/// Makes `walnut-file://` links inside a SwiftUI subtree actually open something.
///
/// The UIKit timeline routes taps itself (`TimelineCollectionController` → the
/// timeline bodies). The SwiftUI renderers had NO routing at all: a path inside
/// a note, a letter or a plan sheet was styled as a link and then did nothing,
/// because SwiftUI hands an unknown scheme to the system opener, which drops it
/// without a word. One modifier so every one of those surfaces behaves like the
/// transcript.
struct FilePathLinkHandling: ViewModifier {
    var host: String? = nil
    var cwd: String? = nil
    var sessionID: String? = nil

    @State private var htmlTarget: FilePreviewTarget?
    @State private var textTarget: TextFileTarget?
    @State private var dirTarget: DirectoryTarget?

    func body(content: Content) -> some View {
        content
            .environment(\.openURL, OpenURLAction { url in
                // Anything that is not one of ours keeps the system behaviour —
                // an https:// link in a note must still open Safari.
                guard let ref = FilePreviewLink.reference(from: url) else { return .systemAction }
                if ref.looksLikeDirectory {
                    dirTarget = DirectoryTarget(path: ref.path, host: host)
                } else if FilePreviewLink.isPreviewablePath(ref.path) {
                    htmlTarget = FilePreviewTarget(path: ref.path, host: host)
                } else {
                    textTarget = TextFileTarget(ref: ref, host: host, cwd: cwd, sessionID: sessionID)
                }
                return .handled
            })
            .sheet(item: $htmlTarget) { HTMLFilePreviewSheet(target: $0) }
            .sheet(item: $textTarget) { target in
                SessionFileViewer(name: target.ref.displayName, path: target.ref.path,
                                  host: target.host ?? "", ref: target.ref,
                                  cwd: target.cwd, sessionID: target.sessionID)
            }
            .sheet(item: $dirTarget) { DirectoryPreviewSheet(target: $0) }
    }
}

extension View {
    /// Route `walnut-file://` taps in this subtree to the in-app viewers.
    func handlingFilePathLinks(host: String? = nil, cwd: String? = nil,
                               sessionID: String? = nil) -> some View {
        modifier(FilePathLinkHandling(host: host, cwd: cwd, sessionID: sessionID))
    }
}

extension DynamicTypeSize {
    /// SwiftUI's type size as the UIKit category, so a SwiftUI view can ask
    /// UIKit how wide its text will actually be. There is no public bridge, and
    /// the alternative — scaling a hardcoded width with `@ScaledMetric` — is
    /// still a guess about a font's advance rather than a measurement of it.
    var uiContentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

/// Monospaced file body with a line-number gutter, scrolled to (and briefly
/// highlighting) the referenced line.
///
/// The anchor is why this exists at all. Opening `foo.ts:2400` at line 1 of a
/// long file is not opening the reference — the reader has to hunt for the thing
/// the message was about, on a phone screen, by scrolling. The flash then
/// answers "which line is it" without leaving permanent decoration behind.
struct FileSourceLinesView: View {
    /// 1-based; nil = plain file view, no anchor and no flash.
    let anchorLine: Int?
    /// 1-based last line of a range (`#L10-L20`).
    let anchorEndLine: Int?

    /// Split at INIT, not in a computed property read from `body`. The server
    /// clips at 512 KB, so a `components(separatedBy:)` per body pass would
    /// re-allocate thousands of strings every time the highlight fades.
    private let rows: [String]

    init(content: String, anchorLine: Int?, anchorEndLine: Int? = nil) {
        self.rows = content.isEmpty ? [""] : content.components(separatedBy: "\n")
        self.anchorLine = anchorLine
        self.anchorEndLine = anchorEndLine
    }

    /// Highlight is temporary on purpose: it says "here", then gets out of the
    /// way so the file reads as a file.
    @State private var flash = false

    private static let flashSeconds: Double = 2.2

    /// The type size the gutter is currently drawing at. Read from the
    /// environment rather than assumed: the number is drawn in a Dynamic Type
    /// style, so its width is not a constant.
    @Environment(\.dynamicTypeSize) private var typeSize

    /// Gutter is sized from the LARGEST line number, so the body's left edge
    /// doesn't shift between a 90-line and a 9000-line file.
    ///
    /// MEASURED, never a points-per-digit constant. It used to be `digits * 9`
    /// while the number was drawn at `.caption2`, which is 11pt by default and
    /// 32pt at accessibility-XXXL: a 147-line file rendered line 146 as
    /// `1`/`4`/`6` stacked down three rows, each digit beside a DIFFERENT line
    /// of the file, so the gutter stopped saying which line was which. Same rule
    /// the board's count already carries (TaskBoardList.countLabel): a number
    /// must never wrap between its digits or truncate.
    static func gutterWidth(forLineCount count: Int, traits: UITraitCollection? = nil) -> CGFloat {
        numberWidth(forLineCount: count, traits: traits) + 8
    }

    /// The font the gutter actually draws with, at a given type size.
    static func gutterFont(traits: UITraitCollection? = nil) -> UIFont {
        let size = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: traits).pointSize
        return UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// How a line number is written, for BOTH the measurement and the drawing.
    ///
    /// Deliberately unlocalised. `Text("\(number)")` formats an Int as a QUANTITY,
    /// so line 1421 drew as "1,421": five glyphs where four were measured, and the
    /// extra one overflowed a trailing-aligned fixed frame and clipped the leading
    /// `1` off at accessibility sizes ("`,421`"). Matching the measurement to the
    /// separator would have made the width right and the number still wrong: a line
    /// number is an IDENTIFIER, not an amount. No editor groups it, so a grouped
    /// gutter disagrees with every other tool the reader has open, and the gutter's
    /// width would then vary by locale for no reason. One function so the string
    /// drawn and the string measured cannot drift apart again.
    static func lineNumberText(_ number: Int) -> String { String(number) }

    /// Width the widest line number REALLY needs, measured in that font.
    static func numberWidth(forLineCount count: Int, traits: UITraitCollection? = nil) -> CGFloat {
        let widest = lineNumberText(max(count, 10)) as NSString
        return ceil(widest.size(withAttributes: [.font: gutterFont(traits: traits)]).width)
    }

    var body: some View {
        let width = Self.gutterWidth(forLineCount: rows.count,
                                     traits: UITraitCollection(preferredContentSizeCategory:
                                                                typeSize.uiContentSizeCategory))
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows.indices, id: \.self) { index in
                        row(number: index + 1, text: rows[index], gutter: width)
                            .id(index + 1)
                    }
                }
                .padding(.vertical, 8)
            }
            .task(id: anchorLine) { await anchor(with: proxy, lineCount: rows.count) }
        }
        .accessibilityIdentifier("file.source.lines")
    }

    @ViewBuilder
    private func row(number: Int, text: String, gutter: CGFloat) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // lineLimit+fixedSize BEFORE the frame: if the measurement is ever
            // wrong the number overflows its column, which is legible. Wrapping
            // between digits is not.
            Text(verbatim: Self.lineNumberText(number))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .frame(width: gutter, alignment: .trailing)
                .accessibilityHidden(true)
            // A blank line still needs a row's height, or the gutter numbering
            // drifts out of step with the file.
            Text(text.isEmpty ? " " : text)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.trailing, 12)
        .padding(.vertical, 1)
        .background(highlighted(number) && flash
                    ? Theme.tint.opacity(0.22) : Color.clear)
    }

    private func highlighted(_ number: Int) -> Bool {
        guard let anchorLine else { return false }
        if let end = anchorEndLine, end >= anchorLine {
            return number >= anchorLine && number <= end
        }
        return number == anchorLine
    }

    /// Scroll to the anchor, THEN light it up, then fade.
    ///
    /// Scrolling twice, ~250ms apart, is not superstition: the rows live in a
    /// `LazyVStack`, so a target several thousand rows down may not be
    /// realised on the first attempt and the scroll lands short. The retry costs
    /// nothing when the first one worked (scrolling to where you already are is
    /// a no-op).
    ///
    /// The ORDER is the fix for a shipped bug, and it is worth being precise
    /// about because the obvious order is the broken one. `flash = true` used to
    /// come first, and the highlight then never appeared for any anchor far
    /// enough down to need the scroll — which is every anchor worth having, since
    /// a reader who can already see the line does not need to be told where it
    /// is. Measured, hosting this view in a window and counting tinted pixels:
    /// line 5 of a 400-line file highlighted (55,326 px), line 349 of the same
    /// file never did (0 px at 0.3s, 0.8s, 1.5s, 2.4s), while the scroll landed
    /// correctly in both. The difference is that line 5's row already EXISTS when
    /// the state flips, so it is re-evaluated; line 349's row is created by the
    /// scroll, and a row realised while `flash` is already true came out
    /// unhighlighted. So the state change now happens when the row is on screen,
    /// which is also when the reader is looking at it.
    private func anchor(with proxy: ScrollViewProxy, lineCount: Int) async {
        guard let anchorLine, anchorLine >= 1 else { return }
        let target = min(anchorLine, lineCount)
        // `try?` swallows cancellation, so each step re-checks it explicitly —
        // otherwise a dismissed sheet still gets scrolled and animated.
        try? await Task.sleep(for: .milliseconds(60))
        guard !Task.isCancelled else { return }
        proxy.scrollTo(target, anchor: .center)
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        proxy.scrollTo(target, anchor: .center)
        // One more beat so the row the scroll just realised is on screen before
        // it changes colour.
        try? await Task.sleep(for: .milliseconds(100))
        guard !Task.isCancelled else { return }
        flash = true
        try? await Task.sleep(for: .seconds(Self.flashSeconds))
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.5)) { flash = false }
    }
}
