import Observation
import SwiftUI
import UIKit

/// A tap on the lock-screen work card (or its Dynamic Island) lands here: `walnut://work?list=…`
/// is dropped in this mailbox (RootView's `onOpenURL`), and `MainTabView` shows the sheet over
/// whichever tab is in front.
@Observable
@MainActor
final class WorkCardLinkBox {
    static let shared = WorkCardLinkBox()
    var pending: WorkCardList?
    /// A task the link names (the Needs you title's): the list opens with it on top. The sheet
    /// takes it when it opens.
    var pendingTask: String?

    /// The link waiting its turn: behind a sheet being closed for it, or behind one the user
    /// must finish first. The newest link wins.
    private var next: (list: WorkCardList, task: String?)?
    private var closing = false
    private var holdWatch: Task<Void, Never>?
    /// The same tap arrives twice when the app is running (the scene delegate and SwiftUI's
    /// `onOpenURL`): the second is the first, not a new tap.
    private var lastURL: (url: URL, at: Date)?

    /// Whether the URL was a card link (and is now handled).
    ///
    /// The list's sheet hangs off the tab view, and SwiftUI cannot raise it while another sheet
    /// is up (a task, an approval): that one is closed first. One that holds the user's unsaved
    /// work or a decision they owe (it refuses a swipe down) is never closed for a link: the
    /// list opens once the user is done with it.
    @discardableResult
    func open(_ url: URL, now: Date = Date()) -> Bool {
        guard let list = WorkCardLink.list(from: url) else { return false }
        if let last = lastURL, last.url == url, now.timeIntervalSince(last.at) < 2 { return true }
        lastURL = (url, now)
        AppLog.info("workcard", "card link opened", ["list": list.rawValue])
        next = (list, WorkCardLink.task(from: url))
        present()
        return true
    }

    private func present() {
        guard let target = next, !closing else { return }
        // The app's own window (`PresentationLowering`), the one its sheets are presented on.
        let root = PresentationLowering.root()
        switch Self.plan(over: Self.chain(from: root), closing: root?.presentedViewController?.isBeingDismissed == true) {
        case .show:
            next = nil
            holdWatch?.cancel(); holdWatch = nil
            pendingTask = target.task
            pending = target.list
        case .closeFirst:
            closing = true
            root?.dismiss(animated: true) { [weak self] in
                self?.closing = false
                self?.present()
            }
        case .wait:
            // A sheet on its way out: a moment, then again.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000)
                self?.present()
            }
        case .keep:
            AppLog.info("workcard", "card link held: a sheet holding unsaved work is open", ["list": target.list.rawValue])
            guard holdWatch == nil else { return }
            holdWatch = Task { [weak self] in
                // Checked twice a second for half an hour; after that the tap is too old to act on.
                for _ in 0..<3600 {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    guard let self, !Task.isCancelled else { return }
                    let root = PresentationLowering.root()
                    if Self.plan(over: Self.chain(from: root), closing: false) != .keep {
                        self.holdWatch = nil
                        self.present()
                        return
                    }
                }
                self?.holdWatch = nil
                self?.next = nil
            }
        }
    }

    /// The app's one rule for what is over it (`PresentationLowering`, which a thread push uses too).
    typealias Presenting = PresentationLowering.Presenting

    static func plan(over modal: [Bool], closing: Bool = false) -> Presenting {
        PresentationLowering.plan(over: modal, closing: closing)
    }

    private static func chain(from root: UIViewController?) -> [Bool] {
        PresentationLowering.chain(from: root)
    }
}

/// The card's three lists, the same tasks the card counts (the server's `lists`), with the
/// rows the team view draws. A row opens the task's conversation, as the team view does.
struct WorkCardSheet: View {
    @State var list: WorkCardList
    @Environment(TasksStore.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    @State private var card = WorkCardController.shared
    @State private var opened: TaskOpenTarget?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    header
                    chips
                    rows
                }
                // Full width whatever the list holds: a short empty line must not centre the column.
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            // The list the user opened, as the chip below names it.
            .navigationTitle(list.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("workcard.sheet.done")
                }
            }
            .refreshable { await reload() }
            .task {
                await reload()
                // The card's Needs you title: that task, over its list.
                if let id = WorkCardLinkBox.shared.pendingTask {
                    WorkCardLinkBox.shared.pendingTask = nil
                    opened = TaskOpenTarget(id: id, title: tasks.tasks.first { $0.id == id }?.title)
                }
            }
            // A task finished or started from here (its detail sheet) moves the numbers and the card now.
            .onChange(of: tasks.tasks.map(\.phase)) { _, _ in Task { await card.refresh() } }
            // A task tap opens its conversation, as everywhere outside the Tasks tab.
            .sheet(item: $opened) { t in
                TaskSessionSheet(target: t)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
        .accessibilityIdentifier("workcard.sheet")
    }

    private func reload() async {
        await card.refresh()
        // A task the card counts that this phone has not loaded yet (a new worker).
        if let view = card.lastView, view.lists.ids(list).contains(where: { id in !tasks.tasks.contains { $0.id == id } }) {
            await tasks.loadTasks()
        }
    }

    @ViewBuilder private var header: some View {
        if let state = card.lastView?.state {
            // When counting began belongs to Completed only; the other lists say how fresh they are.
            Text(list == .completed
                 ? "\(Self.freshness(state.updatedDate, leading: true)) · counted since \(WorkCardSheet.started(state.sinceDate))"
                 : Self.freshness(state.updatedDate, leading: true))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("workcard.sheet.since")
            // The numbers below are the last ones read: say so when the newest read failed.
            if let error = card.lastError {
                Label("Could not refresh: \(error)", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .accessibilityIdentifier("workcard.sheet.error")
            }
        } else if let error = card.lastError {
            Text("Could not read the numbers: \(error)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// When Completed began counting, with the day once that is not today.
    static func started(_ date: Date, now: Date = Date()) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }

    static func freshness(_ date: Date, leading: Bool = false) -> String {
        let age = Date().timeIntervalSince(date)
        let word = leading ? "Updated" : "updated"
        return age < 60 ? "\(word) just now" : "\(word) \(RelativeTime.short(date: date, relativeTo: Date()))"
    }

    /// One row of three while they fit; stacked at the large text sizes.
    private var chips: some View {
        ViewThatFits(in: .horizontal) {
            // In a row they share the width; stacked, each is as wide as its words.
            HStack(spacing: 2) { chipButtons(fill: true) }
            VStack(alignment: .leading, spacing: 0) { chipButtons(fill: false) }
        }
    }

    @ViewBuilder private func chipButtons(fill: Bool) -> some View {
        ForEach(WorkCardList.allCases) { l in
            let n = card.lastView?.lists.ids(l).count
            let on = list == l
            Button { list = l } label: {
                HStack(spacing: 4) {
                    Circle().fill(Self.dot(l)).frame(width: 7, height: 7)
                    Text(n.map { "\($0) \(l.label)" } ?? l.label)
                }
                .font(.caption.weight(on ? .semibold : .medium))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .frame(maxWidth: fill ? .infinity : nil)
                // The chosen list is filled in its own colour; the others are outlines.
                .background(Capsule().fill(on ? Self.dot(l).opacity(0.18) : Color.clear))
                .overlay(Capsule().stroke(on ? Self.dot(l) : Color.secondary.opacity(0.35), lineWidth: on ? 1.5 : 1))
                .padding(.horizontal, 2)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("workcard.sheet.chip.\(l.rawValue)")
        }
    }

    static func dot(_ l: WorkCardList) -> Color {
        switch l {
        case .working: return UserStatePill.color(.working)
        case .needs: return UserStatePill.color(.needs)
        case .completed: return UserStatePill.color(.done)
        }
    }

    @ViewBuilder private var rows: some View {
        let ids = card.lastView?.lists.ids(list) ?? []
        let byId = Dictionary(tasks.tasks.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // Newest first by the time each row shows (a working row's turn start, a finished
        // row's completion), so the list reads in the order of its own times.
        let found = ids.compactMap { byId[$0] }
            .map { TeamStatusRow(task: $0, state: Self.state(list, $0), status: $0.userStatus, depth: 1) }
            .sorted { TeamStatusModel.rowTime($0) > TeamStatusModel.rowTime($1) }
        let missing = ids.count - found.count
        if card.lastView != nil, found.isEmpty, missing == 0 {
            Text(emptyText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 8)
                .accessibilityIdentifier("workcard.sheet.empty")
        } else {
            LazyVStack(spacing: 0) {
                ForEach(found, id: \.task.id) { row in
                    Button { opened = TaskOpenTarget(id: row.task.id, title: row.task.title) } label: {
                        TeamStatusRowView(row: row, showsPill: false, detail: Self.detail(list, row.task))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("workcard.sheet.row")
                    Divider()
                }
                // Counted by the server, not loaded on this phone yet (a pull refreshes): the chip
                // and the rows never disagree without a word.
                if missing > 0 {
                    Text(missing == 1 ? "1 more is not loaded yet. Pull to refresh." : "\(missing) more are not loaded yet. Pull to refresh.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 10)
                        .accessibilityIdentifier("workcard.sheet.missing")
                }
            }
        }
    }

    static func state(_ list: WorkCardList, _ task: WalnutTask) -> UserState {
        switch list {
        case .working: return .working
        case .needs: return .needs
        case .completed: return .done
        }
    }

    /// The line under a row with none of its own, in the words of the list it is in: what a
    /// finished task reported. A working or waiting row adds nothing of its own: its summary is
    /// history ("38 of 120 done", a question answered days ago) and would contradict the list;
    /// a Needs you row's ask is its own line already.
    static func detail(_ list: WorkCardList, _ task: WalnutTask) -> String? {
        switch list {
        case .working: return nil
        case .needs: return nil
        case .completed: return task.resultReport?.result
        }
    }

    private var emptyText: String {
        switch list {
        case .working: return "Nothing is working right now."
        case .needs: return "Nothing needs you right now."
        case .completed:
            guard let since = card.lastView?.state.sinceDate else { return "Nothing was completed yet." }
            return "Nothing completed since \(Self.started(since)) yet."
        }
    }
}
