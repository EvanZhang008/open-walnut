import SwiftUI

/// Routines management — the phone mirror of the console's Routines page
/// (Wave 2 /api/v1/routines). Grouped like the console (RoutineGroups.swift):
/// the global routines first, then one section per project, each folding on its
/// header. A routine is one line (dot, name, how often and when next, switch);
/// tapping it opens its details: when it runs, its task, what it sends, its
/// history, and Run Now, Edit and Delete. "+" creates one that runs in Walnut
/// (2026-11-04: the phone does what the console's row does, RoutineEditor.swift).
///
/// The opened details are a list row of their own under the routine's line, so
/// opening inserts a row instead of growing one: a growing cell clipped the top
/// of the name at large text and moved the card. Rows keep the order they were
/// first shown in for the whole visit (RoutineGroups.keepingOrder), and the list
/// refreshes every minute while it is on screen without a refresh ever undoing a
/// switch or an edit made meanwhile.
///
/// Cloud replica: every call relays to the primary over the bridge, so the
/// standard failure ladder copy applies (needs_upgrade / bridge_offline).
struct RoutinesView: View {
    private let api = WalnutAPI()

    /// The Edit and New Routine sheet's subject.
    private enum EditTarget: Identifiable {
        case new
        case edit(RoutineJob)

        var id: String {
            switch self {
            case .new: return "new"
            case .edit(let job): return job.id
            }
        }
    }

    @State private var jobs: [RoutineJob] = []
    @State private var loaded = false
    /// The first load failed: nothing to show but the error and Retry.
    @State private var loadError: String?
    /// A later refresh failed: the list stays, with this above it.
    @State private var refreshError: String?
    /// A switch or a delete the server refused, by job id: said on that row, in place
    /// ("Could not pause it: …"), never above the list (which moved the row away).
    @State private var rowErrors: [String: String] = [:]
    /// Job ids with a toggle/delete in flight (the switch disables).
    @State private var busyIds = Set<String>()
    /// Job ids with Run Now in flight.
    @State private var runningIds = Set<String>()
    /// What the last Run Now said, by job id: "Started" until the routine shows how
    /// the run ended, then that; or why it did not run (RoutineGroups.RunNote).
    @State private var runNotes: [String: RoutineGroups.RunNote] = [:]
    @State private var pendingDelete: RoutineJob?
    /// The one routine shown open (its details below its line).
    @State private var openId: String?
    /// The opened row's folds that are open, by "<fold>.<job id>".
    @State private var openFolds = Set<String>()
    @State private var editing: EditTarget?
    /// The task "Open task" shows, the way a task link opens one elsewhere in the app.
    @State private var openedTask: InboxTaskDestination?
    /// A row to bring into view once the list has laid it out (opened, or just created).
    @State private var scrollRequest: ScrollRequest?
    /// The List's scroll view, and where each row was last laid out on screen: what keeps
    /// a tapped row under the finger while the row above it closes.
    @State private var scroll = ListScroll()
    @State private var frames = RowFrames()
    /// The order the rows were shown in, by group: held for the visit.
    @State private var shownOrder: [String: [String]] = [:]
    /// Local writes, all and per routine: a read that started before one is older
    /// than what the screen shows, and is dropped.
    @State private var writes = 0
    @State private var rowWrites: [String: Int] = [:]
    /// Folded groups, by key, one per line: kept across visits like the console's.
    @AppStorage("routines.foldedGroups") private var foldedRaw = ""
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.scenePhase) private var scenePhase
    /// The facts' label column: "Last check", the longest label, at the text size.
    @ScaledMetric(relativeTo: .subheadline) private var factLabelWidth: CGFloat = 80
    /// Room above a group's first row for its header when a row is scrolled to.
    @ScaledMetric(relativeTo: .subheadline) private var headerRoom: CGFloat = 40
    /// The gap between a group's name and its count: 6 at the default size, wider with
    /// the text ("Global6" at the largest size, QA).
    @ScaledMetric(relativeTo: .subheadline) private var headerGap: CGFloat = 6

    private var folded: Set<String> { Set(foldedRaw.split(separator: "\n").map(String.init)) }

    /// The status dot: 9pt, and 13pt at accessibility sizes so it grows with the words
    /// (it stayed 9pt beside 40pt text, QA).
    private var dotSize: CGFloat { typeSize.isAccessibilitySize ? 13 : 9 }

    /// The leading of the name: where every separator under a routine starts
    /// (the dot, then 10 of spacing).
    private var nameInset: CGFloat { dotSize + 10 }

    struct ScrollRequest: Equatable {
        let id: String
        /// Where the row's line was on screen when it was tapped: kept while the row
        /// above it closes.
        var keepAt: CGFloat? = nil
        /// Not on screen (just created, or a new text size): brought into view first.
        var bringFirst = false
        /// Run now said something: its buttons and what it said come above the tab bar.
        var outcome = false
    }

    var body: some View {
        ScrollViewReader { proxy in
            list
                // A new type size lays every row out again (a row open across the
                // change kept its old height and clipped its name and buttons).
                .id(typeSize)
                .onChange(of: typeSize) { _, _ in
                    if let openId { scrollRequest = ScrollRequest(id: openId, bringFirst: true) }
                }
                .onChange(of: scrollRequest) { _, request in
                    guard let request else { return }
                    scrollRequest = nil
                    Task { @MainActor in await place(request, proxy: proxy) }
                }
        }
    }

    /// After a row opens: the tapped row stays where it was on screen (the row above it
    /// may have just closed); then, if its details run past the bottom, the list scrolls
    /// just enough to show them, never so far that the row's own line, or its group's
    /// header when it is the first row, goes under the bar (2026-11-04, QA: the tapped
    /// row jumped 230pt; at large text the header went under the title).
    @MainActor
    private func place(_ request: ScrollRequest, proxy: ScrollViewProxy) async {
        if request.bringFirst {
            try? await Task.sleep(for: .milliseconds(150))
            proxy.scrollTo(request.id, anchor: .center)
        }
        if request.keepAt != nil, scroll.isHolding {
            // Checked again as the close and the open land (within a frame or two), then
            // let go before the details are brought into view.
            for _ in 0..<8 {
                try? await Task.sleep(for: .milliseconds(16))
                scroll.alignHeld(measured: true)
            }
            scroll.endHold()
        } else if let keep = request.keepAt {
            // The close and the open land within a frame or two.
            for _ in 0..<8 {
                try? await Task.sleep(for: .milliseconds(16))
                guard let view = scroll.locate(near: frames.line[request.id]), let now = frames.line[request.id]?.minY else { continue }
                if abs(now - keep) > 0.5 {
                    view.setContentOffset(CGPoint(x: view.contentOffset.x, y: clampedOffset(view.contentOffset.y + now - keep, view)), animated: false)
                    break
                }
            }
        }
        // After the details row is laid out (and the open's animation ends).
        try? await Task.sleep(for: .milliseconds(request.keepAt == nil && !request.outcome ? 300 : 150))
        guard let line = frames.line[request.id], let view = scroll.locate(near: line) else { return }
        let visible = view.convert(view.bounds, to: nil)
        // A group's first row leaves its header in view: the header as laid out (two
        // lines at the largest sizes), else a scaled guess.
        let group = shownGroups.first { $0.routines.first?.id == request.id }
        let room = group.map { (frames.header[$0.id]?.height).map { $0 + 8 } ?? headerRoom } ?? 8
        let top = visible.minY + view.adjustedContentInset.top + room
        // Above the tab bar as it is drawn (it floats over the list): the actions and what
        // Run now said were left under it (2026-11-04, QA steps 25 and 26).
        let insetBottom = visible.maxY - view.adjustedContentInset.bottom
        let bottom = min(insetBottom, ListScroll.tabBarTop(in: view.window) ?? insetBottom) - 8
        let shift: CGFloat
        if request.outcome {
            // Run now's buttons and its note, wherever the person has scrolled to.
            guard openId == request.id, let actions = frames.actions[request.id] else { return }
            shift = RoutineGroups.revealShift(lineTop: actions.minY, end: actions.maxY, top: top, bottom: bottom)
        } else {
            let end = max(line.maxY, frames.details[request.id]?.maxY ?? line.maxY)
            shift = RoutineGroups.revealShift(lineTop: line.minY, end: end, top: top, bottom: bottom)
        }
        guard abs(shift) > 1 else { return }
        view.setContentOffset(CGPoint(x: view.contentOffset.x, y: clampedOffset(view.contentOffset.y + shift, view)), animated: true)
    }

    private func clampedOffset(_ y: CGFloat, _ view: UIScrollView) -> CGFloat {
        let lowest = -view.adjustedContentInset.top
        let highest = max(lowest, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
        return min(max(y, lowest), highest)
    }

    private var list: some View {
        List {
            if !loaded {
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading routines…").foregroundStyle(.secondary)
                    }
                }
            } else if let loadError {
                Section {
                    VStack(spacing: 8) {
                        Text(loadError)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button { Task { await load() } } label: {
                            Text("Retry").foregroundStyle(Theme.onTint)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.tint)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
            } else if jobs.isEmpty {
                Section {
                    Text("No routines yet. Tap + to create one.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 24)
                }
            } else {
                summary
                ForEach(shownGroups) { group in
                    // Folded or not, the same section header in the same place: only its
                    // rows go (a folded group drawn as a row moved its header 12pt left and
                    // up to 35pt under the finger, QA). Folded, the section adds no gap.
                    let isFolded = folded.contains(group.id)
                    Section {
                        if !isFolded {
                            ForEach(group.routines) { job in
                                routineRow(job)
                                if openId == job.id { detailsRow(job) }
                            }
                        }
                    } header: {
                        groupHeader(group)
                    }
                    .listSectionSpacing(isFolded ? .custom(0) : .default)
                }
            }
        }
        // Inset grouped sections do not pin their headers (only the plain style does).
        .listStyle(.insetGrouped)
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    editing = .new
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(!loaded || loadError != nil)
                .accessibilityLabel("New Routine")
                .accessibilityIdentifier("routines.new")
            }
        }
        .accessibilityIdentifier("routines.list")
        // A failed refresh says so once, at the foot, over the list: a banner put into the
        // list moved every row under it (and left a seam across a card).
        .safeAreaInset(edge: .bottom) {
            if let refreshError { refreshBanner(refreshError) }
        }
        .refreshable { await load() }
        .task {
            // On every appearance, then each minute while the screen is shown.
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled { break }
                await load()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, loaded { Task { await load() } }
        }
        .sheet(item: $editing) { target in
            switch target {
            case .new: RoutineEditorSheet(job: nil) { created($0) }
            case .edit(let job): RoutineEditorSheet(job: job) { saved($0) }
            }
        }
        .sheet(item: $openedTask) { destination in
            InboxTaskSheet(destination: destination)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private static func detailsId(_ id: String) -> String { "\(id).details" }

    /// "64 routines · 3 failing" over the groups, as the console's toolbar says it; the
    /// failing count takes you to the first failing routine (with seven groups one further
    /// down was only found by scrolling, 2026-11-04 review).
    private var summary: some View {
        let said = RoutineGroups.summary(shownGroups)
        let count = Text(said.count).foregroundStyle(Theme.secondaryOnCard).fixedSize()
        let failing = said.failing.map { failing in
            Button { showFirstFailing() } label: {
                Text(failing).fontWeight(.semibold).foregroundStyle(Theme.dangerText)
                    .fixedSize()
                    .frame(minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows the first failing routine")
            .accessibilityIdentifier("routines.summaryFailing")
        }
        return Section {
            // One line while it fits; else each half on its own line, whole (at the
            // largest sizes "44 · 4" over "routines failing" read as one count).
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    count
                    if let failing {
                        Text("·").foregroundStyle(Theme.secondaryOnCard).accessibilityHidden(true)
                        failing
                    }
                    Spacer(minLength: 0)
                }
                VStack(alignment: .leading, spacing: 0) {
                    count
                    if let failing { failing }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.subheadline)
            .monospacedDigit()
            .frame(minHeight: 32)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("routines.summary")
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
        }
        .listSectionSpacing(.custom(0))
    }

    /// The first failing routine, its group unfolded, brought into view.
    private func showFirstFailing() {
        guard let group = shownGroups.first(where: { $0.failing > 0 }),
              let job = group.routines.first(where: { RoutineGroups.health($0) == .error }) else { return }
        if folded.contains(group.id) {
            withAnimation(.snappy(duration: 0.2)) { foldedRaw = folded.subtracting([group.id]).sorted().joined(separator: "\n") }
        }
        scrollRequest = ScrollRequest(id: job.id, bringFirst: true)
    }

    private func refreshBanner(_ message: String) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Label("Couldn't refresh. \(message)", systemImage: "arrow.clockwise.circle")
                .font(.footnote)
                .foregroundStyle(Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("routines.refreshError")
            Spacer(minLength: 0)
            Button { Task { await load() } } label: {
                Text("Retry").font(.footnote.weight(.semibold)).foregroundStyle(Self.actionText)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("routines.refreshRetry")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    /// The bordered buttons' words: the tint, a step darker (lighter in dark mode), so
    /// they read at 4.5:1 on their own fill (the plain tint read 4.14:1 in dark).
    static let actionText = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xE2 / 255, green: 0xB4 / 255, blue: 0x7E / 255, alpha: 1)
            : UIColor(red: 0x7A / 255, green: 0x4A / 255, blue: 0x1F / 255, alpha: 1)
    })

    /// Delete's word on its red wash: the danger text, lighter in dark mode, where the
    /// danger text read 4.32:1 on the button's fill (QA); about 7:1 dark, 5.8:1 light.
    static let deleteText = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xFF / 255, green: 0x9A / 255, blue: 0x94 / 255, alpha: 1)
            : UIColor(red: 0xB0 / 255, green: 0x12 / 255, blue: 0x18 / 255, alpha: 1)
    })

    /// How far a group header's button reaches past the header's margins on each side.
    private static let headerReach: CGFloat = 16

    private var shownGroups: [RoutineGroup] {
        RoutineGroups.keepingOrder(RoutineGroups.groups(jobs), shown: shownOrder)
    }

    // MARK: - Group header

    private func groupHeader(_ group: RoutineGroup) -> some View {
        let isFolded = folded.contains(group.id)
        // Colors, not hierarchical styles: a section header draws its content in the
        // secondary style, so `.primary` there came out grey.
        let name = Text(group.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.primary)
        let counts = HStack(spacing: 6) {
            Text("\(group.routines.count)")
                .font(.subheadline)
                .foregroundStyle(Theme.secondaryOnCard)
                .monospacedDigit()
            if group.failing > 0 {
                // A dot between the two numbers: at the largest sizes "14 1 failing" read "141".
                Text("·").font(.subheadline).foregroundStyle(Theme.secondaryOnCard)
                Text("\(group.failing) failing")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.dangerText)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        return Button {
            var next = folded
            if isFolded { next.remove(group.id) } else { next.insert(group.id) }
            withAnimation(.snappy(duration: 0.2)) { foldedRaw = next.sorted().joined(separator: "\n") }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(isFolded ? 0 : 90))
                    .foregroundStyle(Theme.secondaryOnCard)
                    .accessibilityHidden(true)
                // One line while it fits; else the counts go under the name, whole.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: headerGap) { name.lineLimit(1); counts }
                    VStack(alignment: .leading, spacing: 2) { name; counts }
                }
                Spacer(minLength: 0)
            }
            .textCase(nil)
            // The whole width folds, the empty right end too: the button reaches out over
            // the header's own margins (the list's trailing margin left the right end dead,
            // QA; a header ignores listRowInsets), and the words keep their place by as
            // much padding inside it.
            .padding(.horizontal, Self.headerReach)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -Self.headerReach)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.header[group.id] = $0 }
        .accessibilityLabel("\(group.name), \(group.routines.count) routines\(group.failing > 0 ? ", \(group.failing) failing" : "")")
        .accessibilityValue(isFolded ? "Collapsed" : "Expanded")
        .accessibilityHint(isFolded ? "Shows this group's routines" : "Hides this group's routines")
        .accessibilityIdentifier("routines.group.\(group.id)")
    }

    // MARK: - Row

    @ViewBuilder
    private func routineRow(_ job: RoutineJob) -> some View {
        let isOpen = openId == job.id
        VStack(alignment: .leading, spacing: 4) {
            if typeSize.isAccessibilitySize {
                // No room beside the words: the switch gets its own line under them.
                VStack(alignment: .leading, spacing: 8) {
                    openButton(job, isOpen: isOpen)
                    toggle(job).padding(.leading, nameInset)
                }
            } else {
                HStack(spacing: 10) {
                    openButton(job, isOpen: isOpen)
                    toggle(job)
                }
            }
            if let failure = rowErrors[job.id] { rowError(job, failure) }
        }
        .padding(.vertical, 2)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.line[job.id] = $0 }
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] + nameInset }
        .listRowSeparator(isOpen ? .hidden : .automatic, edges: .bottom)
        .id(job.id)
        // No row-level accessibilityIdentifier: on a List row it collapses
        // the children into one accessibility element, hiding the per-control
        // ids (routines.toggle/run/delete.<id>) from automation (verified
        // with Maestro hierarchy 2026-08-09).
    }

    /// A refused switch or delete, under the routine's own line: the row stays where
    /// it was, as it was, and says what failed.
    private func rowError(_ job: RoutineJob, _ text: String) -> some View {
        HStack(alignment: .center, spacing: 6) {
            // The icon inline, so the words start in the name's column (a Label's icon
            // sat there and pushed the words right of it, QA steps 27 and 28).
            (Text(Image(systemName: "exclamationmark.triangle.fill")) + Text(" ") + Text(text))
                .font(.footnote)
                .foregroundStyle(Theme.dangerText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(text)
                .accessibilityIdentifier("routines.rowError.\(job.id)")
            Spacer(minLength: 0)
            Button {
                rowErrors[job.id] = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.secondaryOnCard)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .accessibilityIdentifier("routines.rowErrorDismiss.\(job.id)")
        }
        .padding(.leading, nameInset)
        // A little room under the timing; the dismiss target's own margin below.
        .padding(.top, 4)
        .padding(.bottom, -6)
    }

    private func openButton(_ job: RoutineJob, isOpen: Bool) -> some View {
        let health = RoutineGroups.health(job)
        let timing = RoutineGroups.rowTiming(job, now: AppClock.now())
        let ax = typeSize.isAccessibilitySize
        return Button {
            toggleOpen(job.id)
        } label: {
            // The dot and the chevron sit on the name's first line at every size (QA: at
            // XXL the dot was centred on two lines, at accessibility sizes on the first).
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\u{25CF}").font(.body).hidden()
                    .fixedSize()
                    .frame(width: dotSize)
                    .overlay { dot(health) }
                VStack(alignment: .leading, spacing: 2) {
                    // A paused routine reads quieter, never dimmed: its switch and details
                    // are live, and its red flag stays red.
                    Text(job.name)
                        .font(.body)
                        .foregroundStyle(job.enabled ? Color.primary : Theme.secondaryOnCard)
                        // Two lines (four at accessibility sizes), open or closed: one line
                        // beside the chevron cut "Slack channel: new mentions" to "mentio…",
                        // and a limit lifted on open pushed the line under it down 22pt (QA).
                        .lineLimit(ax ? 4 : 2)
                        .fixedSize(horizontal: false, vertical: true)
                    // A wrap never starts a line with the dot: it stays with what is before it.
                    (flag(job, health) + Text(shownTiming(job))
                        .foregroundStyle(Theme.secondaryOnCard))
                        .font(.footnote)
                        // Wraps rather than cut: how often and when next are the line's point
                        // ("Every 15 min, 9 AM to 5 PM, weekday…" lost both, QA).
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                // It opens: the console's "›", turned down while open.
                Text(Image(systemName: "chevron.right"))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.secondaryOnCard)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .padding(.trailing, ax ? 0 : 2)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(job.name), \(RoutineGroups.healthLabel(job)), \(timing)")
        .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
        .accessibilityHint(isOpen ? "Hides the details" : "Shows the details")
        .accessibilityIdentifier("routines.row.\(job.id)")
    }

    /// The row's timing as drawn: a wrap never starts a line with "·", and never splits
    /// when it runs next ("next in" / "7 min").
    private func shownTiming(_ job: RoutineJob) -> String {
        let parts = RoutineGroups.rowTimingParts(job, now: AppClock.now())
        let how = parts.how.replacingOccurrences(of: " · ", with: "\u{00A0}· ")
        guard let next = parts.next else { return how }
        return "\(how)\u{00A0}· \(next.replacingOccurrences(of: " ", with: "\u{00A0}"))"
    }

    private func toggle(_ job: RoutineJob) -> some View {
        Toggle("", isOn: Binding(
            get: { job.enabled },
            set: { _ in Task { await toggle(job) } }
        ))
        .labelsHidden()
        .disabled(busyIds.contains(job.id))
        .accessibilityLabel(job.enabled ? "Pause \(job.name)" : "Resume \(job.name)")
        .accessibilityIdentifier("routines.toggle.\(job.id)")
    }

    /// "Stopped " / "Failed " in red ahead of the timing, for a routine that needs a look.
    private func flag(_ job: RoutineJob, _ health: RoutineHealth) -> Text {
        guard health == .error else { return Text("") }
        return Text(RoutineGroups.isStopped(job) ? "Stopped\u{00A0}· " : "Failed\u{00A0}· ")
            .fontWeight(.semibold)
            .foregroundStyle(Theme.dangerText)
    }

    @ViewBuilder
    private func dot(_ health: RoutineHealth) -> some View {
        switch health {
        case .off:
            Circle().strokeBorder(Color.secondary, lineWidth: 1.5).frame(width: dotSize, height: dotSize)
        case .error:
            Circle().fill(Theme.danger).frame(width: dotSize, height: dotSize)
        case .running:
            Circle().fill(Theme.tint).frame(width: dotSize, height: dotSize)
        case .ok:
            Circle().fill(Theme.success).frame(width: dotSize, height: dotSize)
        }
    }

    // MARK: - The opened row

    @ViewBuilder
    private func detailsRow(_ job: RoutineJob) -> some View {
        let now = AppClock.now()
        VStack(alignment: .leading, spacing: 10) {
            if let description = job.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(Theme.secondaryOnCard)
                    .fixedSize(horizontal: false, vertical: true)
            }
            facts(job, now: now)
            if let error = RoutineGroups.errorText(job) { errorBox(job, error) }
            if let sends = job.executor?.sends {
                fold("sends", job, title: job.check != nil ? "What it sends when it fires" : "What it sends when it runs") {
                    Text(sends)
                        .font(.footnote.monospaced())
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("routines.sends.\(job.id)")
                }
            }
            // No fold that would open onto nothing: a routine with no recorded history
            // has none (its last run is a fact above), as on the console.
            let history = RoutineGroups.auditHistory(job.state)
            if !history.isEmpty {
                fold("history", job, title: RoutineGroups.historyTitle(job, count: history.count)) {
                    historyList(job, history, now: now)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                actions(job)
                if let note = RoutineGroups.shownRun(runNotes[job.id], job) {
                    Label(note.text, systemImage: note.ok ? (note.before != nil ? "clock" : "checkmark.circle") : "exclamationmark.circle")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(note.ok ? Theme.doneText : Theme.dangerText)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("routines.runOutcome.\(job.id)")
                }
            }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.actions[job.id] = $0 }
        }
        .padding(.leading, nameInset)
        .padding(.top, -4)
        .padding(.bottom, 8)
        .alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] + nameInset }
        .listRowSeparator(.hidden, edges: .top)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frames.details[job.id] = $0 }
        .id(Self.detailsId(job.id))
    }

    @ViewBuilder
    private func facts(_ job: RoutineJob, now: Date) -> some View {
        let rows = RoutineGroups.facts(job, now: now)
        if typeSize.isAccessibilitySize {
            // No room for two columns: each label above its value.
            VStack(alignment: .leading, spacing: 8) {
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.label).foregroundStyle(Theme.secondaryOnCard)
                        Text(row.value)
                            .foregroundStyle(factColor(row, job))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .font(.subheadline)
        } else {
            // Rows of a fixed label column, not a Grid: a Grid's wrapped values were
            // measured shorter than drawn, and the list cell clipped the details' top
            // and bottom (2026-11-04).
            VStack(alignment: .leading, spacing: 4) {
                ForEach(rows) { row in
                    // The label sits on the value's first line, however many it wraps to.
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(row.label)
                            .foregroundStyle(Theme.secondaryOnCard)
                            .frame(width: factLabelWidth, alignment: .leading)
                        Text(row.value)
                            .foregroundStyle(factColor(row, job))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .font(.subheadline)
        }
    }

    /// The routine's error: its first line, the rest (a stack, a page of HTML) behind
    /// "Show full error"; then what to do about it.
    private func errorBox(_ job: RoutineJob, _ error: RoutineGroups.ErrorNote) -> some View {
        // At accessibility sizes a screen holds a few words a line: the head alone, the
        // rest and what to do behind the fold (the whole box filled the screen, QA step 25).
        let ax = typeSize.isAccessibilitySize
        let head = RoutineGroups.errorHead(error.message, limit: ax ? 80 : 160)
        let key = "error.\(job.id)"
        let full = openFolds.contains(key)
        // Only an error with more than its head folds: a one-sentence error behind
        // "Show more" hid nothing but the next step (QA, accessibility sizes).
        let folds = head.more
        return VStack(alignment: .leading, spacing: 4) {
            Text(full ? error.message : head.head)
                // An old failure it has been fixed for reads quiet, as the console's note.
                .foregroundStyle(error.past ? Theme.secondaryOnCard : Theme.dangerText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("routines.error.\(job.id)")
            if let step = error.nextStep, full || !ax || !folds {
                Text(step).foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("routines.errorNext.\(job.id)")
            }
            if folds {
                Button {
                    withAnimation(.snappy(duration: 0.2)) {
                        if full { openFolds.remove(key) } else { openFolds.insert(key) }
                    }
                } label: {
                    Text(full ? "Show less" : "Show full error")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Self.actionText)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("routines.errorFold.\(job.id)")
            }
        }
        .font(.footnote)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(error.past ? Color(.tertiarySystemFill) : Theme.dangerSoft, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("routines.errorBox.\(job.id)")
    }

    /// A stopped trigger's State reads red: it needs a look, like its dot.
    private func factColor(_ row: RoutineGroups.Fact, _ job: RoutineJob) -> Color {
        row.label == "State" && RoutineGroups.isStopped(job) ? Theme.dangerText : Color.primary
    }

    /// A fold inside the opened row: its title line opens and closes what is under it.
    @ViewBuilder
    private func fold<Content: View>(_ kind: String, _ job: RoutineJob, title: String, @ViewBuilder content: () -> Content) -> some View {
        let key = "\(kind).\(job.id)"
        let isOpen = openFolds.contains(key)
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) {
                    if isOpen { openFolds.remove(key) } else { openFolds.insert(key) }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Theme.secondaryOnCard)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                }
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("routines.\(kind)Fold.\(job.id)")
            if isOpen { content() }
        }
    }

    private func historyList(_ job: RoutineJob, _ history: [RoutineJob.State.AuditEntry], now: Date) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // All of it: the server keeps the trail short, and the title counts every row.
            ForEach(Array(history.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(RoutineGroups.auditClock(entry.atMs, now: now))
                        .monospacedDigit()
                        .foregroundStyle(Theme.secondaryOnCard)
                    Text(RoutineGroups.describeAuditEntry(entry))
                        .foregroundStyle(RoutineGroups.auditFailed(entry) ? Theme.dangerText : Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.footnote)
                .accessibilityElement(children: .combine)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("routines.historyList.\(job.id)")
    }

    /// Run now, Edit and Delete: side by side at their whole width, or one under
    /// another when they do not fit (always at accessibility sizes). A button is
    /// never cut to "Del…", and each is drawn once, so the delete question can
    /// point at its own button.
    private func actions(_ job: RoutineJob) -> some View {
        // Small capsules close together: the four fit on one line at 390pt (Delete sat alone
        // on a second line and read as a heavier step, 2026-11-04 review).
        RowOrColumn(spacing: 6, column: typeSize.isAccessibilitySize) {
            // A paused trigger is disarmed on its daemon; Resume is the way to check it
            // again, and a stopped one offers it here (its State says why it stopped).
            if job.enabled || job.check == nil {
                runButton(job)
            } else if RoutineGroups.isStopped(job) {
                Button { Task { await toggle(job) } } label: {
                    Text("Resume").foregroundStyle(Self.actionText)
                }
                    .buttonStyle(RowActionStyle())
                    .disabled(busyIds.contains(job.id))
                    .accessibilityIdentifier("routines.resume.\(job.id)")
            }
            Button {
                editing = .edit(job)
            } label: {
                Text("Edit").foregroundStyle(Self.actionText)
            }
            .buttonStyle(RowActionStyle())
            .disabled(busyIds.contains(job.id))
            .accessibilityIdentifier("routines.edit.\(job.id)")
            // The task it runs in, opened the way a task link opens one (the console's
            // "Open task").
            if let task = RoutineGroups.currentTask(job) {
                Button {
                    openedTask = InboxTaskDestination(id: task, title: job.owner?.taskId == task ? job.owner?.title : nil)
                } label: {
                    Text("Open task").foregroundStyle(Self.actionText)
                }
                .buttonStyle(RowActionStyle())
                .accessibilityIdentifier("routines.openTask.\(job.id)")
            }
            Button(role: .destructive) {
                pendingDelete = job
            } label: {
                // The app's tint would draw it brown: the destructive role keeps it red.
                Text("Delete").foregroundStyle(Self.deleteText)
            }
            .buttonStyle(RowActionStyle(danger: true))
            .disabled(busyIds.contains(job.id))
            .accessibilityIdentifier("routines.delete.\(job.id)")
            .confirmationDialog(
                "Delete \"\(job.name)\"?",
                isPresented: Binding(
                    get: { pendingDelete?.id == job.id },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Routine", role: .destructive) {
                    pendingDelete = nil
                    Task { await remove(job) }
                }
            } message: {
                Text("The schedule is removed permanently. This can't be undone.")
            }
        }
        .font(.footnote.weight(.semibold))
    }

    /// Run now keeps one width while it starts (the buttons beside it never move); what
    /// the run said shows under the buttons.
    private func runButton(_ job: RoutineJob) -> some View {
        let idle = job.check != nil ? "Run check now" : "Run now"
        let running = runningIds.contains(job.id)
        return Button {
            Task { await runNow(job) }
        } label: {
            ZStack {
                Text(idle).hidden()
                if running { ProgressView().controlSize(.small) } else { Text(idle).foregroundStyle(Self.actionText) }
            }
        }
        .buttonStyle(RowActionStyle())
        .disabled(running || busyIds.contains(job.id))
        .accessibilityLabel(running ? "Starting" : idle)
        .accessibilityIdentifier("routines.run.\(job.id)")
    }

    // MARK: - Actions

    private func toggleOpen(_ id: String) {
        let opening = openId != id
        // The open row is above this one: it closes as this opens, and this row is held
        // where it was (no animation, so it never travels up and back under the finger).
        if opening, let open = openId, let above = frames.line[open], let tapped = frames.line[id], above.minY < tapped.minY {
            // The row above closes first, and in the same layout pass the list's offset is
            // set from where the tapped row is now laid out, so no frame shows it moved (a
            // correction a frame later showed it 30ms off, QA); then it opens below its line.
            let sameGroup = shownGroups.contains { group in
                group.routines.contains { $0.id == open } && group.routines.contains { $0.id == id }
            }
            scroll.hold(rowAt: tapped, removedAbove: sameGroup ? 1 : 0)
            openId = nil
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(20))
                guard openId == nil else { return }
                openId = id
                scrollRequest = ScrollRequest(id: id, keepAt: tapped.minY)
            }
            return
        }
        withAnimation(.snappy(duration: 0.2)) { openId = opening ? id : nil }
        if opening { scrollRequest = ScrollRequest(id: id) }
    }

    /// A local change to one routine: reads that started before it are dropped.
    private func wrote(_ id: String) {
        writes += 1
        rowWrites[id, default: 0] += 1
    }

    private func load() async {
        let at = writes
        do {
            let fresh = try await api.routines()
            // A switch, a save or a delete made while this was in flight is newer.
            guard !loaded || writes == at else { return }
            jobs = fresh
            // The rows shown keep their places; newcomers join after them.
            shownOrder = RoutineGroups.shownOrder(shownGroups)
            loadError = nil
            refreshError = nil
            if let open = openId, !jobs.contains(where: { $0.id == open }) { openId = nil }
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            // Once the list is up, a failed refresh only says so above it.
            if loaded && loadError == nil {
                refreshError = Self.friendlyError(error)
            } else {
                loadError = Self.friendlyError(error)
            }
        }
        loaded = true
    }

    /// Adopt the server's copy of one routine; a server older than `owner` answers
    /// without it, so the row keeps the group it is in.
    private func adopt(_ updated: RoutineJob) {
        replace(updated.id) { current in
            var next = updated
            if next.owner == nil { next.owner = current.owner }
            return next
        }
    }

    private func saved(_ job: RoutineJob) {
        let before = jobs.first { $0.id == job.id }
        wrote(job.id)
        adopt(job)
        rowErrors[job.id] = nil
        // Pointed at a task in another project: it moves to that group, shown open there.
        if let before, RoutineGroups.groupKey(before) != RoutineGroups.groupKey(job) {
            let key = RoutineGroups.groupKey(job)
            if folded.contains(key) { foldedRaw = folded.subtracting([key]).sorted().joined(separator: "\n") }
            scrollRequest = ScrollRequest(id: job.id, bringFirst: true)
        }
    }

    /// A new routine: listed, its group unfolded, opened and brought into view.
    private func created(_ job: RoutineJob) {
        wrote(job.id)
        jobs.removeAll { $0.id == job.id }
        jobs.append(job)
        shownOrder = RoutineGroups.shownOrder(shownGroups)
        let key = RoutineGroups.groupKey(job)
        if folded.contains(key) { foldedRaw = folded.subtracting([key]).sorted().joined(separator: "\n") }
        withAnimation(.snappy(duration: 0.2)) { openId = job.id }
        scrollRequest = ScrollRequest(id: job.id, bringFirst: true)
    }

    /// Optimistic flip; a refusal puts back only this routine and says on its row what
    /// failed. After a resume the routine is fetched, so its next run shows.
    private func toggle(_ job: RoutineJob) async {
        guard !busyIds.contains(job.id) else { return }
        busyIds.insert(job.id)
        rowErrors[job.id] = nil
        wrote(job.id)
        let before = jobs.first { $0.id == job.id } ?? job
        let on = !before.enabled
        replace(job.id) { $0.switched(on, atMs: AppClock.now().timeIntervalSince1970 * 1000) }
        do {
            let updated = try await api.toggleRoutine(id: job.id)
            adopt(updated)
            busyIds.remove(job.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "toggled routine", ["routineId": job.id, "enabled": String(updated.enabled)])
            if updated.enabled { await refresh(job.id) }
        } catch {
            replace(job.id) { _ in before }
            busyIds.remove(job.id)
            if let apiError = error as? APIError, apiError.isCancelled { return }
            rowErrors[job.id] = RoutineGroups.actionFailure(RoutineGroups.switchVerb(before, on: on), Self.friendlyError(error))
            AppLog.info("routines", "toggle refused", ["routineId": job.id])
        }
    }

    /// Run now: "Started", then what the routine shows once it ran (the server answers
    /// before the run delivers), or why it did not run. Each on the opened row.
    private func runNow(_ job: RoutineJob) async {
        guard !runningIds.contains(job.id) else { return }
        runningIds.insert(job.id)
        rowErrors[job.id] = nil
        runNotes[job.id] = nil
        let current = jobs.first { $0.id == job.id } ?? job
        do {
            let result = try await api.runRoutineNow(id: job.id)
            runningIds.remove(job.id)
            if let refusal = result.refusal {
                // A 200 that did not start anything: say why, never "Started".
                runNotes[job.id] = RoutineGroups.didNotRun(refusal, current)
                showOutcome(job.id)
                AppLog.info("routines", "run now refused", ["routineId": job.id])
                await refresh(job.id)
                return
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "ran routine now", ["routineId": job.id])
            let note = RoutineGroups.started(current)
            runNotes[job.id] = note
            showOutcome(job.id)
            await follow(job.id, note)
        } catch {
            runningIds.remove(job.id)
            if let apiError = error as? APIError, apiError.isCancelled { return }
            runNotes[job.id] = RoutineGroups.didNotRun(Self.friendlyError(error), current)
            showOutcome(job.id)
        }
    }

    /// What Run now said comes into view above the tab bar, with its buttons.
    private func showOutcome(_ id: String) {
        if openId == id { scrollRequest = ScrollRequest(id: id, outcome: true) }
    }

    /// Fetch the routine until it shows how the run went (about 20 seconds at most).
    /// A failure stays until the next run; a success goes after a few seconds, and so
    /// does a "Started" that never heard back (a long turn).
    private func follow(_ id: String, _ note: RoutineGroups.RunNote) async {
        guard let before = note.before else { return }
        for delay in [0.0, 1, 2, 3, 5, 8] {
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard runNotes[id] == note else { return }
            await refresh(id)
            guard runNotes[id] == note else { return }
            if let job = jobs.first(where: { $0.id == id }), let settled = RoutineGroups.settledRun(before: before, job) {
                runNotes[id] = settled
                showOutcome(id)
                guard settled.ok else { return }
                try? await Task.sleep(for: .seconds(4))
                if runNotes[id] == settled { runNotes[id] = nil }
                return
            }
        }
        if runNotes[id] == note { runNotes[id] = nil }
    }

    /// GET one routine and adopt it, unless the routine changed here while the read
    /// was out (its answer would put back the older state). A failure leaves the row.
    private func refresh(_ id: String) async {
        let at = rowWrites[id] ?? 0
        guard let fresh = try? await api.routine(id: id) else { return }
        guard (rowWrites[id] ?? 0) == at, !busyIds.contains(id) else { return }
        adopt(fresh)
    }

    private func remove(_ job: RoutineJob) async {
        guard !busyIds.contains(job.id) else { return }
        busyIds.insert(job.id)
        rowErrors[job.id] = nil
        wrote(job.id)
        let before = jobs.first { $0.id == job.id } ?? job
        let wasOpen = openId == job.id
        jobs.removeAll { $0.id == job.id }
        if wasOpen { openId = nil }
        defer { busyIds.remove(job.id) }
        do {
            try await api.deleteRoutine(id: job.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "deleted routine", ["routineId": job.id])
        } catch {
            // Back in its place (the shown order still holds it), open if it was.
            if !jobs.contains(where: { $0.id == job.id }) { jobs.append(before) }
            if wasOpen { openId = job.id }
            if let apiError = error as? APIError, apiError.isCancelled { return }
            rowErrors[job.id] = RoutineGroups.actionFailure("delete it", Self.friendlyError(error))
            AppLog.info("routines", "delete refused", ["routineId": job.id])
        }
    }

    private func replace(_ id: String, _ transform: (RoutineJob) -> RoutineJob) {
        jobs = jobs.map { $0.id == id ? transform($0) : $0 }
    }

    /// Honest copy for the cloud-relay failure ladder (same as session controls).
    static func friendlyError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        if apiError.isLeaderUnreachableForNow { return BridgeOfflineCopy.message(apiError) }
        switch apiError.code {
        case "session_control_needs_upgrade":
            return "Your primary box is upgrading for mobile routines. Try again in a minute."
        case "not_found":
            return "This routine no longer exists on the server."
        case "internal" where apiError.localizedDescription.contains("not running"):
            return "The routines engine is still starting. Try again in a moment."
        default:
            return apiError.localizedDescription
        }
    }
}

/// The opened row's buttons: a small capsule of the tint (red for Delete) around the
/// words, one line, and a 44pt tall target around it. Smaller than `.bordered` so the four
/// fit on one line at 390pt.
struct RowActionStyle: ButtonStyle {
    var danger = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(Capsule().fill((danger ? Theme.danger : Theme.tint).opacity(configuration.isPressed ? 0.28 : 0.15)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isEnabled ? 1 : 0.45)
    }
}

/// Its children at their whole width, side by side, wrapping onto the next line when
/// the line is full (or one under another always, `column`). A button is never cut, and
/// each is drawn once, unlike ViewThatFits; four buttons fit in two lines, not four.
struct RowOrColumn: Layout {
    var spacing: CGFloat = 10
    var column = false

    /// Each child's place, from the top leading corner, and the size they take.
    private func arrange(_ subviews: Subviews, width: CGFloat) -> (places: [CGPoint], sizes: [CGSize], size: CGSize) {
        var places: [CGPoint] = []
        var sizes: [CGSize] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for subview in subviews {
            var size = subview.sizeThatFits(.unspecified)
            if size.width > width {
                size = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
                size.width = min(size.width, width)
            }
            if x > 0, column || x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            places.append(CGPoint(x: x, y: y))
            sizes.append(size)
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return (places, sizes, CGSize(width: widest, height: y + lineHeight))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(subviews, width: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let laid = arrange(subviews, width: bounds.width)
        for (i, subview) in subviews.enumerated() {
            subview.place(at: CGPoint(x: bounds.minX + laid.places[i].x, y: bounds.minY + laid.places[i].y),
                          anchor: .topLeading, proposal: ProposedViewSize(laid.sizes[i]))
        }
    }
}

/// The List's own scroll view, found in the window by the list's identifier (or as
/// the collection view under a row), so the Routines screen can hold a row in place
/// while the row above it closes. A view placed inside the list to find it made the
/// header it sat in unhittable to automation, so it is looked up instead.
final class ListScroll {
    private weak var view: UIScrollView?
    private var shrink: NSKeyValueObservation?
    /// Which hold the pending give-up belongs to: a newer one is never cleared by it.
    private var holdToken = 0

    /// The row being held where it is on screen: its place in the list once the change
    /// lands, and how far below the list's top edge it was.
    private struct Held {
        let index: IndexPath
        let screenY: CGFloat
    }
    private var held: Held?
    private weak var heldCell: UICollectionViewCell?

    /// Hold the row under `frame` (in the window) where it is on screen while rows above it
    /// change: each time the list's content changes size, the offset is set from where
    /// the list now lays that row out, in the same layout pass. The size change itself
    /// is no guide: it also counts rows off screen whose guessed heights changed, and
    /// moving by it once threw the tapped row off the screen (2026-11-05, QA).
    /// `removedAbove` is how many rows go above it in its own section. Given up after
    /// 0.8 s, or by `endHold`.
    func hold(rowAt frame: CGRect, removedAbove: Int) {
        endHold()
        guard let list = locate(near: frame) as? UICollectionView else { return }
        let point = list.convert(CGPoint(x: frame.midX, y: frame.midY), from: nil)
        guard let index = list.indexPathForItem(at: point), let laid = list.layoutAttributesForItem(at: index) else { return }
        let cell = list.cellForItem(at: index)
        heldCell = cell
        held = Held(index: IndexPath(item: max(0, index.item - removedAbove), section: index.section),
                    screenY: (cell?.frame.minY ?? laid.frame.minY) - list.contentOffset.y)
        holdToken += 1
        let token = holdToken
        shrink = list.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
            self?.alignHeld()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            if self?.holdToken == token { self?.endHold() }
        }
    }

    var isHolding: Bool { held != nil }

    /// Put the held row back where it was on screen. Inside a layout pass (`measured`
    /// false) from where the list's layout now puts its place; afterwards from where its
    /// own cell is drawn, once the cells have moved (the layout's place alone left it
    /// 29pt off, 2026-11-05).
    func alignHeld(measured: Bool = false) {
        guard let held, let list = view as? UICollectionView, list.window != nil else { return }
        let top: CGFloat
        if measured, let cell = heldCell, cell.window != nil, cell.superview === list, list.indexPath(for: cell) != nil {
            top = cell.frame.minY
        } else {
            let index = held.index
            guard index.section < list.numberOfSections, index.item < list.numberOfItems(inSection: index.section),
                  let laid = list.layoutAttributesForItem(at: index) else { return }
            top = laid.frame.minY
        }
        let lowest = -list.adjustedContentInset.top
        let highest = max(lowest, list.contentSize.height - list.bounds.height + list.adjustedContentInset.bottom)
        let target = min(max(top - held.screenY, lowest), highest)
        guard abs(target - list.contentOffset.y) > 0.5 else { return }
        list.contentOffset = CGPoint(x: list.contentOffset.x, y: target)
    }

    func endHold() {
        holdToken += 1
        shrink = nil
        held = nil
        heldCell = nil
    }

    /// Where the tab bar starts, in the window: it floats over the list, so what must be
    /// seen stays above it.
    static func tabBarTop(in window: UIWindow?) -> CGFloat? {
        guard let window else { return nil }
        var top: CGFloat?
        func walk(_ v: UIView) {
            if let bar = v as? UITabBar, !bar.isHidden, bar.alpha > 0.01, bar.window != nil {
                let frame = bar.convert(bar.bounds, to: nil)
                if frame.height > 0, frame.minY < window.bounds.maxY { top = min(top ?? frame.minY, frame.minY) }
                return
            }
            for sub in v.subviews where !sub.isHidden { walk(sub) }
        }
        walk(window)
        return top
    }

    func locate(near frame: CGRect?) -> UIScrollView? {
        if let view, view.window != nil { return view }
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        var named: UIScrollView?
        var under: UIScrollView?
        func walk(_ v: UIView) {
            if let scroll = v as? UIScrollView {
                if scroll.accessibilityIdentifier == "routines.list" { named = scroll }
                // The frontmost visible collection view under the row (a later sibling is in front).
                if scroll is UICollectionView, !scroll.isHidden, scroll.alpha > 0, let frame,
                   scroll.convert(scroll.bounds, to: nil).contains(CGPoint(x: frame.midX, y: frame.midY)) { under = scroll }
            }
            for sub in v.subviews where named == nil && !sub.isHidden { walk(sub) }
        }
        for window in windows where window.isKeyWindow { walk(window) }
        view = named ?? under
        return view
    }
}

/// Where each routine's line and opened details were last laid out, on screen. A
/// reference, written as the list lays out, so a write never redraws the list.
final class RowFrames {
    var line: [String: CGRect] = [:]
    var details: [String: CGRect] = [:]
    var header: [String: CGRect] = [:]
    /// The opened row's buttons and what Run now said under them.
    var actions: [String: CGRect] = [:]
}
