import SwiftUI
import UIKit

/// The open `@` or `/` list of a box (`ComposerSuggestController`), drawn the same in every
/// box: the chat and session composers, a letter's reply and an ask card. A tap picks a row;
/// the x closes the list for this `@` or `/`. The owner places it (above its field) and passes
/// the pick back to its own field.
struct ComposerSuggestList: View {
    let controller: ComposerSuggestController
    let onPick: (ComposerSuggestion) -> Void
    /// The list's tallest height; it scrolls past it.
    var maxHeight: CGFloat = 220

    var body: some View {
        if let trigger = controller.trigger {
            VStack(alignment: .leading, spacing: 0) {
                header(trigger)
                Divider()
                content(trigger)
            }
            // A menu's corner (`Theme.Radius.md`).
            .background(Color(.systemBackground), in: Theme.Radius.shape(Theme.Radius.md))
            .overlay(Theme.Radius.shape(Theme.Radius.md).stroke(Color(.separator), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("composer.suggest.list")
            // VoiceOver hears that rows came up beside the field it is in.
            .onAppear { UIAccessibility.post(notification: .layoutChanged, argument: nil) }
        }
    }

    private func header(_ trigger: ComposerTrigger) -> some View {
        HStack(spacing: 6) {
            Text(trigger.isMention ? "Tasks and sessions" : "Commands")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("composer.suggest.header")
            Spacer(minLength: 0)
            Button { controller.dismiss() } label: {
                Image(systemName: "xmark").font(Theme.TextSize.sm.weight(.semibold))
            }
            .buttonStyle(.walnut(.tool, size: .small))
            .accessibilityLabel("Close the list")
            .accessibilityIdentifier("composer.suggest.close")
        }
        .padding(.leading, 12)
        .padding(.trailing, 2)
    }

    @ViewBuilder
    private func content(_ trigger: ComposerTrigger) -> some View {
        let rows = controller.suggestions
        if rows.isEmpty {
            HStack(spacing: 8) {
                if controller.status == .loading { ProgressView().controlSize(.small) }
                Text(emptyLine(trigger)).font(.subheadline).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .accessibilityIdentifier("composer.suggest.empty")
        } else {
            // A plain stack: at most 30 rows, and its height is the list's own (a lazy stack
            // answers from estimates, tests/web/ios-lazy-stack-nesting.test.ts).
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { row in
                        Button { onPick(row) } label: { label(row) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("composer.suggest.row.\(row.rowID)")
                    }
                }
            }
            .frame(maxHeight: maxHeight)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func emptyLine(_ trigger: ComposerTrigger) -> String {
        if trigger.isMention { return trigger.query.isEmpty ? "No tasks yet" : "No task or session matches" }
        switch controller.status {
        case .loading: return "Loading the commands…"
        case .failed: return "The commands did not load. Type / again to retry."
        case .ready: return trigger.query.isEmpty ? "No commands" : "No command matches"
        }
    }

    private func label(_ row: ComposerSuggestion) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: icon(row.kind))
                .font(.subheadline)
                .foregroundStyle(row.live ? Theme.success : .secondary)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title).font(.subheadline).foregroundStyle(.primary).lineLimit(1)
                if let detail = row.detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func icon(_ kind: ComposerSuggestion.Kind) -> String {
        switch kind {
        case .task: return "checklist"
        case .session: return "bubble.left.and.text.bubble.right"
        case .command: return "command"
        }
    }
}
