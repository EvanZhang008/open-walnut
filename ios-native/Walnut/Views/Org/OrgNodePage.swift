import SwiftUI

/// The three views of an Org node beside its chat, as on the web Org page's side bar: Threads
/// first (his own requests), then Tasks and Brief.
enum OrgNodeTab: String, CaseIterable, Identifiable, Hashable {
    case threads, tasks, brief
    var id: String { rawValue }
    var label: String {
        switch self {
        case .threads: return "Threads"
        case .tasks: return "Tasks"
        case .brief: return "Brief"
        }
    }
    var symbol: String {
        switch self {
        case .threads: return "bubble.left.and.text.bubble.right"
        case .tasks: return "checklist"
        case .brief: return "doc.text"
        }
    }
}

/// Which node page to show, and on which view: an item for `navigationDestination`.
struct OrgNodeRoute: Hashable, Identifiable {
    let nodeId: String
    let name: String
    let isMain: Bool
    let sessionId: String?
    var tab: OrgNodeTab = .threads
    var threadId: String? = nil
    var id: String { "\(nodeId)|\(tab.rawValue)|\(threadId ?? "")" }
}

/// An Org node's page on the phone: one of Threads, Tasks and Brief at a time, picked at the top.
/// Its chat stays a Back away.
struct OrgNodePage: View {
    let route: OrgNodeRoute
    @State private var tab: OrgNodeTab
    @State private var threads: OrgThreadsStore
    @Environment(TasksStore.self) private var tasks
    @Environment(\.dynamicTypeSize) private var typeSize

    init(route: OrgNodeRoute) {
        self.route = route
        _tab = State(initialValue: route.tab)
        _threads = State(initialValue: OrgThreadsStore(taskId: route.nodeId))
    }

    private var node: WalnutTask? { tasks.tasks.first { $0.id == route.nodeId } }

    var body: some View {
        VStack(spacing: 0) {
            viewPicker
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            Divider()
            Group {
                switch tab {
                case .threads:
                    OrgThreadsView(store: threads, name: route.name, sessionId: route.sessionId, focusThreadId: route.threadId,
                                   nodeShown: node?.userStatus?.threads?.shown)
                case .tasks:
                    OrgNodeTasksView(nodeId: route.nodeId, isMain: route.isMain)
                case .brief:
                    OrgBriefView(taskId: route.nodeId, name: route.name)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(route.name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await threads.load() }
        // The node's own row moves when its threads change (its status carries their counts).
        .onChange(of: node?.userStatus?.threads) { Task { await threads.load() } }
        .accessibilityIdentifier("org.node.page")
    }

    /// Three segments side by side at ordinary sizes. At the accessibility sizes three labels
    /// never fit one row (each read "T…", and the row grew taller than the page's content), so the
    /// picker collapses to one full-width button naming the view shown, with the others in its menu.
    @ViewBuilder private var viewPicker: some View {
        if OrgNodeBarLayout.collapses(typeSize) {
            Menu {
                Picker("View", selection: $tab) {
                    ForEach(OrgNodeTab.allCases) { t in
                        Label(label(t), systemImage: t.symbol).tag(t)
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: tab.symbol)
                    Text(label(tab)).lineLimit(1).minimumScaleFactor(0.7)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.up.chevron.down").font(.footnote)
                }
                .font(.body.weight(.medium))
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(Color(uiColor: .tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .dynamicTypeSize(...OrgNodeBarLayout.typeCap)
            .accessibilityLabel("View: \(label(tab))")
            .accessibilityIdentifier("org.node.tabs")
        } else {
            Picker("View", selection: $tab) {
                ForEach(OrgNodeTab.allCases) { t in
                    Text(label(t)).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("org.node.tabs")
        }
    }

    private func label(_ t: OrgNodeTab) -> String {
        guard t == .threads else { return t.label }
        let read = threads.threads.map { OrgThreadModel.sections($0, now: AppClock.now()).open.count }
        // A read that brought none of the threads the counts name shows those counts, as its page says.
        let shown = read.map { OrgThreadModel.unreadCount(serverCount: threads.shownCount,
                                                          nodeCount: node?.userStatus?.threads?.shown, read: $0) ?? $0 }
            ?? node?.userStatus?.threads?.shown ?? 0
        // "Threads 0" too, as the bar under the chat reads (the owner: "even if no thread, show 0").
        return "Threads \(shown)"
    }
}

/// The row at the top of an Org node's chat that opens its Threads, Tasks and Brief, each its own
/// page. Threads lead and carry the count of the ones for him (coloured when one waits on him).
/// How the Org node's bars give way at the accessibility text sizes (2026-11-08, a QA run at
/// accessibility XXXL: the three buttons of the chat's bar each read "T…", the bar took a sixth
/// of the screen and left the chat about one line tall). From the first accessibility size the
/// bar keeps one row of icons with the threads count, its type capped at the largest standard
/// size, and a long press shows each button's name large (the Large Content Viewer, as the tab
/// bar does); the node page's picker becomes one button with a menu.
enum OrgNodeBarLayout {
    static let typeCap = DynamicTypeSize.xxxLarge
    static func collapses(_ size: DynamicTypeSize) -> Bool { size.isAccessibilitySize }
}

struct OrgNodeBar: View {
    let node: WalnutTask
    let open: (OrgNodeTab) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let counts = node.userStatus?.threads
        let compact = OrgNodeBarLayout.collapses(typeSize)
        HStack(spacing: 8) {
            ForEach(OrgNodeTab.allCases) { t in
                Button { open(t) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: t.symbol).font(compact ? .body : .footnote)
                        if !compact {
                            Text(t.label).font(.subheadline.weight(.medium))
                        }
                        if t == .threads {
                            let n = counts?.shown ?? 0
                            Text("\(n)")
                                .font(.caption.monospacedDigit().weight(.bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                // The drawer's count for the same node (ChatDrawerOrg): one colour for one number.
                                .background(n > 0 ? UserStatePill.color(.needs) : Color(.systemGray3), in: Capsule())
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: compact ? 44 : 36)
                    .background(Color(uiColor: .tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(t == .threads ? "Threads, \(counts?.shown ?? 0)" : t.label)
                .accessibilityShowsLargeContentViewer {
                    Label(t == .threads ? "Threads \(counts?.shown ?? 0)" : t.label, systemImage: t.symbol)
                }
                .accessibilityIdentifier("org.bar.\(t.rawValue)")
            }
        }
        .dynamicTypeSize(...OrgNodeBarLayout.typeCap)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar)
        // A visible edge: the chat scrolls under the bar, and a line cut by it must read as scrolled.
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5)
        }
        .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
        .zIndex(1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("org.bar")
    }
}
