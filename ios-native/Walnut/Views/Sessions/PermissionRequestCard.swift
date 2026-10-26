import SwiftUI

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
    @State private var typedInField = 0

    /// Share of the page the cards may take before they scroll.
    static let pageShare: CGFloat = 0.6
    /// Floor for a very short page (keyboard up on a small phone), so a card is
    /// never squeezed to a sliver; never more than the page itself.
    static let minCap: CGFloat = 180

    nonisolated static func maxHeight(pageHeight: CGFloat) -> CGFloat {
        guard pageHeight > 0 else { return .infinity }
        return min(pageHeight, max(minCap, (pageHeight * pageShare).rounded(.down)))
    }

    private var cap: CGFloat { Self.maxHeight(pageHeight: pageHeight) }

    private func reveal(_ proxy: ScrollViewProxy) {
        guard let focusedField else { return }
        proxy.scrollTo(focusedField, anchor: .bottom)
    }

    var body: some View {
        if !requests.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(requests) { request in
                            PermissionRequestCard(
                                request: request,
                                answering: isAnswering(request),
                                onRespond: { onRespond(request, $0) },
                                onAnswer: { onAnswer(request, $0) },
                                onDismissQuestions: { onDismissQuestions(request) },
                                onFocusField: { focusedField = $0 },
                                onTypeInField: { typedInField &+= 1 }
                            )
                        }
                    }
                    .padding(.bottom, 6)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { naturalHeight = $0 }
                }
                .onChange(of: focusedField) { reveal(proxy) }
                // Not on content height: picking an option elsewhere while the
                // field keeps focus would yank the reader back to the field.
                // Typing in it does follow it: a wrapped line grows the field
                // below the box's edge, taking the cursor out of sight. After
                // the layout pass, so the scroll sees the new height.
                .onChange(of: typedInField) { DispatchQueue.main.async { reveal(proxy) } }
                .onChange(of: cap) { reveal(proxy) }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicatorsFlash(onAppear: true)
            // Not interactively: the box's own height follows the keyboard, so a
            // drag that tracked the keyboard resized the box under the finger and
            // left the keyboard stuck halfway down.
            .scrollDismissesKeyboard(.immediately)
            .frame(height: min(naturalHeight, cap))
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

    var body: some View {
        if let questions = request.askQuestions {
            AskUserQuestionCard(
                questions: questions,
                answering: answering,
                fieldScope: request.requestId,
                onFocusField: onFocusField,
                onTypeInField: onTypeInField,
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
            TextField(
                question.options.isEmpty ? "Type your answer…" : "Other…",
                text: Binding(
                    get: { otherText[question.question] ?? "" },
                    set: { otherText[question.question] = $0 }
                ),
                axis: .vertical
            )
            .font(.callout)
            .textFieldStyle(.plain)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .disabled(answering)
            .focused($focusedQuestion, equals: question.question)
            .id(fieldID(question))
            .accessibilityIdentifier("session.askQuestion.other")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
