import SwiftUI
import UIKit

/// The result an island offered the AI, shown under it, sent only by the user's press.
///
/// The phone twin of the web's `IslandResultCard.tsx`. The user's two rules
/// (2026-10-27): they can see exactly what is sent, and nothing goes out on their
/// behalf. So the strip lives OUTSIDE the web view (a page cannot draw or press it),
/// "Review & Send" opens a sheet with the whole text, character for character, and the
/// one way it reaches the conversation is that sheet's Send button. Sent is remembered
/// with the island (`IslandStateStore`), so a relaunch does not offer it again.
///
/// The strip is part of the ISLAND ROW (below the web view, inside the same cell), and
/// its height is part of the row's height: the builder adds `blockHeight` to an island
/// row whose record has a result, and the cell lays the strip out with the same
/// function, so the two cannot disagree.
enum IslandResultStrip {
    /// Gap between the island's document and the strip.
    static let topGap: CGFloat = 6
    static let padding: CGFloat = 10
    static let lineGap: CGFloat = 4
    /// The header row holds the button, so it is never shorter than a tap target.
    static let headerMinHeight: CGFloat = 44
    static let previewLines = 2

    static var titleFont: UIFont {
        let base = TimelineTextStyler.subheadlineFont
        return UIFont(descriptor: base.fontDescriptor.withSymbolicTraits(.traitBold) ?? base.fontDescriptor,
                      size: base.pointSize)
    }
    static var previewFont: UIFont { TimelineTextStyler.footnoteFont }

    static func title(sent: Bool) -> String { sent ? "Sent to the AI" : "Result for the AI" }
    static func buttonTitle(sent: Bool) -> String { sent ? "Review" : "Review & Send" }

    /// Height of the preview (at most two lines) at the strip's inner width.
    static func previewHeight(_ text: String, width: CGFloat) -> CGFloat {
        let font = previewFont
        let inner = max(40, width - padding * 2)
        let measured = (previewText(text) as NSString).boundingRect(
            with: CGSize(width: inner, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil
        ).height
        // Count lines against one line measured the same way: `boundingRect` with font
        // leading answers a little more than `lineHeight` for a single line, which
        // rounded up would reserve a second, empty line under a one-line result.
        let oneLine = ("X" as NSString).boundingRect(
            with: CGSize(width: inner, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil
        ).height
        let lines = max(1, min(previewLines, Int((measured / max(1, oneLine)).rounded())))
        return ceil(CGFloat(lines) * font.lineHeight + CGFloat(lines - 1) * max(0, font.leading)) + 1
    }

    /// The strip's whole block (gap included) for a result, at the row's content width.
    static func blockHeight(_ result: IslandStateStore.Result, width: CGFloat) -> CGFloat {
        topGap + boxHeight(result, width: width)
    }

    static func boxHeight(_ result: IslandStateStore.Result, width: CGFloat) -> CGFloat {
        padding * 2 + header(result, width: width).height + lineGap + previewHeight(result.text, width: width)
    }

    /// Where the title and the button go, inside the strip's padding (origin at the
    /// inner top-left). Side by side when both fit on one line; otherwise the title
    /// wraps on its own and the button sits under it, so at the largest text sizes
    /// neither is cut (2026-10-30 UI gate: "Result…" and a clipped two-line button).
    /// ONE function for the builder's height and the view's layout.
    struct Header {
        let title: CGRect
        let button: CGRect
        let height: CGFloat
        let stacked: Bool
    }

    static let buttonInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
    static var buttonFont: UIFont { TimelineTextStyler.footnoteFont }

    static func titleText(sent: Bool) -> String { (sent ? "\u{2713} " : "") + title(sent: sent) }

    static func header(_ result: IslandStateStore.Result, width: CGFloat) -> Header {
        let inner = max(40, width - padding * 2)
        let pad = buttonInsets.leading + buttonInsets.trailing
        let vpad = buttonInsets.top + buttonInsets.bottom
        let title = titleText(sent: result.sent)
        let button = buttonTitle(sent: result.sent)
        let titleLine = size(title, font: titleFont, width: .greatestFiniteMagnitude)
        let buttonLine = size(button, font: buttonFont, width: .greatestFiniteMagnitude)
        let buttonWidth = ceil(buttonLine.width) + pad
        if ceil(titleLine.width) + 8 + buttonWidth <= inner {
            let buttonHeight = max(32, ceil(buttonLine.height) + vpad)
            let height = max(headerMinHeight, ceil(titleLine.height), buttonHeight)
            return Header(
                title: CGRect(x: 0, y: 0, width: inner - buttonWidth - 8, height: height),
                button: CGRect(x: inner - buttonWidth, y: (height - buttonHeight) / 2,
                               width: buttonWidth, height: buttonHeight),
                height: height, stacked: false)
        }
        let titleHeight = ceil(size(title, font: titleFont, width: inner).height)
        let buttonText = size(button, font: buttonFont, width: max(20, inner - pad))
        let stackedWidth = min(inner, ceil(buttonText.width) + pad)
        let buttonHeight = max(headerMinHeight, ceil(buttonText.height) + vpad)
        return Header(
            title: CGRect(x: 0, y: 0, width: inner, height: titleHeight),
            button: CGRect(x: 0, y: titleHeight + lineGap, width: stackedWidth, height: buttonHeight),
            height: titleHeight + lineGap + buttonHeight, stacked: true)
    }

    private static func size(_ text: String, font: UIFont, width: CGFloat) -> CGSize {
        (text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil
        ).size
    }

    /// The text the preview shows: the start of the result, blank text said as such.
    static func previewText(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "(empty)" : String(trimmed.prefix(600))
    }

    /// Extra row height for an island row: the strip block when its record has a result.
    static func rowExtra(storeKey: String, width: CGFloat,
                         store: IslandStateStore = .shared) -> CGFloat {
        guard let result = store.result(storeKey) else { return 0 }
        return blockHeight(result, width: width)
    }
}

/// The page's answer to a send. Holds a reply that MUST run exactly once: a page that
/// does not handle `.sendIslandResult` drops the action, and the sheet would wait for
/// ever, so a reply nobody called answers "not sent" when it goes away.
final class IslandSendReply: @unchecked Sendable {
    private let lock = NSLock()
    private var reply: ((Bool) -> Void)?

    init(_ reply: @escaping (Bool) -> Void) { self.reply = reply }

    func callAsFunction(_ accepted: Bool) {
        lock.lock()
        let pending = reply
        reply = nil
        lock.unlock()
        pending?(accepted)
    }

    deinit { reply?(false) }
}

/// The strip under an island: title, a two-line preview, "Review & Send".
final class IslandResultStripView: UIView {
    private let titleLabel = UILabel()
    private let previewLabel = UILabel()
    private let button = UIButton(type: .system)
    private(set) var result: IslandStateStore.Result?
    var onReview: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        accessibilityIdentifier = "chat.islandResult"
        titleLabel.numberOfLines = 1
        titleLabel.adjustsFontForContentSizeCategory = false
        previewLabel.numberOfLines = IslandResultStrip.previewLines
        previewLabel.lineBreakMode = .byTruncatingTail
        previewLabel.textColor = .secondaryLabel
        var config = UIButton.Configuration.tinted()
        config.cornerStyle = .capsule
        config.contentInsets = IslandResultStrip.buttonInsets
        config.titleLineBreakMode = .byWordWrapping
        button.configuration = config
        button.tintColor = Theme.tintColor
        button.accessibilityIdentifier = "chat.islandResult.review"
        button.addAction(UIAction { [weak self] _ in self?.onReview?() }, for: .touchUpInside)
        addSubview(titleLabel)
        addSubview(previewLabel)
        addSubview(button)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func configure(_ result: IslandStateStore.Result) {
        self.result = result
        titleLabel.font = IslandResultStrip.titleFont
        titleLabel.textColor = result.sent ? .secondaryLabel : .label
        titleLabel.text = IslandResultStrip.titleText(sent: result.sent)
        previewLabel.font = IslandResultStrip.previewFont
        previewLabel.text = IslandResultStrip.previewText(result.text)
        var config = button.configuration
        var title = AttributedString(IslandResultStrip.buttonTitle(sent: result.sent))
        title.font = IslandResultStrip.buttonFont
        config?.attributedTitle = title
        button.configuration = config
        button.accessibilityLabel = IslandResultStrip.buttonTitle(sent: result.sent)
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let pad = IslandResultStrip.padding
        let inner = bounds.width - pad * 2
        guard let result else { return }
        let header = IslandResultStrip.header(result, width: bounds.width)
        titleLabel.numberOfLines = header.stacked ? 0 : 1
        titleLabel.frame = header.title.offsetBy(dx: pad, dy: pad)
        button.frame = header.button.offsetBy(dx: pad, dy: pad)
        let previewY = pad + header.height + IslandResultStrip.lineGap
        previewLabel.frame = CGRect(
            x: pad, y: previewY, width: inner,
            height: IslandResultStrip.previewHeight(result.text, width: bounds.width))
    }
}

/// Everything the user needs before anything is sent: the ENTIRE text, exactly as it
/// will be sent, and the three things to do with it.
struct IslandResultSheet: View {
    let storeKey: String
    @State var result: IslandStateStore.Result
    /// Sends the text as the user's own message; true when the conversation took it.
    let send: (String) async -> Bool
    let close: () -> Void

    private enum SendState { case idle, sending, failed }
    @State private var state: SendState = .idle
    @State private var copied = false

    // UTF-16 units, as the web twin counts them, so one result is sendable on both or neither.
    private var tooLong: Bool { result.text.utf16.count > IslandRuntime.resultMax }
    private var command: Bool { IslandRuntime.isCommandLike(result.text) }
    private var empty: Bool { result.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @Environment(\.dynamicTypeSize) private var typeSize

    /// Copy and Dismiss side by side, or one above the other at the accessibility
    /// sizes, where side by side cut them to "Dis…" (2026-10-30 UI gate).
    private var actionLayout: AnyLayout {
        typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 12)) : AnyLayout(HStackLayout(spacing: 12))
    }

    var body: some View {
        NavigationStack {
            // The WHOLE sheet scrolls, not only the text: at the largest text sizes
            // a scroller for the text alone was squeezed to one line and the notes
            // under it were cut (2026-10-30 UI gate).
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(result.text)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Color(uiColor: .secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityIdentifier("islandResult.text")
                    if result.sent {
                        Label("Sent to the AI", systemImage: "checkmark.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Nothing is sent until you press Send.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if tooLong {
                        Text("Too long to send (\(result.text.utf16.count.formatted()) of \(IslandRuntime.resultMax.formatted()) characters).")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("islandResult.tooLong")
                    }
                    if command {
                        Text("Starts with \u{201C}/\u{201D}, so it would run as a command. Not sendable.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("islandResult.command")
                    }
                    if state == .failed {
                        Text("Not sent. Try again.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("islandResult.failed")
                    }
                    if !result.sent {
                        Button {
                            Task { await sendNow() }
                        } label: {
                            Text(state == .sending ? "Sending\u{2026}" : "Send to AI")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(tooLong || empty || command || state == .sending)
                        .accessibilityIdentifier("islandResult.send")
                    }
                    actionLayout {
                        Button {
                            UIPasteboard.general.string = result.text
                            copied = true
                        } label: {
                            Text(copied ? "Copied" : "Copy").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("islandResult.copy")
                        Button(role: .destructive) {
                            IslandStateStore.shared.dismissResult(key: storeKey)
                            close()
                        } label: {
                            Text("Dismiss result").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(state == .sending)
                        .accessibilityIdentifier("islandResult.dismiss")
                    }
                }
                .padding(16)
            }
            .navigationTitle(result.sent ? "Sent to the AI" : "Result for the AI")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { close() }
                        .accessibilityIdentifier("islandResult.close")
                }
            }
        }
    }

    /// Present the sheet over `host` (a page sheet, medium and large).
    static func present(from host: UIViewController, storeKey: String,
                        result: IslandStateStore.Result,
                        send: @escaping (String) async -> Bool) {
        final class Holder { weak var controller: UIViewController? }
        let holder = Holder()
        let sheet = IslandResultSheet(storeKey: storeKey, result: result, send: send,
                                      close: { holder.controller?.dismiss(animated: true) })
        let controller = UIHostingController(rootView: sheet)
        controller.modalPresentationStyle = .pageSheet
        if let presentation = controller.sheetPresentationController {
            presentation.detents = [.medium(), .large()]
            presentation.prefersGrabberVisible = true
        }
        holder.controller = controller
        host.present(controller, animated: true)
    }

    private func sendNow() async {
        guard !tooLong, !empty, !command, state != .sending else { return }
        state = .sending
        let text = result.text
        let accepted = await send(text)
        AppLog.debug("island", accepted ? "result sent" : "result send failed",
                     ["key": storeKey, "chars": String(text.count)])
        if accepted {
            IslandStateStore.shared.markSent(key: storeKey, text: text)
            result.sent = true
            state = .idle
            close()
        } else {
            state = .failed
        }
    }
}
