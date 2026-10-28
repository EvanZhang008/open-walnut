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
    var onRespond: (PendingPermission, Bool) -> Void
    var onAnswer: (PendingPermission, [String: String]) -> Void
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
    @State private var boxFrame: CGRect = .zero
    @State private var position = ScrollPosition(edge: .top)
    @State private var scroll = CardScrollGeometry()
    /// A finger is on the cards (or they still glide from its flick): no
    /// reveal then, so a drag is never fought.
    @State private var scrolling = false

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

    private var cap: CGFloat { Self.maxHeight(pageHeight: pageHeight) }

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
        guard let y = Self.revealTarget(
            row: row, visibleTop: scroll.offset + scroll.insetTop,
            bandHeight: boxFrame.height - scroll.insetTop - scroll.insetBottom, margin: voiceDictationRevealMargin
        ) else { return }
        revealLog.debug("reveal \(why, privacy: .public): y \(y) content \(scroll.contentHeight)")
        position.scrollTo(y: Self.scrollY(bandTop: y, insetTop: scroll.insetTop))
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
                        PermissionRequestCard(
                            request: request,
                            answering: isAnswering(request),
                            onRespond: { onRespond(request, $0) },
                            onAnswer: { onAnswer(request, $0) },
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
                            }
                        )
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
/// name, an input summary, and Allow / Deny.
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
    var onRespond: (Bool) -> Void
    /// AskUserQuestion answer submit (answers map) / dismiss (deny + reason).
    /// Optional so existing call sites and previews stay valid.
    var onAnswer: (([String: String]) -> Void)?
    var onDismissQuestions: (() -> Void)?
    /// The scroll id of the free-text field gaining focus, nil when it loses it.
    var onFocusField: ((String?) -> Void)?
    /// The focused free-text field's text changed (it may have grown a line).
    var onTypeInField: (() -> Void)?
    /// A free-text box (field and mic) by its field id, and its frame in the
    /// stack's content (`PendingPermissionStack.contentSpace`).
    var onFieldFrame: ((String, CGRect) -> Void)?

    var body: some View {
        if let questions = request.askQuestions {
            AskUserQuestionCard(
                questions: questions,
                answering: answering,
                fieldScope: request.requestId,
                onFocusField: onFocusField,
                onTypeInField: onTypeInField,
                onFieldFrame: onFieldFrame,
                onSubmit: { answers in
                    if let onAnswer { onAnswer(answers) } else { onRespond(true) }
                },
                onDismiss: {
                    if let onDismissQuestions { onDismissQuestions() } else { onRespond(false) }
                }
            )
        } else {
            genericCard
        }
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
            HStack(spacing: 10) {
                Button {
                    onRespond(true)
                } label: {
                    Text("Allow")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Theme.tint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.permission.allow")
                Button {
                    onRespond(false)
                } label: {
                    Text("Deny")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .foregroundStyle(Theme.danger)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("session.permission.deny")
            }
            .disabled(answering)
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
    var onSubmit: ([String: String]) -> Void
    var onDismiss: () -> Void

    /// question text → picked option labels (multi-select keeps several).
    @State private var selections: [String: [String]] = [:]
    /// question text → free-text override ("Other…"), which beats the pills.
    @State private var otherText: [String: String] = [:]
    @FocusState private var focusedQuestion: String?

    private func fieldID(_ question: AskQuestion) -> String { "\(fieldScope)|\(question.question)" }

    private var complete: Bool {
        AskUserQuestion.allAnswered(
            questions: questions, selections: selections, otherText: otherText
        )
    }

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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("session.askQuestionCard")
        .onChange(of: focusedQuestion) { _, question in
            onFocusField?(questions.first { $0.question == question }.map(fieldID))
        }
        .onChange(of: otherText) { old, new in
            if let focusedQuestion, old[focusedQuestion] != new[focusedQuestion] { onTypeInField?() }
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
            }
            // The whole box (the field and its mic) on screen, so the stack can
            // keep it, with room for the recording outline, inside its box.
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(PendingPermissionStack.contentSpace)) } action: { frame in
                onFieldFrame?(fieldID(question), frame)
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
                onSubmit(AskUserQuestion.buildAnswers(
                    questions: questions, selections: selections, otherText: otherText
                ))
            } label: {
                Text("Submit")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(
                        complete ? Theme.tint : Color(.tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                    )
                    .foregroundStyle(complete ? .white : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(answering || !complete)
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
