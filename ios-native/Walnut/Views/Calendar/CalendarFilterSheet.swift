import SwiftUI

/// The filter sheet behind the calendar's funnel button. Projects are a
/// multi-select (empty = all), plus the tasks/events and hide-overdue switches.
///
/// Dogfood R18: the store here holds 2,719 open tasks across 23 projects and
/// every dated one landed in the same band with no way to narrow — "not able to
/// filter". The project list is scoped to projects that actually own a dated
/// task, so it stays a short list instead of all 23.
struct CalendarFilterSheet: View {
    @Binding var filter: CalendarFilter
    /// The store's task list, for deriving the selectable projects.
    let tasks: [WalnutTask]

    @Environment(\.dismiss) private var dismiss

    private var projects: [String] {
        CalendarFilter.selectableProjects(from: tasks, selected: filter.projects)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Walnut tasks", isOn: $filter.showsTasks)
                        .accessibilityIdentifier("calendar.filter.tasks")
                    Toggle("Device calendar events", isOn: $filter.showsEvents)
                        .accessibilityIdentifier("calendar.filter.events")
                } header: {
                    Text("Show")
                }

                Section {
                    Toggle("Hide overdue", isOn: $filter.hidesOverdue)
                        .accessibilityIdentifier("calendar.filter.overdue")
                } footer: {
                    Text("Overdue tasks are shown by default — a calendar should say what slipped.")
                }

                Section {
                    if projects.isEmpty {
                        Text("No project has a dated task yet.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Button {
                            filter.projects.removeAll()
                        } label: {
                            HStack {
                                Text("All projects")
                                    .foregroundStyle(filter.projects.isEmpty ? Theme.tint : .primary)
                                Spacer()
                                if filter.projects.isEmpty {
                                    Image(systemName: "checkmark")
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(Theme.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("calendar.filter.allProjects")

                        ForEach(projects, id: \.self) { name in
                            let on = filter.projects.contains(name)
                            Button {
                                if on { filter.projects.remove(name) }
                                else { filter.projects.insert(name) }
                            } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: name.isEmpty ? "tray" : "folder")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text(CalendarFilter.label(for: name))
                                        .lineLimit(1)
                                        .foregroundStyle(on ? Theme.tint : .primary)
                                    Spacer()
                                    if on {
                                        Image(systemName: "checkmark")
                                            .font(.caption.weight(.semibold))
                                            .foregroundStyle(Theme.tint)
                                    }
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            // Raw project names can contain anything; the day
                            // key style (index) keeps ids automatable.
                            .accessibilityIdentifier("calendar.filter.project.\(name.isEmpty ? "inbox" : name)")
                        }
                    }
                } header: {
                    Text("Projects")
                } footer: {
                    Text(filter.projects.isEmpty
                         ? "Showing every project."
                         : "Showing \(filter.projects.count) of \(projects.count).")
                }
            }
            .navigationTitle("Filter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Reset") { filter = .unrestricted }
                        .disabled(!filter.isActive)
                        .accessibilityIdentifier("calendar.filter.reset")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("calendar.filter.done")
                }
            }
        }
        .accessibilityIdentifier("calendar.filterSheet")
    }
}

/// The funnel button in the calendar header, badged with how many narrowings
/// are in effect so "where did my task go?" is answerable without opening it.
struct CalendarFilterButton: View {
    let activeCount: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: activeCount > 0
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle")
                if activeCount > 0 {
                    Text("\(activeCount)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                }
            }
            .font(.body.weight(.semibold))
            .foregroundStyle(activeCount > 0 ? Theme.tint : .secondary)
            .frame(height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("calendar.filterButton")
    }
}
