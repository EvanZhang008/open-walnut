import SwiftUI

// The Tasks board's focus space controls (experiment `focus_workspace`, `FocusSpacesStore`):
// the toolbar's Focus menu and the one-line banner over the board while a focus is on.

/// The toolbar's Focus menu. Out of a focus: one row per saved space, each with how long to stay.
/// In one: its name, Leave focus, and Switch to the other spaces. With no space yet, one line
/// saying where to make one (spaces are made on the web or the Mac).
struct FocusSpaceMenu: View {
    @Environment(\.leadingDrawer) private var drawer
    private var store: FocusSpacesStore { FocusSpacesStore.shared }

    var body: some View {
        let active = store.active
        let spaces = store.spaces
        Menu {
            if let active {
                Section(active.name) {
                    Button(role: .destructive) {
                        leave()
                    } label: {
                        Label("Leave focus", systemImage: "xmark.circle")
                    }
                    .accessibilityIdentifier("tasks.focus.leave")
                }
                let others = spaces.filter { $0.id != active.spaceId }
                if !others.isEmpty {
                    Menu("Switch to") {
                        ForEach(others) { space in
                            lengths(for: space, title: space.name)
                        }
                    }
                }
            } else if spaces.isEmpty {
                Button("Make a space on the web or Mac") {}
                    .disabled(true)
            } else {
                ForEach(spaces) { space in
                    lengths(for: space, title: "Enter \(space.name)")
                }
            }
        } label: {
            // While an enter is on its way the symbol says so: the menu has closed, nothing else moved yet.
            if store.entering {
                ProgressView().frame(width: 28, height: 28)
            } else {
                FocusSpaceGlyph(on: active != nil)
            }
        }
        // "Focus space", never bare "Focus": the board's pin tier chip is called Focus too.
        .accessibilityLabel("Focus space")
        .accessibilityValue(active?.name ?? "Off")
        .accessibilityIdentifier("tasks.focus")
    }

    /// One space's row: a submenu of how long to stay in it.
    private func lengths(for space: FocusSpace, title: String) -> some View {
        Menu(title) {
            Section("For") {
                ForEach(FocusSpaceLength.allCases) { length in
                    Button(length.title) { enter(space, for: length) }
                }
            }
        }
    }

    private func enter(_ space: FocusSpace, for length: FocusSpaceLength) {
        guard drawer?.suppressTaps != true else { return }
        let until = length.until(from: Date())
        Task { await store.enter(spaceId: space.id, until: until) }
    }

    private func leave() {
        guard drawer?.suppressTaps != true else { return }
        Task { await store.leave() }
    }
}

/// The menu's symbol: the outlined scope out of a focus, a filled disc with it while in one.
private struct FocusSpaceGlyph: View {
    let on: Bool

    var body: some View {
        Image(systemName: "scope")
            .font(.body.weight(on ? .semibold : .regular))
            .foregroundStyle(on ? Color.white : Theme.tint)
            .frame(width: 28, height: 28)
            .background(Circle().fill(on ? Theme.tint : Color.clear))
    }
}

/// "Deep work · until 3:40 PM · 12 waiting outside", with Leave: the board's first row while a
/// focus is on. Drawn at `TasksChromeMetrics.focusBanner` height by the caller.
struct FocusSpaceBanner: View {
    @Environment(TasksStore.self) private var tasks
    @Environment(\.leadingDrawer) private var drawer
    @Environment(\.colorScheme) private var colorScheme
    let focus: ActiveFocusSpace

    /// One whole line: the name, then `detail`, neither cut (ViewThatFits picks one that fits).
    private func bannerLine(_ detail: String) -> some View {
        HStack(spacing: 0) {
            Text(focus.name).fontWeight(.semibold)
            Text(" · " + detail)
        }
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
    }

    /// The banner's words, in one place so they are tested alone.
    static func line(name: String, until: Date?, outside: Int) -> String {
        ([name] + [detail(until: until, outside: outside)]).joined(separator: " · ")
    }

    /// The part after the name ("until 3:40 PM · 12 waiting outside").
    static func detail(until: Date?, outside: Int) -> String {
        var parts: [String] = []
        if let until { parts.append("until \(until.formatted(date: .omitted, time: .shortened))") }
        parts.append(outside == 0 ? "nothing waiting outside" : "\(outside) waiting outside")
        return parts.joined(separator: " · ")
    }

    /// The same, short, for a narrow row or large text ("12 outside · until 3:40 PM").
    static func shortDetail(until: Date?, outside: Int) -> String {
        var parts = [outside == 0 ? "none outside" : "\(outside) outside"]
        if let until { parts.append("until \(until.formatted(date: .omitted, time: .shortened))") }
        return parts.joined(separator: " · ")
    }

    /// The shortest: only the count, which the banner never drops.
    static func countOnly(outside: Int) -> String {
        outside == 0 ? "none outside" : "\(outside) outside"
    }

    var body: some View {
        let text = Self.line(name: focus.name, until: focus.untilDate, outside: tasks.focusSpaceOutsideCount)
        HStack(spacing: 8) {
            Image(systemName: "scope")
                .foregroundStyle(Theme.tint)
                .accessibilityHidden(true)
            // The longest line that fits: the whole detail, then a short one, then the name cut
            // to make room for the count, which always shows.
            let outside = tasks.focusSpaceOutsideCount
            ViewThatFits(in: .horizontal) {
                bannerLine(Self.detail(until: focus.untilDate, outside: outside))
                bannerLine(Self.shortDetail(until: focus.untilDate, outside: outside))
                HStack(spacing: 0) {
                    Text(focus.name)
                        .fontWeight(.semibold)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(" · " + Self.countOnly(outside: outside))
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(text)
            .accessibilityIdentifier("tasks.focus.banner.text")
            Spacer(minLength: 4)
            // Borderless: inside a List row only the button takes the tap, not the whole row.
            Button("Leave") {
                guard drawer?.suppressTaps != true else { return }
                Task { await FocusSpacesStore.shared.leave() }
            }
            .buttonStyle(.borderless)
            .font(.footnote.weight(.semibold))
            .accessibilityIdentifier("tasks.focus.banner.leave")
        }
        .font(.footnote)
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Tinted glass reads on a light board at 12 %; a dark one needs more to be seen.
        .background(Theme.tint.opacity(colorScheme == .dark ? 0.24 : 0.12))
        .modifier(BannerTypeCap(text: text))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("tasks.focus.banner")
    }
}
