import SwiftUI

/// Under the model sheet's columns, for a session: three rows, "Cost $102",
/// "Speed 128 tok/s avg" (the session's average on its model) and "Details", each opening its own page (design v2, the
/// user, 2026-11-21: "cost 点开之后 ... 显示具体的 ... 就显示非常简约的 ... 点开之后再显示详细的";
/// "speed is token /s not just time"). The web picker's fold bar
/// (web/src/components/sessions/PickerFoldBar.tsx) is the same three, as toggles.
///
/// A row whose page holds something that needs a look carries a dot: the budget
/// paused the session (Cost), the context is nearly full (Details). VoiceOver
/// reads the reason after the row's name.
struct ModelSheetFoldRows: View {
    let facts: ModelSheetFacts

    var body: some View {
        Section {
            row(.cost, "Cost", value: facts.costValue,
                mark: facts.budgetPaused ? ModelSheetFormat.budgetPausedNote : nil, id: "composer.modelSheet.cost")
            row(.speed, "Speed", value: facts.speedValue, mark: nil, id: "composer.modelSheet.speed")
            row(.details, "Details", value: nil, mark: facts.detailsWarning, id: "composer.modelSheet.details")
        }
    }

    /// A native grouped row: the title, its value at the right in the secondary label colour
    /// (readable, quieter than the title), the disclosure chevron (design A, 2026-11-21).
    private func row(_ page: PillMenuSheet.Page, _ title: String, value: String?, mark: String?, id: String) -> some View {
        NavigationLink(value: page) {
            HStack(spacing: 8) {
                if mark != nil { WarningDot() }
                Text(title)
                Spacer(minLength: 8)
                if let value {
                    Text(value)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .accessibilityLabel(mark.map { "\(title), \($0)" } ?? title)
        .accessibilityValue(value ?? "")
        .accessibilityIdentifier(id)
    }
}

/// The 8pt dot a row carries when its page needs a look.
private struct WarningDot: View {
    var body: some View {
        Circle()
            .fill(Theme.warning)
            .frame(width: 8, height: 8)
            .accessibilityHidden(true)
    }
}

/// The page a fold row opens.
struct ModelSheetFoldPage: View {
    let page: PillMenuSheet.Page
    let facts: ModelSheetFacts
    /// The sheet's menu, to name a model the way its rows do.
    let menu: PillMenu
    @Environment(\.walnutPalette) private var palette

    var body: some View {
        List {
            switch page {
            case .cost: cost
            case .speed: speed
            case .details: details
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var title: String {
        switch page {
        case .cost: return "Cost"
        case .speed: return "Speed"
        case .details: return "Details"
        }
    }

    // MARK: Cost

    @ViewBuilder private var cost: some View {
        switch facts.cost {
        case .waiting:
            reading
        case .missing:
            headline("Not available", note: "This server does not report what a session cost, or it could not be reached.",
                     id: "composer.modelSheet.costTotal")
        case .answered(let answer):
            headline(ModelSheetFormat.costHeadline(answer.cost), note: answer.cost.reason, id: "composer.modelSheet.costTotal")
            let times = ModelSheetFormat.costTimes(answer.cost)
            if !times.isEmpty {
                Section { ForEach(times, id: \.label) { FactRow(line: $0) } }
            }
            let models = ModelSheetFormat.costModels(answer.cost)
            if !models.isEmpty {
                Section("By model") { ForEach(Array(models.enumerated()), id: \.offset) { FactRow(line: $0.element) } }
            }
            Section {
                FactRow(line: .init(label: "Budget", value: ModelSheetFormat.budgetSummary(answer.budget)),
                        warns: answer.budget?.state == "paused", valueID: "composer.modelSheet.budget")
            }
        }
    }

    // MARK: Speed

    @ViewBuilder private var speed: some View {
        switch facts.record {
        case .waiting:
            reading
        case .missing:
            headline("n/a", note: "The session could not be read.", id: "composer.modelSheet.speedTps")
        case .answered(let record):
            if let turn = record.lastTurnSpeed {
                // The session's average on its model first (design A), then the turn and its agents as a table.
                if let average = ModelSheetFormat.speedAverage(record) {
                    let name = ModelSheetFormat.modelName(ModelSheetFormat.currentModel(record), menu: menu)
                    let lines = ModelSheetFormat.averageLines(average, modelName: name)
                    Section {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            FactRow(line: line, strongValue: index == 0,
                                    valueID: index == 0 ? "composer.modelSheet.speedAverage" : "composer.modelSheet.speedTurns")
                        }
                    } header: {
                        Text("Session average")
                    } footer: {
                        Text(ModelSheetFormat.averageNote)
                    }
                } else {
                    headline(ModelSheetFormat.speedValue(record), note: nil, id: "composer.modelSheet.speedTps")
                }
                Section {
                    SpeedTable(rows: ModelSheetFormat.speedRows(turn, now: Date().timeIntervalSince1970 * 1000) {
                        ModelSheetFormat.modelName($0, menu: menu)
                    })
                }
            } else {
                headline("—", note: "No turn measured yet: the speed shows after the session's next answer.",
                         id: "composer.modelSheet.speedTps")
            }
        }
    }

    // MARK: Details

    @ViewBuilder private var details: some View {
        switch facts.record {
        case .waiting:
            reading
        case .missing:
            Section { Text("The session could not be read.").foregroundStyle(.secondary) }
        case .answered(let record):
            Section {
                if let context = ModelSheetFormat.context(record) {
                    VStack(alignment: .leading, spacing: 8) {
                        FactRow(line: .init(label: "Context", value: context.text), warns: context.warning != nil,
                                valueID: "composer.modelSheet.contextValue")
                        if let fraction = context.fraction {
                            ProgressView(value: fraction)
                                .tint(context.warning != nil ? Theme.warning : palette.tint)
                                .accessibilityHidden(true)
                        }
                    }
                } else {
                    FactRow(line: .init(label: "Context", value: "not reported yet"), valueID: "composer.modelSheet.contextValue")
                }
                FactRow(line: .init(label: "Engine", value: ModelSheetFormat.engineName(record.engine)))
                if let mode = record.mode, !mode.isEmpty {
                    FactRow(line: .init(label: "Mode", value: ModelSheetFormat.modeName(mode)))
                }
            }
        }
    }

    // MARK: Parts

    private var reading: some View {
        Section {
            HStack(spacing: 8) {
                ProgressView()
                Text("Reading…").foregroundStyle(.secondary)
            }
        }
    }

    private func headline(_ text: String, note: String?, id: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text(text)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .accessibilityIdentifier(id)
                if let note, !note.isEmpty {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

/// A label and its value, the value free to wrap under a narrow width. A value that
/// needs a look gets the rows' dot before it (orange text would not be readable).
/// The label reads in the primary colour, the value in the secondary one, as a
/// native grouped row does; `strongValue` keeps the value primary (the average).
private struct FactRow: View {
    let line: ModelSheetFormat.Line
    var warns = false
    var strongValue = false
    var valueID = ""

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(line.label)
            Spacer(minLength: 8)
            if warns { WarningDot() }
            Text(line.value)
                .foregroundStyle(strongValue ? .primary : .secondary)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .accessibilityIdentifier(valueID)
        }
    }
}

/// The Speed page's table (the web's Speed fold, SessionSpeedReadout.tsx): a header of
/// Tokens | First token | Speed | Time, then one row for the turn and one per model its
/// agents ran on. Each row names itself once ("Last turn" or "This turn", by its state),
/// the model and its state words in small grey under it; numbers right-aligned in
/// tabular digits. VoiceOver reads each cell with its column's name.
private struct SpeedTable: View {
    let rows: [ModelSheetFormat.SpeedRow]
    @Environment(\.walnutPalette) private var palette

    var body: some View {
        Grid(alignment: .trailing, horizontalSpacing: 8, verticalSpacing: 8) {
            // The header's cells are silent: every number cell says its column's name.
            GridRow {
                Text(verbatim: "")
                    .gridColumnAlignment(.leading)
                    .accessibilityHidden(true)
                ForEach(ModelSheetFormat.speedColumns, id: \.self) { title in
                    Text(title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .accessibilityHidden(true)
                }
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                Divider()
                GridRow(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .font(.subheadline)
                        detail(row)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(ModelSheetFormat.speedRowTitle(row))
                    .accessibilityIdentifier("composer.modelSheet.speedRow.\(index)")
                    cell(row.tokens, column: 0, row: index)
                    cell(row.first, column: 1, row: index)
                    cell(row.speed, column: 2, row: index)
                    cell(row.time, column: 3, row: index)
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// The model on its own line, then its state ("● running", "last call"): small, secondary,
    /// each line whole (one line beside the numbers cut "GPT-6.1 Sol" to "GPT-6.1…").
    @ViewBuilder private func detail(_ row: ModelSheetFormat.SpeedRow) -> some View {
        if row.model != nil || !row.states.isEmpty || row.running {
            VStack(alignment: .leading, spacing: 1) {
                if let name = row.model {
                    Text(name)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if row.running || !row.states.isEmpty {
                    HStack(spacing: 4) {
                        if row.running {
                            Circle()
                                .fill(palette.tint)
                                .frame(width: 6, height: 6)
                        }
                        if !row.states.isEmpty {
                            Text(row.states.joined(separator: " · "))
                        }
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func cell(_ value: String, column: Int, row: Int) -> some View {
        Text(value)
            .font(.subheadline)
            .monospacedDigit()
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel(value.isEmpty ? "" : "\(ModelSheetFormat.speedColumns[column]) \(value)")
            .accessibilityHidden(value.isEmpty)
            .accessibilityIdentifier("composer.modelSheet.speedRow.\(row).\(column)")
    }
}
