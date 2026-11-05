import SwiftUI
import os

private let revealLog = Logger(subsystem: "dev.openwalnut.ios", category: "ask-card-reveal")

/// The pending-permission cards above a session's transcript, in a scroll box of
/// their own. The page pins its content to the height it was offered (so the
/// composer never slides under the keyboard), which means a card taller than that
/// was simply cut off: an AskUserQuestion with several questions lost its later
/// options and its Submit below the fold, and no swipe could reach them. Here the
/// cards take their natural height up to `maxHeight(pageHeight:)` and scroll
/// beyond it, leaving the rest of the page to the transcript.
struct PendingPermissionStack: View {
    let requests: [PendingPermission]
    let pageHeight: CGFloat
    var isAnswering: (PendingPermission) -> Bool
    var onRespond: (PendingPermission, PermissionReply) -> Void
    /// The answers, and the pictures the person put with the last answer.
    var onAnswer: (PendingPermission, [String: String], [SelectedImage]) -> Void
    var onDismissQuestions: (PendingPermission) -> Void

    @State private var naturalHeight: CGFloat = 0
    /// The free-text field being typed in, kept in view when it gains focus,
    /// when the keyboard shrinks the box, and while its text grows a line.
    @State private var focusedField: String?
    /// The field typed in last, kept while the keyboard briefly lets go of it
    /// (a mic take inserts its words with no field focused, then focuses it).
    @State private var lastField: String?
    /// When the last field's row last changed height: its text grew or shrank
    /// a line (typed, Return, an insert), which the scroll must follow.
    @State private var grewAt: Date?
    /// When the person last typed in a field: a field moving or growing right
    /// after it is that field growing a line, which the scroll must follow.
    @State private var typedAt: Date?
    /// Where each free-text box (the field and its mic, keyed by its field id)
    /// is in the content (`contentSpace`), and the scroll box on screen,
    /// measured after every layout.
    @State private var fieldFrames: [String: CGRect] = [:]
    /// The last answer's tail by its field id: the pictures under it and the
    /// Submit row, kept on screen with the field while it is typed in, so the
    /// keyboard never hides them (2026-11-03 gate).
    @State private var tailFrames: [String: CGRect] = [:]
    @State private var boxFrame: CGRect = .zero
    @State private var position = ScrollPosition(edge: .top)
    @State private var scroll = CardScrollGeometry()
    /// A finger is on the cards (or they still glide from its flick): no
    /// reveal then, so a drag is never fought.
    @State private var scrolling = false
    /// When a picture was last put under the last answer: the box shows its
    /// bottom (Submit) once the content takes the new height.
    @State private var picturesAddedAt: Date?

    /// Share of the page the cards may take before they scroll.
    static let pageShare: CGFloat = 0.6
    /// Floor for a very short page (keyboard up on a small phone), so a card is
    /// never squeezed to a sliver; never more than the page itself.
    static let minCap: CGFloat = 180

    nonisolated static func maxHeight(pageHeight: CGFloat) -> CGFloat {
        guard pageHeight > 0 else { return .infinity }
        return min(pageHeight, max(minCap, (pageHeight * pageShare).rounded(.down)))
    }

    /// How far the box must scroll so the field's whole row (its last line, the
    /// mic, and `margin` below for the recording outline) sits inside a box of
    /// `boxHeight`: positive scrolls down, negative up, 0 when it already fits.
    /// The row's bottom wins over its top when the row is taller than the box,
    /// since the cursor and the mic are at the bottom. Pure, so it is unit-tested.
    nonisolated static func revealDelta(rowMinY: CGFloat, rowMaxY: CGFloat, boxHeight: CGFloat, margin: CGFloat) -> CGFloat {
        let below = rowMaxY + margin - boxHeight
        if below > 0.5 { return below }
        let above = rowMinY - margin
        return above < -0.5 ? above : 0
    }

    /// What to keep on screen while `row` is typed in: the row with its card's
    /// tail (the pictures and Submit below the last answer) when both fit the
    /// band, else the row alone, since the cursor matters most. Pure, unit-tested.
    nonisolated static func revealRegion(row: CGRect, tail: CGRect?, bandHeight: CGFloat, margin: CGFloat) -> CGRect {
        guard let tail, tail.height > 0 else { return row }
        let both = row.union(tail)
        return both.height + 2 * margin <= bandHeight ? both : row
    }

    /// The content coordinate space the cards' rows are measured in: scrolling
    /// never moves a row in it, only a layout change does.
    static let contentSpace = "session.permissionStack.content"

    /// Where to scroll so the row fits, in the coordinates `scrollTo(y:)` takes
    /// (0 = the content's top), or nil when it already fits. `row` is in the
    /// content's own coordinates and `visibleTop` is the content y at the top of
    /// the band that shows content (the raw offset plus the top inset: the box
    /// runs under the navigation bar). The target is where the row is, never
    /// where the scroll was: measured on screen, every scroll moved the row and
    /// asked again against an offset not yet updated, and the card swung between
    /// two places every frame for up to 1.5 s (2026-10-28 v10 gate). Pure, unit-tested.
    nonisolated static func revealTarget(row: CGRect, visibleTop: CGFloat, bandHeight: CGFloat, margin: CGFloat) -> CGFloat? {
        guard bandHeight > 0 else { return nil }
        let delta = revealDelta(rowMinY: row.minY - visibleTop, rowMaxY: row.maxY - visibleTop, boxHeight: bandHeight, margin: margin)
        guard delta != 0 else { return nil }
        return max(0, visibleTop + delta)
    }

    /// The `scrollTo(y:)` value that puts content y `bandTop` at the top of the
    /// band: that call aligns y with the box's own top edge, which is under the
    /// navigation bar, so it is the inset short of the band's top (v11 gate:
    /// passing the band's top scrolled every reveal 140pt too far, the row's
    /// first lines under the bar). Pure, unit-tested.
    nonisolated static func scrollY(bandTop: CGFloat, insetTop: CGFloat) -> CGFloat {
        bandTop - insetTop
    }

    /// The box's cap while the last answer is typed in: tall enough for the
    /// field, its pictures and Submit together (`need`, insets included), never
    /// past the page. The keyboard leaves the page short, and the usual share of
    /// it held the field alone (2026-11-03 gate: the strip and Submit sat under
    /// the keyboard). Pure, unit-tested.
    nonisolated static func typingCap(base: CGFloat, pageHeight: CGFloat, need: CGFloat?) -> CGFloat {
        guard let need, need > base else { return base }
        return pageHeight > 0 ? min(need, pageHeight) : need
    }

    /// What the field being typed in needs with its card's tail, when it has one.
    private var tailNeed: CGFloat? {
        guard let field = focusedField, let row = fieldFrames[field], let tail = tailFrames[field] else { return nil }
        return row.union(tail).height + 2 * voiceDictationRevealMargin + scroll.insetTop + scroll.insetBottom
    }

    private var cap: CGFloat {
        Self.typingCap(base: Self.maxHeight(pageHeight: pageHeight), pageHeight: pageHeight, need: tailNeed)
    }

    /// Scrolls the focused field's row into the box by exactly what is cut,
    /// measured on screen. A scroll to the field's id used to pin the bare field
    /// to the edge, which cut the recording outline (4pt outside it); a scroll to
    /// a wider id behind the row missed the newest line now and then, so the
    /// Stop's lower half was cut and a tap there fell through to the transcript
    /// (2026-10-26 v6 gate, 2 of 9).
    /// `anyField`: a row that grew may be the last field's with none focused
    /// (a mic insert); a focus or keyboard change only ever reveals the focused one.
    private func reveal(_ why: String, anyField: Bool = false) {
        guard !scrolling else { revealLog.debug("skip \(why, privacy: .public): scrolling"); return }
        guard let field = focusedField ?? (anyField ? lastField : nil) else { revealLog.debug("skip \(why, privacy: .public): no field"); return }
        guard let row = fieldFrames[field], boxFrame.height > 0 else { revealLog.debug("skip \(why, privacy: .public): no frame"); return }
        let band = boxFrame.height - scroll.insetTop - scroll.insetBottom
        let region = Self.revealRegion(row: row, tail: tailFrames[field], bandHeight: band, margin: voiceDictationRevealMargin)
        guard let y = Self.revealTarget(
            row: region, visibleTop: scroll.offset + scroll.insetTop,
            bandHeight: band, margin: voiceDictationRevealMargin
        ) else { return }
        revealLog.debug("reveal \(why, privacy: .public): y \(y) content \(scroll.contentHeight)")
        position.scrollTo(y: Self.scrollY(bandTop: y, insetTop: scroll.insetTop))
    }

    private func card(_ request: PendingPermission) -> some View {
        PermissionRequestCard(
            request: request,
            answering: isAnswering(request),
            onRespond: { onRespond(request, $0) },
            onAnswer: { onAnswer(request, $0, $1) },
            onDismissQuestions: { onDismissQuestions(request) },
            onFocusField: { id in
                focusedField = id
                if let id { lastField = id }
            },
            onTypeInField: { typedAt = .now },
            onFieldFrame: { id, frame in
                let old = fieldFrames[id]
                fieldFrames[id] = frame
                guard old != frame, id == (focusedField ?? lastField) else { return }
                // A row whose height changed is its text changing (a
                // pick elsewhere only moves it): followed whatever made
                // it, typing, Return or a mic insert with no field
                // focused for a moment (2026-10-28 v9 gate, 6 of 6).
                if let old, abs(old.height - frame.height) > 0.5 { grewAt = .now }
                guard followsTyping else { return }
                // On the next turn of the run loop: the scroll content has
                // not taken the row's new height yet, and a scroll now is
                // clamped to the old bottom (2026-10-28 v8 gate, 3 of 3).
                DispatchQueue.main.async { reveal("row", anyField: true) }
            },
            onTailFrame: { id, frame in
                let old = tailFrames[id]
                tailFrames[id] = frame
                // The tail moved under the field being typed in (a line wrapped,
                // a picture came and its strip appeared): keep them in view with
                // the field. A pick elsewhere on the card moves it too, and is not
                // followed (`followsTyping`).
                let picturesJustCame = picturesAddedAt.map { Date.now.timeIntervalSince($0) < 1 } ?? false
                guard old != frame, id == focusedField, followsTyping || picturesJustCame else { return }
                DispatchQueue.main.async { reveal("tail") }
            },
            onPicturesAdded: {
                picturesAddedAt = .now
                DispatchQueue.main.async { showSubmit() }
            }
        )
    }

    /// A picture put under the last answer grows the card past the box's
    /// fold; the person's next step is Submit, so the box shows its bottom.
    private func showSubmit() {
        guard let picturesAddedAt, Date.now.timeIntervalSince(picturesAddedAt) < 1, !scrolling else { return }
        position.scrollTo(edge: .bottom)
    }

    /// A row that moved right after typing (a wrapped line) or while the box
    /// itself changed size (the keyboard) is followed; one moved by a pick
    /// elsewhere on the card is not, so choosing an option never yanks the
    /// reader back to the field.
    private var followsTyping: Bool {
        if let typedAt, Date.now.timeIntervalSince(typedAt) < 1 { return true }
        if let grewAt, Date.now.timeIntervalSince(grewAt) < 1 { return true }
        return false
    }

    var body: some View {
        if !requests.isEmpty {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(requests) { request in
                        card(request)
                    }
                }
                .padding(.bottom, 6)
                .coordinateSpace(.named(Self.contentSpace))
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { naturalHeight = $0 }
            }
            .scrollPosition($position)
            .onScrollGeometryChange(for: CardScrollGeometry.self) {
                CardScrollGeometry(
                    offset: $0.contentOffset.y, insetTop: $0.contentInsets.top, insetBottom: $0.contentInsets.bottom,
                    contentHeight: $0.contentSize.height
                )
            } action: { old, g in
                scroll = g
                // The content grew under the field being typed in (a new line,
                // an insert): the row may now reach past a bottom the last reveal
                // could not scroll to.
                if g.contentHeight != old.contentHeight, followsTyping {
                    DispatchQueue.main.async { reveal("content", anyField: true) }
                }
                if g.contentHeight > old.contentHeight { DispatchQueue.main.async { showSubmit() } }
            }
            .onScrollPhaseChange { _, phase in scrolling = phase != .idle && phase != .animating }
            .onChange(of: focusedField) { DispatchQueue.main.async { reveal("focus") } }
            // The box shrinks when the keyboard comes up (the cap follows the
            // page): the field being typed in follows the box's new edge.
            .onChange(of: boxFrame.height) { reveal("box") }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicatorsFlash(onAppear: true)
            // Not interactively: the box's own height follows the keyboard, so a
            // drag that tracked the keyboard resized the box under the finger and
            // left the keyboard stuck halfway down.
            .scrollDismissesKeyboard(.immediately)
            .frame(height: min(naturalHeight, cap))
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { boxFrame = $0 }
            // A box cut mid-line sat flush on a transcript also cut mid-line;
            // a hairline marks where the cards end while they scroll.
            .overlay(alignment: .bottom) {
                if naturalHeight > cap { Divider() }
            }
            // Cards scrolled past the box's top edge stay inside it instead of
            // drawing under the navigation bar.
            .clipped()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("session.permissionStack")
        }
    }
}

/// The card box's scroll offset and insets, as the scroll view reports them.
struct CardScrollGeometry: Equatable {
    var offset: CGFloat = 0
    var insetTop: CGFloat = 0
    var insetBottom: CGFloat = 0
    var contentHeight: CGFloat = 0
}

/// Permission-request banner shown at the top of a session conversation page
/// when the CLI is blocked on a tool-permission prompt. One card per pending
/// request (usually a single one — prompts serialize the turn), with the tool
/// name, an input summary, and its answers: the prompt's options when it lists
/// them (Allow for this session, Always allow in this project, an ACP adapter's
/// own), else Allow / Deny, and a note the deny can carry to the agent.
///
/// AskUserQuestion is NOT an Allow/Deny prompt (see AskUserQuestion in
/// ModelsWave1): it carries the agent's actual questions, and the allow
/// response IS the answer. It routes to AskUserQuestionCard instead — the phone
/// used to render it through the generic branch below, where `questions` matches
/// none of the summary keys, so the card showed the bare word
/// "AskUserQuestion" with no question, no options, and an Allow button that
/// answered nothing.
struct PermissionRequestCard: View {
    let request: PendingPermission
    let answering: Bool
    var onRespond: (PermissionReply) -> Void
    /// AskUserQuestion answer submit (answers map) / dismiss (deny + reason).
    /// Optional so existing call sites and previews stay valid.
    var onAnswer: (([String: String], [SelectedImage]) -> Void)?
    var onDismissQuestions: (() -> Void)?
    /// The scroll id of the free-text field gaining focus, nil when it loses it.
    var onFocusField: ((String?) -> Void)?
    /// The focused free-text field's text changed (it may have grown a line).
    var onTypeInField: (() -> Void)?
    /// A free-text box (field and mic) by its field id, and its frame in the
    /// stack's content (`PendingPermissionStack.contentSpace`).
    var onFieldFrame: ((String, CGRect) -> Void)?
    /// The last answer's tail (its pictures and the Submit row) by the last
    /// field's id, in the stack's content.
    var onTailFrame: ((String, CGRect) -> Void)?
    /// A picture was put with the answers.
    var onPicturesAdded: (() -> Void)?

    /// The note the deny carries to the agent (generic card).
    @State private var note = ""
    @FocusState private var noteFocused: Bool
    /// A choice that writes a lasting rule, tapped once: the next tap within 5 s sends it.
    @State private var armed: String?
    @State private var armedAt = Date.distantPast

    var body: some View {
        if let questions = request.askQuestions {
            AskUserQuestionCard(
                questions: questions,
                answering: answering,
                fieldScope: request.requestId,
                onFocusField: onFocusField,
                onTypeInField: onTypeInField,
                onFieldFrame: onFieldFrame,
                onTailFrame: onTailFrame,
                onPicturesAdded: onPicturesAdded,
                onSubmit: { answers, pictures in
                    if let onAnswer { onAnswer(answers, pictures) } else { onRespond(PermissionReply(allow: true)) }
                },
                onDismiss: {
                    if let onDismissQuestions { onDismissQuestions() } else { onRespond(PermissionReply(allow: false)) }
                }
            )
        } else {
            genericCard
        }
    }

    /// The answers this card offers (see `PendingPermission.choices`).
    private var choices: [PermissionChoice] { request.choices }
    /// The deny that carries the note field's words, when the prompt has one.
    private var noteChoice: PermissionChoice? { choices.first(where: \.takesNote) }
    /// The note field's scroll id, unique across cards.
    private var noteFieldID: String { "\(request.requestId)|note" }

    private func send(_ choice: PermissionChoice) {
        guard !answering else { return }
        // A typed note goes only with the deny: an allow would drop it unsaid.
        if choice.allow && PermissionNote.message(note) != nil { return }
        // A rule kept in a file outlives the session: a stray tap never writes it.
        if choice.savedTo != nil && !(armed == choice.id && Date().timeIntervalSince(armedAt) < 5) {
            armed = choice.id
            armedAt = Date()
            let id = choice.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if armed == id { armed = nil } }
            return
        }
        armed = nil
        onRespond(choice.reply(note: note))
    }

    /// The choice is off while a note is typed (the note goes with the deny).
    private func isOff(_ choice: PermissionChoice) -> Bool {
        choice.allow && PermissionNote.message(note) != nil
    }

    private var genericCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lock.shield")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                Text("Permission requested")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if answering { ProgressView().controlSize(.small) }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(request.toolName ?? "Tool")
                    .font(.callout.weight(.medium))
                if let summary = request.inputSummary {
                    Text(summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if let reason = request.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
            choiceButtons
                .disabled(answering)
            if noteChoice != nil { noteField }
        }
        .padding(12)
        .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.warning.opacity(0.35), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        // `.contain` keeps Allow/Deny addressable (see AskUserQuestionCard).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.permissionCard")
    }

    /// The choices: a list of full-width rows when any carries a rule to show
    /// (the remembering options of a Claude prompt), else buttons side by side,
    /// stacked when there are more than two (an ACP prompt's own options).
    @ViewBuilder
    private var choiceButtons: some View {
        let list = choices
        if list.contains(where: { $0.detail != nil }) {
            VStack(spacing: 6) {
                ForEach(list) { choice in
                    choiceRow(choice)
                }
            }
        } else if list.count > 2 {
            VStack(spacing: 6) {
                ForEach(list) { choice in
                    choiceButton(choice)
                }
            }
        } else {
            HStack(spacing: 10) {
                ForEach(list) { choice in
                    choiceButton(choice)
                }
            }
        }
    }

    /// A button like the plain pair's: Allow filled with the tint, Deny in the
    /// danger color on a quiet fill.
    private func choiceButton(_ choice: PermissionChoice) -> some View {
        Button {
            send(choice)
        } label: {
            Text(choice.displayLabel(note: note))
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(
                    choice.allow ? Theme.tint : Color(.tertiarySystemFill),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                )
                .foregroundStyle(choice.allow ? Color.white : Theme.danger)
        }
        .buttonStyle(.plain)
        .disabled(isOff(choice))
        .opacity(isOff(choice) ? 0.45 : 1)
        .accessibilityIdentifier(choice.accessibilityID)
    }

    /// A row of the option list: the label, and under it the rule the option
    /// allows in a small monospaced line (one line, cut in the middle, so the
    /// command's head and its wildcard both stay in view).
    private func choiceRow(_ choice: PermissionChoice) -> some View {
        Button {
            send(choice)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.displayLabel(note: note))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(choice.allow ? Theme.tint : Theme.danger)
                    .fixedSize(horizontal: false, vertical: true)
                if armed == choice.id, let savedTo = choice.savedTo {
                    // Tapped once: what the second tap does, where the file line was.
                    Text("Tap again within 5 s to save to \(savedTo)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.tint)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let detail = choice.detail {
                    // A sentence ("Bash commands starting with npm test"), not code: the system font.
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        // One rule per line; a long rule wraps rather than hides its middle.
                        .lineLimit(6)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                choice.allow ? Theme.tint.opacity(0.14) : Color(.tertiarySystemFill),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Theme.tint, lineWidth: armed == choice.id ? 1.5 : 0)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(isOff(choice))
        .opacity(isOff(choice) ? 0.45 : 1)
        .accessibilityIdentifier(choice.accessibilityID)
    }

    /// The person's words for the agent, sent with the deny that carries them.
    /// Return sends that deny with the note; an empty Return does nothing.
    private var noteField: some View {
        TextField("Or tell the agent what to do instead", text: $note, axis: .vertical)
            .lineLimit(1...3)
            .font(.callout)
            .textFieldStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .submitLabel(.send)
            .disabled(answering)
            .focused($noteFocused)
            // A vertical-axis field inserts the return key's newline instead of
            // firing onSubmit: that newline is the send.
            .onChange(of: note) { old, new in
                onTypeInField?()
                guard PermissionNote.isReturnKey(old: old, new: new) else { return }
                note = old
                if let noteChoice, PermissionNote.message(old) != nil { send(noteChoice) }
            }
            .onChange(of: noteFocused) { _, focused in onFocusField?(focused ? noteFieldID : nil) }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(PendingPermissionStack.contentSpace)) } action: { frame in
                onFieldFrame?(noteFieldID, frame)
            }
            .accessibilityIdentifier("session.permission.note")
    }
}

/// The AskUserQuestion card — the agent's questions, READ IN FULL and ANSWERED
/// on the phone. Mirrors the web console's PermissionAnswerForm.
///
/// Two rules it deliberately encodes, both borrowed from the web form:
///  - EVERY option renders, no cap and no truncation. A hidden option is a
///    wrong answer waiting to happen, so labels wrap instead of clipping and
///    each option's description sits under its label (the web build puts it in
///    a hover title, which a phone has no equivalent for).
///  - Submit is gated on every question having an answer, and it sends the
///    `answers` map. A bare allow would tell the model the user answered
///    nothing, which is exactly the silent stall this card exists to end.
struct AskUserQuestionCard: View {
    let questions: [AskQuestion]
    let answering: Bool
    /// Prefix that keeps the free-text fields' scroll ids unique across cards.
    var fieldScope: String = ""
    var onFocusField: ((String?) -> Void)?
    var onTypeInField: (() -> Void)?
    var onFieldFrame: ((String, CGRect) -> Void)?
    var onTailFrame: ((String, CGRect) -> Void)?
    var onPicturesAdded: (() -> Void)?
    /// The answers, and the pictures put with them, sent in one request: the
    /// server puts the pictures in the question tool's result with the words
    /// (`core/answer-pictures.ts` withAnswerPictures).
    var onSubmit: ([String: String], [SelectedImage]) -> Void
    var onDismiss: () -> Void

    /// question text → picked option labels (multi-select keeps several).
    @State private var selections: [String: [String]] = [:]
    /// question text → free-text override ("Other…"), which beats the pills.
    @State private var otherText: [String: String] = [:]
    @FocusState private var focusedQuestion: String?
    /// Submit waits for words still being spoken or transcribed into an answer
    /// (`DictationSendGate`).
    @State private var sendGate = DictationSendGate()
    /// One set of pictures per card, offered beside the LAST question's answer
    /// (the web form's rule): they go with the answers as a whole.
    @State private var pictures: [SelectedImage] = []
    @State private var pictureNotice: String?

    private func fieldID(_ question: AskQuestion) -> String { "\(fieldScope)|\(question.question)" }

    private var complete: Bool {
        AskUserQuestion.allAnswered(
            questions: questions, selections: selections, otherText: otherText
        )
    }

    /// Answered, or an answer is still being spoken (Submit waits for it), or a
    /// Submit is waiting (a tap cancels).
    private var submittable: Bool { complete || sendGate.isDictating || sendGate.isWaiting }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                Text(questions.count == 1 ? "The agent has a question" : "The agent has \(questions.count) questions")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if answering { ProgressView().controlSize(.small) }
            }
            ForEach(questions) { question in
                questionBlock(question)
            }
            actions
                // With the strip above it, the tail the stack keeps in view while
                // the last answer is typed in (the keyboard hid both).
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(PendingPermissionStack.contentSpace)) } action: { frame in
                    guard let last = questions.last else { return }
                    onTailFrame?(fieldID(last), frame)
                }
        }
        .padding(12)
        .background(Theme.tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.tint.opacity(0.35), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        // `children: .contain` is load-bearing: an identifier on a container
        // otherwise OVERWRITES every descendant's identifier, so Submit/Dismiss
        // and the option rows all reported "session.askQuestionCard" and no test
        // (or VoiceOver user) could address them individually.
        .dictationSendGate(sendGate)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.askQuestionCard")
        .onChange(of: focusedQuestion) { _, question in
            onFocusField?(questions.first { $0.question == question }.map(fieldID))
        }
        .onChange(of: otherText) { old, new in
            if let focusedQuestion, old[focusedQuestion] != new[focusedQuestion] { onTypeInField?() }
        }
        .onChange(of: pictures.count) { old, new in
            if new > old { onPicturesAdded?() }
        }
    }

    @ViewBuilder
    private func questionBlock(_ question: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = question.header {
                Text(header)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.tint)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Theme.tintSoft, in: Capsule())
            }
            // No lineLimit: the whole question must be readable. This is the
            // text the phone showed NONE of before.
            Text(question.question)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .accessibilityIdentifier("session.askQuestion.text")
            if question.multiSelect && !question.options.isEmpty {
                Text("Choose one or more")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            ForEach(question.options) { option in
                optionRow(question: question, option: option)
            }
            // Walnut's mic beside the free-text answer. The words land in the
            // field for review; Submit stays the person's tap.
            VoiceDictationField(
                text: otherBinding(question),
                surface: "ask-question:\(fieldScope):\(questions.firstIndex { $0.question == question.question } ?? 0)",
                box: "ask-question", blocked: answering,
                refocus: { focusedQuestion = question.question }
            ) {
                HStack(alignment: .center, spacing: 2) {
                    TextField(
                        question.options.isEmpty ? "Type your answer…" : "Other…",
                        text: otherBinding(question),
                        axis: .vertical
                    )
                    .font(.callout)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .disabled(answering)
                    .focused($focusedQuestion, equals: question.question)
                    .accessibilityIdentifier("session.askQuestion.other")
                    // Beside the last answer's field, as on a decision letter's note:
                    // a row of its own pushed a one-question card's Submit below the
                    // card box's fold.
                    if question.question == questions.last?.question {
                        ReplyPictureButton(
                            images: $pictures, notice: $pictureNotice, idPrefix: "session.askQuestion",
                            disabled: answering, onWillPresent: { focusedQuestion = nil }
                        )
                    }
                }
            }
            // The whole box (the field and its mic) on screen, so the stack can
            // keep it, with room for the recording outline, inside its box.
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(PendingPermissionStack.contentSpace)) } action: { frame in
                onFieldFrame?(fieldID(question), frame)
            }
            if question.question == questions.last?.question {
                ReplyPictureStrip(images: $pictures, notice: $pictureNotice, idPrefix: "session.askQuestion")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func otherBinding(_ question: AskQuestion) -> Binding<String> {
        Binding(
            get: { otherText[question.question] ?? "" },
            set: { otherText[question.question] = $0 }
        )
    }

    /// One option: label + its full description. A row (not a wrapping pill
    /// grid) because descriptions are prose — the web card can hover them, a
    /// phone must show them, and a sentence in a pill is unreadable.
    @ViewBuilder
    private func optionRow(question: AskQuestion, option: AskQuestionOption) -> some View {
        let picked = (selections[question.question] ?? []).contains(option.label)
        Button {
            selections[question.question] = AskUserQuestion.toggleSelection(
                current: selections[question.question],
                label: option.label,
                multiSelect: question.multiSelect
            )
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: picked
                      ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                      : (question.multiSelect ? "square" : "circle"))
                    .font(.body)
                    .foregroundStyle(picked ? Theme.tint : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline.weight(picked ? .semibold : .regular))
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = option.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(10)
            .background(
                picked ? Theme.tint.opacity(0.14) : Color(.secondarySystemBackground),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(picked ? Theme.tint.opacity(0.5) : Color.clear, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(answering)
        .accessibilityIdentifier("session.askQuestion.option")
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button {
                sendGate.send { _ in
                    // Read again after a wait: the spoken words are in the answers now.
                    guard complete else { return }
                    onSubmit(AskUserQuestion.buildAnswers(
                        questions: questions, selections: selections, otherText: otherText
                    ), pictures)
                }
            } label: {
                DictationSendLabel(gate: sendGate, title: "Submit")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(
                        submittable ? Theme.tint : Color(.tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .foregroundStyle(submittable ? .white : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(answering || !submittable)
            .accessibilityIdentifier("session.askQuestion.submit")
            Button {
                onDismiss()
            } label: {
                Text("Dismiss")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .foregroundStyle(Theme.danger)
            }
            .buttonStyle(.plain)
            .disabled(answering)
            .accessibilityIdentifier("session.askQuestion.dismiss")
        }
    }
}
