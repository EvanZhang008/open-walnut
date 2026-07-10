import SwiftUI
import UIKit
import PhotosUI

/// Apple Notes-style rich editor: UITextView bridged into SwiftUI. Live
/// auto-formats `# `, `- `, `- [ ] ` as they're typed, Return continues/exits
/// lists, checkbox taps toggle in place, images paste/insert inline. The
/// source of truth while editing is the NSAttributedString itself — markdown
/// is only produced on save via MarkdownSerializer.
struct WysiwygEditor: UIViewRepresentable {
    @Binding var attributedText: NSAttributedString
    var isEditable: Bool
    var notePath: String
    var autoFocus: Bool = false
    var onChange: () -> Void
    var onCheckboxToggle: () -> Void

    func makeUIView(context: Context) -> WalnutTextView {
        let textView = WalnutTextView()
        textView.delegate = context.coordinator
        // Apple Notes interaction model: the view is NOT editable while just
        // reading/scrolling — a stationary touch (pausing mid-scroll) must
        // never summon the keyboard. A deliberate quick tap flips into edit
        // mode (see WalnutTextView.beginEditingSession); ending editing flips
        // back. `allowsEditing` gates the whole mechanism (offline = read-only).
        textView.allowsEditing = isEditable
        textView.isEditable = false
        textView.isScrollEnabled = true
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.backgroundColor = .clear
        // Fallback for any run that reaches storage without an explicit
        // foreground color — .label keeps it visible in dark mode.
        textView.textColor = .label
        textView.textContainerInset = UIEdgeInsets(top: 14, left: 20, bottom: 40, right: 20)
        textView.textContainer.lineFragmentPadding = 0
        textView.attributedText = attributedText
        textView.typingAttributes = MarkdownAttributed.typingAttributes(for: .body)
        textView.coordinator = context.coordinator
        textView.inputAccessoryView = context.coordinator.makeAccessoryBar(for: textView)
        // The accessory bar lives in the system keyboard window. If the app
        // backgrounds while editing, that window can survive and float over
        // the wallpaper — resign focus so it tears down with the keyboard.
        NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main
        ) { [weak textView] _ in
            MainActor.assumeIsolated {
                _ = textView?.resignFirstResponder()
            }
        }
        MarkdownAttributed.kickOffImageLoads(in: textView, maxWidth: context.coordinator.imageWidth(for: textView))
        textView.refreshAttachmentAppearance()
        if autoFocus {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak textView] in
                guard let textView else { return }
                textView.beginEditingSession(at: NSRange(location: textView.textStorage.length, length: 0))
            }
        }
        return textView
    }

    func updateUIView(_ textView: WalnutTextView, context: Context) {
        context.coordinator.parent = self
        textView.allowsEditing = isEditable
        // Don't clobber isEditable mid-session — the tap that entered edit
        // mode owns it until textViewDidEndEditing hands it back. Going
        // read-only (offline) does force the session closed.
        if !isEditable, textView.isEditable {
            textView.isEditable = false
            _ = textView.resignFirstResponder()
        }
        if !context.coordinator.isInternalUpdate, textView.attributedText != attributedText {
            let selected = textView.selectedRange
            textView.attributedText = attributedText
            textView.selectedRange = selected
            MarkdownAttributed.kickOffImageLoads(in: textView, maxWidth: context.coordinator.imageWidth(for: textView))
            textView.refreshAttachmentAppearance()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: WysiwygEditor
        /// True while we're pushing a programmatic edit into the text view, so
        /// `updateUIView` doesn't fight the cursor mid-keystroke.
        var isInternalUpdate = false
        /// Trait attributes toggled at a collapsed caret ("type bold from
        /// here"). UIKit's typingAttributes get silently reset on several
        /// input paths (hardware-keyboard insertion among them), so while this
        /// is set the coordinator inserts typed text itself with these attrs.
        /// Cleared on caret taps and Return.
        var stickyTypingAttrs: [NSAttributedString.Key: Any]?
        init(_ parent: WysiwygEditor) {
            self.parent = parent
        }

        func imageWidth(for textView: UITextView) -> CGFloat {
            let inset = textView.textContainerInset
            let width = textView.bounds.width - inset.left - inset.right
            return width > 0 ? width : UIScreen.main.bounds.width - 32
        }

        // MARK: - Typing

        func textViewDidChange(_ textView: UITextView) {
            guard !isInternalUpdate else { return }
            ensureVisibleTextColor(textView)
            updateTypingAttributes(textView)
            isInternalUpdate = true
            parent.attributedText = textView.attributedText
            isInternalUpdate = false
            parent.onChange()
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            // Back to read/scroll mode — a stationary touch (pausing
            // mid-scroll) can't summon the keyboard until the next real tap.
            textView.isEditable = false
        }

        /// UIKit silently resets typingAttributes on several input paths (IME
        /// marked-text commit, hardware keyboards), dropping .foregroundColor —
        /// that text then renders BLACK regardless of appearance (invisible in
        /// dark mode). Re-add a dynamic color to any run that reaches storage
        /// without one.
        private func ensureVisibleTextColor(_ textView: UITextView) {
            let storage = textView.textStorage
            guard storage.length > 0 else { return }
            var fixes: [(NSRange, UIColor)] = []
            storage.enumerateAttributes(in: NSRange(location: 0, length: storage.length), options: []) { attrs, range, _ in
                guard attrs[.foregroundColor] == nil, attrs[.attachment] == nil else { return }
                let kind = (attrs[.walnutBlock] as? WalnutBlockKind) ?? .body
                fixes.append((range, MarkdownAttributed.color(for: kind)))
            }
            for (range, color) in fixes {
                storage.addAttribute(.foregroundColor, value: color, range: range)
            }
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            // A selection change NOT caused by our own insertion means the
            // user moved the caret — drop the caret-toggled trait state.
            guard !isInternalUpdate else { return }
            stickyTypingAttrs = nil
        }

        /// Keep typingAttributes in sync with the paragraph the caret is in, so
        /// e.g. typing right after a heading doesn't inherit heading styling
        /// forever, and continuing a bullet keeps list attributes.
        private func updateTypingAttributes(_ textView: UITextView) {
            let loc = textView.selectedRange.location
            guard loc > 0, textView.textStorage.length > 0 else {
                textView.typingAttributes = MarkdownAttributed.typingAttributes(for: .body)
                return
            }
            let probe = min(loc - 1, textView.textStorage.length - 1)
            let attrs = textView.textStorage.attributes(at: probe, effectiveRange: nil)
            var typing = attrs
            typing.removeValue(forKey: .attachment)
            typing.removeValue(forKey: .walnutDelimOpen)
            typing.removeValue(forKey: .walnutDelimClose)
            if typing[.foregroundColor] == nil {
                let kind = (typing[.walnutBlock] as? WalnutBlockKind) ?? .body
                typing[.foregroundColor] = MarkdownAttributed.color(for: kind)
            }
            textView.typingAttributes = typing
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n" {
                stickyTypingAttrs = nil
                return handleReturn(textView, range: range)
            }
            // Caret-toggled trait active: insert the text ourselves with the
            // sticky attributes (typingAttributes alone gets reset by UIKit
            // on some input paths — hardware keyboard included).
            if let sticky = stickyTypingAttrs, !text.isEmpty {
                isInternalUpdate = true
                textView.textStorage.replaceCharacters(
                    in: range, with: NSAttributedString(string: text, attributes: sticky)
                )
                textView.selectedRange = NSRange(location: range.location + (text as NSString).length, length: 0)
                textView.typingAttributes = sticky
                isInternalUpdate = false
                parent.attributedText = textView.attributedText
                parent.onChange()
                return false
            }
            if text.isEmpty, range.length == 1 {
                if let attachment = textView.textStorage.attribute(.attachment, at: range.location, effectiveRange: nil),
                   attachment is CheckboxAttachment {
                    // Deleting a checkbox: fall through to default (removes the
                    // attachment run), block kind reverts to body automatically.
                    return true
                }
            }
            if range.length == 0, text.count == 1, let scalar = text.unicodeScalars.first,
               CharacterSet(charactersIn: " ").contains(scalar) {
                maybeAutoFormat(textView, insertionPoint: range.location)
            }
            return true
        }

        /// Watches for `#`+space, `-`+space, `- [ ]`+space just typed, and
        /// converts the run into a styled block / dot / checkbox in place.
        /// The conversions run async because they fire from shouldChangeTextIn,
        /// BEFORE the triggering space lands — `typedLen` counts include it.
        private func maybeAutoFormat(_ textView: UITextView, insertionPoint: Int) {
            let storage = textView.textStorage
            let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: insertionPoint, length: 0))
            let lineText = (storage.string as NSString).substring(with: NSRange(location: lineRange.location, length: insertionPoint - lineRange.location))

            if lineText == "#" || lineText == "##" || lineText == "###" {
                let level = lineText.count
                DispatchQueue.main.async { [weak self] in
                    self?.convertToHeading(textView, lineStart: lineRange.location, typedLen: level + 1, level: level)
                }
                return
            }
            if lineText == "-" || lineText == "*" {
                DispatchQueue.main.async { [weak self] in
                    self?.convertShorthand(textView, lineStart: lineRange.location, typedLen: 2, attachment: BulletAttachment(source: "- "), kind: .bullet(prefix: "- "))
                }
                return
            }
            if lineText == "-[]" || lineText == "- []" {
                let typedLen = (lineText as NSString).length + 1
                DispatchQueue.main.async { [weak self] in
                    self?.convertShorthand(textView, lineStart: lineRange.location, typedLen: typedLen, attachment: CheckboxAttachment(source: "- [ ] ", checked: false), kind: .task)
                }
                return
            }
        }

        /// `# ` shorthand → delete it and switch the line to hidden-prefix
        /// heading styling (the serializer re-emits the hashes on save).
        private func convertToHeading(_ textView: UITextView, lineStart: Int, typedLen: Int, level: Int) {
            let storage = textView.textStorage
            guard lineStart + typedLen <= storage.length else { return }
            isInternalUpdate = true
            storage.deleteCharacters(in: NSRange(location: lineStart, length: typedLen))
            let attrs = MarkdownAttributed.typingAttributes(for: .heading(prefix: String(repeating: "#", count: level) + " "))
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: lineStart, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        /// `- ` / `- [ ] ` shorthand → replace with a dot / checkbox attachment.
        private func convertShorthand(_ textView: UITextView, lineStart: Int, typedLen: Int, attachment: NSTextAttachment, kind: WalnutBlockKind) {
            let storage = textView.textStorage
            guard lineStart + typedLen <= storage.length else { return }
            isInternalUpdate = true
            let attrs = MarkdownAttributed.typingAttributes(for: kind)
            let replacement = NSMutableAttributedString(attachment: attachment)
            replacement.addAttributes(attrs, range: NSRange(location: 0, length: 1))
            storage.replaceCharacters(in: NSRange(location: lineStart, length: typedLen), with: replacement)
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: lineStart + 1, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        /// Return inside a list continues it (new bullet/task); Return on an
        /// EMPTY list item exits the list (reverts that line to body).
        private func handleReturn(_ textView: UITextView, range: NSRange) -> Bool {
            let storage = textView.textStorage
            let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: range.location, length: 0))
            let attrsAtLineStart = lineRange.location < storage.length
                ? storage.attributes(at: lineRange.location, effectiveRange: nil)
                : [:]
            let kind = (attrsAtLineStart[.walnutBlock] as? WalnutBlockKind) ?? .body

            let contentStart: Int
            switch kind {
            case .bullet, .numbered, .task, .heading, .quote:
                contentStart = attachmentAwareContentStart(storage, lineRange: lineRange)
            default:
                contentStart = -1
            }

            guard contentStart >= 0 else { return true }
            let isEmpty = range.location <= contentStart

            isInternalUpdate = true
            if isEmpty {
                // Exit the list/heading: strip the prefix, revert to body.
                let prefixRange = NSRange(location: lineRange.location, length: contentStart - lineRange.location)
                if prefixRange.length > 0 { storage.deleteCharacters(in: prefixRange) }
                if lineRange.location < storage.length {
                    storage.addAttributes(
                        MarkdownAttributed.typingAttributes(for: .body),
                        range: NSRange(location: lineRange.location, length: 0)
                    )
                }
                let bodyAttrs = MarkdownAttributed.typingAttributes(for: .body)
                textView.typingAttributes = bodyAttrs
                textView.selectedRange = NSRange(location: lineRange.location, length: 0)
            } else {
                switch kind {
                case .bullet(let prefix):
                    insertAttachmentContinuation(textView, at: range.location, attachment: BulletAttachment(source: prefix), kind: .bullet(prefix: prefix))
                case .numbered(let prefix):
                    let number = (prefix.trimmingCharacters(in: .whitespaces).dropLast()).description
                    let next = (Int(number) ?? 0) + 1
                    let suffix = prefix.hasSuffix(") ") ? ") " : ". "
                    let newPrefix = "\(next)\(suffix)"
                    insertContinuation(textView, at: range.location, literal: "\n" + newPrefix, kind: .numbered(prefix: newPrefix))
                case .task:
                    insertAttachmentContinuation(textView, at: range.location, attachment: CheckboxAttachment(source: "- [ ] ", checked: false), kind: .task)
                default:
                    insertContinuation(textView, at: range.location, literal: "\n", kind: .body)
                }
            }
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
            return false
        }

        private func insertContinuation(_ textView: UITextView, at location: Int, literal: String, kind: WalnutBlockKind) {
            let attrs = MarkdownAttributed.typingAttributes(for: kind)
            textView.textStorage.insert(NSAttributedString(string: literal, attributes: attrs), at: location)
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: location + (literal as NSString).length, length: 0)
        }

        /// Newline + a dot/checkbox attachment — bullet & task continuation.
        private func insertAttachmentContinuation(_ textView: UITextView, at location: Int, attachment: NSTextAttachment, kind: WalnutBlockKind) {
            let attrs = MarkdownAttributed.typingAttributes(for: kind)
            let piece = NSMutableAttributedString(string: "\n")
            piece.append(NSAttributedString(attachment: attachment))
            piece.addAttributes(attrs, range: NSRange(location: 1, length: 1))
            textView.textStorage.insert(piece, at: location)
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: location + piece.length, length: 0)
        }

        /// First content index on the line — past the dot/checkbox attachment
        /// for bullet/task lines, or past the literal prefix string otherwise.
        private func attachmentAwareContentStart(_ storage: NSTextStorage, lineRange: NSRange) -> Int {
            guard lineRange.length > 0 else { return lineRange.location }
            let attrs = storage.attributes(at: lineRange.location, effectiveRange: nil)
            if attrs[.attachment] is CheckboxAttachment || attrs[.attachment] is BulletAttachment {
                return lineRange.location + 1
            }
            if let kind = attrs[.walnutBlock] as? WalnutBlockKind {
                switch kind {
                case .quote(let p), .numbered(let p):
                    return lineRange.location + (p as NSString).length
                case .heading:
                    return lineRange.location // prefix hidden — content starts at line start
                default:
                    break
                }
            }
            return lineRange.location
        }

        // MARK: - Checkbox tap

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            defaultAction
        }

        /// Attachment tap handling (checkbox toggle, table editor). Returns
        /// true when the tap was consumed so WalnutTextView doesn't also
        /// treat it as a begin-editing / caret-placement tap.
        @discardableResult
        @objc func handleTap(_ gesture: UITapGestureRecognizer, in textView: UITextView) -> Bool {
            let point = gesture.location(in: textView)
            // A live table editor owns taps inside itself (cells + pill);
            // any tap outside commits it — Apple Notes behavior.
            if let editor = activeTableEditor {
                let local = editor.convert(point, from: textView)
                if editor.point(inside: local, with: nil) { return true }
                editor.commit()
                return true
            }
            let adjusted = CGPoint(x: point.x - textView.textContainerInset.left, y: point.y - textView.textContainerInset.top)
            let index = textView.layoutManager.characterIndex(
                for: adjusted, in: textView.textContainer, fractionOfDistanceBetweenInsertionPoints: nil
            )
            guard index < textView.textStorage.length else { return false }
            // The glyph the tap actually landed on — characterIndex clamps to
            // the NEAREST glyph, which would toggle a checkbox from a tap in
            // the blank area right of the row (where users tap to edit text).
            let glyphRect = textView.layoutManager.boundingRect(
                forGlyphRange: NSRange(location: index, length: 1), in: textView.textContainer
            ).insetBy(dx: -8, dy: -8) // forgiving hit slop for small markers
            guard glyphRect.contains(adjusted) else { return false }
            let value = textView.textStorage.attribute(.attachment, at: index, effectiveRange: nil)
            if let checkbox = value as? CheckboxAttachment {
                checkbox.toggle()
                isInternalUpdate = true
                textView.textStorage.edited(.editedAttributes, range: NSRange(location: index, length: 1), changeInLength: 0)
                isInternalUpdate = false
                parent.attributedText = textView.attributedText
                parent.onCheckboxToggle()
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                return true
            }
            if let table = value as? TableAttachment {
                presentTableEditor(for: table, at: index, in: textView, tapPoint: point)
                return true
            }
            return false
        }

        // MARK: - Table editing (in-place overlay, Apple Notes style)

        weak var activeTableEditor: TableInlineEditor?

        private func presentTableEditor(
            for attachment: TableAttachment, at index: Int, in textView: UITextView, tapPoint: CGPoint?
        ) {
            guard activeTableEditor == nil else { return }
            // Re-render the attachment glyph for a size change so the note
            // reflows around the overlay live (add/remove row/column).
            let liveResize: (EditableTable) -> Void = { [weak self, weak textView] updated in
                guard let self, let textView else { return }
                self.isInternalUpdate = true
                attachment.update(table: updated)
                textView.textStorage.edited(
                    .editedAttributes, range: NSRange(location: index, length: 1), changeInLength: 0
                )
                textView.layoutManager.invalidateLayout(
                    forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil
                )
                textView.layoutManager.ensureLayout(for: textView.textContainer)
                self.isInternalUpdate = false
            }
            let editor = TableInlineEditor(
                attachment: attachment, charIndex: index, in: textView,
                onLiveResize: liveResize,
                onCommit: { [weak self, weak textView] final in
                    guard let self, let textView else { return }
                    self.activeTableEditor?.removeFromSuperview()
                    self.activeTableEditor = nil
                    self.isInternalUpdate = true
                    if let final {
                        attachment.update(table: final)
                        textView.textStorage.edited(
                            .editedAttributes, range: NSRange(location: index, length: 1), changeInLength: 0
                        )
                        textView.layoutManager.invalidateLayout(
                            forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil
                        )
                    } else {
                        // Delete the attachment char + its trailing newline if present.
                        var range = NSRange(location: index, length: 1)
                        let ns = textView.textStorage.string as NSString
                        if index + 1 < ns.length, ns.character(at: index + 1) == 10 { range.length = 2 }
                        textView.textStorage.deleteCharacters(in: range)
                    }
                    self.isInternalUpdate = false
                    self.parent.attributedText = textView.attributedText
                    self.parent.onChange()
                }
            )
            textView.addSubview(editor)
            activeTableEditor = editor
            editor.beginEditing(preferredPoint: tapPoint)
        }

        // MARK: - Image paste / insert

        func insertImage(_ image: UIImage, into textView: UITextView, uploadedPath: String) {
            // Seed BEFORE constructing the attachment — loadIfNeeded's async
            // fetch checks the memory cache first, so seeding first means it
            // resolves synchronously on the next run loop turn instead of
            // racing a real network round-trip.
            AttachmentLoader.shared.seed(image, for: uploadedPath)
            let width = imageWidth(for: textView)
            let attachment = RemoteImageAttachment(source: "![[\(uploadedPath)]]", rawPath: uploadedPath, maxWidth: width)
            let piece = NSMutableAttributedString(string: "\n")
            piece.append(NSAttributedString(attachment: attachment))
            piece.append(NSAttributedString(string: "\n", attributes: MarkdownAttributed.typingAttributes(for: .body)))
            let loc = textView.selectedRange.location
            isInternalUpdate = true
            textView.textStorage.insert(piece, at: loc)
            textView.typingAttributes = MarkdownAttributed.typingAttributes(for: .body)
            textView.selectedRange = NSRange(location: loc + piece.length, length: 0)
            isInternalUpdate = false
            attachment.loadIfNeeded(maxWidth: width, in: textView)
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        // MARK: - Format card actions

        /// Rewrite the current line's block identity — strips whatever marker
        /// (dot/checkbox attachment or literal numbered/quote prefix) is there
        /// now, then applies the new one. Heading/body are pure attribute
        /// changes; bullet inserts a dot attachment; numbered inserts "1. ".
        func applyParagraphStyle(_ kind: WalnutBlockKind, to textView: UITextView) {
            let storage = textView.textStorage
            let caret = textView.selectedRange.location
            let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: min(caret, storage.length), length: 0))
            let contentStart = attachmentAwareContentStart(storage, lineRange: lineRange)

            isInternalUpdate = true
            // 1) Strip the existing marker.
            let markerLen = contentStart - lineRange.location
            if markerLen > 0 {
                storage.deleteCharacters(in: NSRange(location: lineRange.location, length: markerLen))
            }
            var lineLen = lineRange.length - markerLen
            if lineLen > 0, (storage.string as NSString).character(at: lineRange.location + lineLen - 1) == 10 {
                lineLen -= 1 // don't restyle the trailing newline into the block
            }

            // 2) Apply the new identity.
            let attrs = MarkdownAttributed.typingAttributes(for: kind)
            switch kind {
            case .bullet(let prefix):
                let piece = NSMutableAttributedString(attachment: BulletAttachment(source: prefix))
                piece.addAttributes(attrs, range: NSRange(location: 0, length: 1))
                storage.insert(piece, at: lineRange.location)
                lineLen += 1
            case .numbered(let prefix), .quote(let prefix):
                // Literal-prefix blocks — the serializer re-emits the `1. ` /
                // `> ` from the line text, so it must be inserted here.
                storage.insert(NSAttributedString(string: prefix, attributes: attrs), at: lineRange.location)
                lineLen += (prefix as NSString).length
            case .task:
                let piece = NSMutableAttributedString(attachment: CheckboxAttachment(source: "- [ ] ", checked: false))
                piece.addAttributes(attrs, range: NSRange(location: 0, length: 1))
                storage.insert(piece, at: lineRange.location)
                lineLen += 1
            default:
                break // body/heading are attribute-only
            }
            if lineLen > 0 {
                storage.addAttributes(attrs, range: NSRange(location: lineRange.location, length: lineLen))
            }
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: lineRange.location + lineLen, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        /// Increase/decrease the leading indent (±2 spaces) of the current
        /// bullet / numbered / task line; no-op on any other paragraph kind.
        /// The indent lives in each marker's exact source (so it round-trips)
        /// and in the paragraph style's headIndent (so it renders).
        func adjustIndent(_ delta: Int, in textView: UITextView) {
            let storage = textView.textStorage
            let caret = textView.selectedRange.location
            let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: min(caret, storage.length), length: 0))
            guard lineRange.length > 0, lineRange.location < storage.length else { return }
            let attrs = storage.attributes(at: lineRange.location, effectiveRange: nil)
            let kind = (attrs[.walnutBlock] as? WalnutBlockKind) ?? .body

            var lengthDelta = 0
            isInternalUpdate = true
            switch kind {
            case .bullet:
                guard let dot = attrs[.attachment] as? BulletAttachment else { isInternalUpdate = false; return }
                let newSource = reindentedSource(dot.source, delta: delta)
                let lineAttrs = MarkdownAttributed.typingAttributes(for: .bullet(prefix: newSource))
                let piece = NSMutableAttributedString(attachment: BulletAttachment(source: newSource))
                piece.addAttributes(lineAttrs, range: NSRange(location: 0, length: 1))
                storage.replaceCharacters(in: NSRange(location: lineRange.location, length: 1), with: piece)
                applyLineAttributes(storage, lineStart: lineRange.location, attrs: lineAttrs)
            case .task:
                guard let box = attrs[.attachment] as? CheckboxAttachment else { isInternalUpdate = false; return }
                let newSource = reindentedSource(box.source, delta: delta)
                let lineAttrs = MarkdownAttributed.taskAttributes(
                    leadingSpaces: newSource.prefix(while: { $0 == " " }).count
                )
                let piece = NSMutableAttributedString(attachment: CheckboxAttachment(source: newSource, checked: box.checked))
                piece.addAttributes(lineAttrs, range: NSRange(location: 0, length: 1))
                storage.replaceCharacters(in: NSRange(location: lineRange.location, length: 1), with: piece)
                applyLineAttributes(storage, lineStart: lineRange.location, attrs: lineAttrs)
            case .numbered(let prefix):
                let newPrefix = reindentedSource(prefix, delta: delta)
                guard newPrefix != prefix else { isInternalUpdate = false; return }
                let lineAttrs = MarkdownAttributed.typingAttributes(for: .numbered(prefix: newPrefix))
                let oldSpaces = prefix.prefix(while: { $0 == " " }).count
                let newSpaces = newPrefix.prefix(while: { $0 == " " }).count
                if newSpaces > oldSpaces {
                    let pad = String(repeating: " ", count: newSpaces - oldSpaces)
                    storage.insert(NSAttributedString(string: pad, attributes: lineAttrs), at: lineRange.location)
                    lengthDelta = newSpaces - oldSpaces
                } else {
                    storage.deleteCharacters(in: NSRange(location: lineRange.location, length: oldSpaces - newSpaces))
                    lengthDelta = -(oldSpaces - newSpaces)
                }
                applyLineAttributes(storage, lineStart: lineRange.location, attrs: lineAttrs)
            default:
                isInternalUpdate = false
                return // no-op for non-list lines
            }
            let newCaret = max(lineRange.location, min(caret + lengthDelta, storage.length))
            textView.selectedRange = NSRange(location: newCaret, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        private func reindentedSource(_ source: String, delta: Int) -> String {
            let leading = source.prefix(while: { $0 == " " }).count
            let rest = String(source.dropFirst(leading))
            let newLeading = max(0, leading + delta * 2)
            return String(repeating: " ", count: newLeading) + rest
        }

        /// Re-apply block attributes across a whole line, excluding its trailing
        /// newline so the next paragraph's identity is untouched.
        private func applyLineAttributes(_ storage: NSTextStorage, lineStart: Int, attrs: [NSAttributedString.Key: Any]) {
            let lineRange = (storage.string as NSString).lineRange(for: NSRange(location: min(lineStart, storage.length), length: 0))
            var len = lineRange.length
            if len > 0, (storage.string as NSString).character(at: lineRange.location + len - 1) == 10 { len -= 1 }
            guard len > 0 else { return }
            storage.addAttributes(attrs, range: NSRange(location: lineRange.location, length: len))
        }

        /// Toggle a character trait (bold/italic/underline/strike) over the
        /// selection, or fold it into typingAttributes for the next keystroke
        /// when nothing is selected — same as Apple Notes.
        func toggleTrait(_ trait: MarkdownAttributed.InlineTrait, in textView: UITextView) {
            let range = textView.selectedRange
            isInternalUpdate = true
            if range.length == 0 {
                var attrs = stickyTypingAttrs ?? textView.typingAttributes
                let isOn = traitIsActive(trait, in: attrs)
                if isOn {
                    removeTrait(trait, from: &attrs)
                } else {
                    MarkdownAttributed.applyTrait(trait, to: &attrs)
                }
                textView.typingAttributes = attrs
                stickyTypingAttrs = attrs
            } else {
                let storage = textView.textStorage
                let currentAttrs = storage.attributes(at: range.location, effectiveRange: nil)
                let isOn = traitIsActive(trait, in: currentAttrs)
                storage.enumerateAttributes(in: range, options: []) { attrs, subrange, _ in
                    var updated = attrs
                    if isOn {
                        removeTrait(trait, from: &updated)
                    } else {
                        MarkdownAttributed.applyTrait(trait, to: &updated)
                    }
                    storage.setAttributes(updated, range: subrange)
                }
            }
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        private func traitIsActive(_ trait: MarkdownAttributed.InlineTrait, in attrs: [NSAttributedString.Key: Any]) -> Bool {
            switch trait {
            case .bold:
                return ((attrs[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitBold)) ?? false
            case .italic:
                return ((attrs[.font] as? UIFont)?.fontDescriptor.symbolicTraits.contains(.traitItalic)) ?? false
            case .underline:
                return ((attrs[.underlineStyle] as? Int) ?? 0) != 0
            case .strike:
                return ((attrs[.strikethroughStyle] as? Int) ?? 0) != 0
            }
        }

        private func removeTrait(_ trait: MarkdownAttributed.InlineTrait, from attrs: inout [NSAttributedString.Key: Any]) {
            switch trait {
            case .bold:
                if let font = attrs[.font] as? UIFont {
                    let stripped = font.fontDescriptor.symbolicTraits.subtracting(.traitBold)
                    if let descriptor = font.fontDescriptor.withSymbolicTraits(stripped) {
                        attrs[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
                    }
                }
            case .italic:
                if let font = attrs[.font] as? UIFont {
                    let stripped = font.fontDescriptor.symbolicTraits.subtracting(.traitItalic)
                    if let descriptor = font.fontDescriptor.withSymbolicTraits(stripped) {
                        attrs[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
                    }
                }
            case .underline:
                attrs.removeValue(forKey: .underlineStyle)
            case .strike:
                attrs.removeValue(forKey: .strikethroughStyle)
            }
            attrs.removeValue(forKey: .walnutDelimOpen)
            attrs.removeValue(forKey: .walnutDelimClose)
        }

        /// Insert a fresh checkbox line at the caret (new line if mid-paragraph).
        func insertTaskLine(in textView: UITextView) {
            let storage = textView.textStorage
            let loc = textView.selectedRange.location
            let needsNewline = loc > 0 && (storage.string as NSString).character(at: loc - 1) != 10
            isInternalUpdate = true
            let piece = NSMutableAttributedString(string: needsNewline ? "\n" : "")
            let attachment = CheckboxAttachment(source: "- [ ] ", checked: false)
            piece.append(NSAttributedString(attachment: attachment))
            storage.insert(piece, at: loc)
            let attrs = MarkdownAttributed.typingAttributes(for: .task)
            let attachmentLoc = loc + (needsNewline ? 1 : 0)
            storage.addAttributes(attrs, range: NSRange(location: attachmentLoc, length: piece.length - (needsNewline ? 1 : 0)))
            textView.typingAttributes = attrs
            textView.selectedRange = NSRange(location: loc + piece.length, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
        }

        /// Insert a real 2x2 grid attachment at the caret and immediately
        /// open the cell editor — like Apple Notes' table button.
        func insertTableSkeleton(in textView: UITextView) {
            let storage = textView.textStorage
            let loc = textView.selectedRange.location
            let needsNewline = loc > 0 && (storage.string as NSString).character(at: loc - 1) != 10
            let attachment = TableAttachment(
                table: .empty(), maxWidth: imageWidth(for: textView)
            )
            isInternalUpdate = true
            let piece = NSMutableAttributedString(string: needsNewline ? "\n" : "")
            piece.append(NSAttributedString(attachment: attachment))
            piece.append(NSAttributedString(string: "\n", attributes: MarkdownAttributed.typingAttributes(for: .body)))
            piece.addAttributes(
                MarkdownAttributed.typingAttributes(for: .body),
                range: NSRange(location: needsNewline ? 1 : 0, length: 1)
            )
            storage.insert(piece, at: loc)
            textView.typingAttributes = MarkdownAttributed.typingAttributes(for: .body)
            textView.selectedRange = NSRange(location: loc + piece.length, length: 0)
            isInternalUpdate = false
            parent.attributedText = textView.attributedText
            parent.onChange()
            let attachmentIndex = loc + (needsNewline ? 1 : 0)
            presentTableEditor(for: attachment, at: attachmentIndex, in: textView, tapPoint: nil)
        }

        // MARK: - Accessory bar

        func makeAccessoryBar(for textView: UITextView) -> UIView {
            AccessoryBar(coordinator: self, textView: textView)
        }
    }
}

/// UITextView subclass implementing Apple Notes' read-then-edit model:
/// not editable while scrolling/reading, a deliberate quick TAP begins an
/// edit session (caret at the tap point, keyboard up). Because the view is
/// not editable at rest, UIKit's "stationary touch = intent to edit"
/// heuristic never fires — pausing a finger mid-scroll does nothing.
/// The same tap recognizer also toggles checkboxes and opens table editing.
final class WalnutTextView: UITextView, UIGestureRecognizerDelegate {
    weak var coordinator: WysiwygEditor.Coordinator?
    /// Whether edit sessions may begin at all (false = offline/read-only).
    var allowsEditing = true

    /// The format bar belongs to EDITING only. Long-press text selection in
    /// read mode also makes the view first responder — without this gate the
    /// bar would float up over the tab bar with no keyboard.
    override var inputAccessoryView: UIView? {
        get { isEditable ? super.inputAccessoryView : nil }
        set { super.inputAccessoryView = newValue }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true // coexist with the text view's own tap/selection recognizers
    }

    override func awakeFromNib() {
        super.awakeFromNib()
        setUpTap()
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        setUpTap()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUpTap()
    }

    private func setUpTap() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
        // Must NOT swallow touches — while editing, the text view still needs
        // every tap for caret placement/selection. This recognizer OBSERVES
        // taps: checkbox/table handling always, entering edit mode when idle.
        tap.cancelsTouchesInView = false
        tap.delegate = self
        addGestureRecognizer(tap)
        // Attachment glyphs are baked bitmaps; re-bake them when light/dark
        // changes so bullets/tables stay visible (dynamic colors don't
        // re-resolve inside already-rendered images).
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WalnutTextView, _) in
            view.refreshAttachmentAppearance()
        }
    }

    func refreshAttachmentAppearance() {
        let storage = textStorage
        guard storage.length > 0 else { return }
        let full = NSRange(location: 0, length: storage.length)
        storage.enumerateAttribute(.attachment, in: full) { value, range, _ in
            switch value {
            case let bullet as BulletAttachment:
                bullet.rerender(for: traitCollection)
            case let table as TableAttachment:
                table.rerender(for: traitCollection)
            default:
                return
            }
            storage.edited(.editedAttributes, range: range, changeInLength: 0)
            layoutManager.invalidateDisplay(forCharacterRange: range)
        }
    }

    @objc private func onTap(_ gesture: UITapGestureRecognizer) {
        // Attachment interactions (checkbox toggle, table editor) win over
        // caret placement in BOTH modes — handleTap reports whether it acted.
        if coordinator?.handleTap(gesture, in: self) == true { return }
        guard allowsEditing, !isEditable else { return }
        // A recognized TAP is already disambiguated from a scroll by UIKit —
        // scrolls and long stationary holds never reach here.
        let point = gesture.location(in: self)
        let adjusted = CGPoint(x: point.x - textContainerInset.left, y: point.y - textContainerInset.top)
        let index = layoutManager.characterIndex(
            for: adjusted, in: textContainer, fractionOfDistanceBetweenInsertionPoints: nil
        )
        // Tapping past the last line targets the end of the note.
        let location = index >= textStorage.length ? textStorage.length : caretIndex(near: adjusted, rawIndex: index)
        beginEditingSession(at: NSRange(location: location, length: 0))
    }

    /// Flip into edit mode with the caret placed — the ONLY entry point to
    /// editing (autoFocus for brand-new notes uses it too).
    func beginEditingSession(at range: NSRange) {
        guard allowsEditing else { return }
        isEditable = true
        selectedRange = range
        becomeFirstResponder()
    }

    /// characterIndex(for:) clamps to the nearest glyph; when the tap lands in
    /// the right half of a character the caret belongs AFTER it.
    private func caretIndex(near point: CGPoint, rawIndex: Int) -> Int {
        var fraction: CGFloat = 0
        _ = layoutManager.characterIndex(
            for: point, in: textContainer, fractionOfDistanceBetweenInsertionPoints: &fraction
        )
        return fraction > 0.5 ? min(rawIndex + 1, textStorage.length) : rawIndex
    }

    override func paste(_ sender: Any?) {
        let pasteboard = UIPasteboard.general
        if pasteboard.hasImages, let image = pasteboard.image {
            coordinator?.uploadAndInsert(image, into: self)
            return
        }
        // Simulator pasteboard bridge quirk: image sometimes only lands as an
        // itemProvider even though `.hasImages` reflects the real device path.
        if let provider = pasteboard.itemProviders.first, provider.canLoadObject(ofClass: UIImage.self) {
            provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
                guard let self, let image = object as? UIImage else { return }
                DispatchQueue.main.async {
                    self.coordinator?.uploadAndInsert(image, into: self)
                }
            }
            return
        }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            return UIPasteboard.general.hasImages || UIPasteboard.general.hasStrings
        }
        return super.canPerformAction(action, withSender: sender)
    }
}

extension WysiwygEditor.Coordinator {
    /// Upload to the vault then insert an attachment referencing the final
    /// server path — mirrors the web UI's paste-to-attachment flow.
    func uploadAndInsert(_ image: UIImage, into textView: UITextView) {
        let notePath = parent.notePath
        Task { @MainActor in
            guard let data = image.jpegData(compressionQuality: 0.85) else { return }
            do {
                let result = try await WalnutAPI().uploadAttachment(notePath: notePath, data: data, mediaType: "image/jpeg")
                insertImage(image, into: textView, uploadedPath: result.path)
            } catch {
                // Silent failure is acceptable here — paste is best-effort and
                // the user still has the image on their pasteboard to retry.
            }
        }
    }
}
