import SwiftUI

/// Pick the folder (and host) a new session runs in: a searchable sheet over the
/// SAME ranked candidate set the web console's path selector uses.
///
/// Form-factor call: the desktop version is a wide flyout anchored to the cwd
/// pill (`SessionPathSelector.tsx`), which a phone has no room for. This is a
/// sheet with ONE field at the top and a ranked, sectioned list under it: the
/// same four input states (browse / dir-browse / segment / scoped-search), the
/// same frecency-decayed history, the same admission rule, and the same
/// `host::cwd` identity (`PathRanking.pathChipKey`) so a folder means the same
/// thing on both surfaces. Ranking lives in `Core/PathRanking.swift`, which is a
/// direct port of the web's `ranking.ts`.
///
/// Overflow discipline (the iOS analogue of the web's "menus never overflow"
/// rule): the candidate list is unbounded, so it is its own scrolling surface in
/// a sheet, never inline growth inside the composer. The host filter is a menu,
/// which UIKit places, so it cannot grow past the screen no matter how many hosts
/// are configured.
///
/// Degrade, never block (the fetch-and-degrade precedent): launch options may be
/// missing (first run, cloud relay down) and a live listing may fail per host. In
/// every case the field still accepts a typed absolute path and Start still works,
/// because being unable to reach a directory LISTING is not a reason to stop
/// someone who knows where they want to work.
struct SessionPathPicker: View {
    /// Frequent dirs + hosts from GET /sessions/launch-options (may be empty).
    let options: SessionLaunchOptions?
    /// Currently chosen path, so the sheet opens on it.
    let initialPath: String
    let initialHost: String
    let onSelect: (_ cwd: String, _ host: String) -> Void

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var text = ""
    /// "" = every host, "__local__" = the Mac, else an alias.
    @State private var hostFilter = ""
    /// Live listings keyed by host key ("__local__" / alias).
    @State private var live: [String: HostListing] = [:]
    @State private var listTask: Task<Void, Never>?
    /// Bumped per debounce fire; a stale response is dropped (epoch guard, same
    /// as the web's useLiveDirs — a slow SSH reply must not clobber newer input).
    @State private var epoch = 0
    @FocusState private var focused: Bool

    struct HostListing: Equatable {
        enum Status: Equatable { case loading, done, failed(String) }
        var status: Status
        var parent: String = ""
        var exists: Bool = true
        var dirs: [String] = []
    }

    private static let debounce = Duration.milliseconds(180)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                pathField
                Divider()
                candidateList
            }
            .navigationTitle("Working Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    hostMenu
                }
            }
            .onAppear {
                if text.isEmpty {
                    text = initialPath
                    hostFilter = initialHost.isEmpty ? "" : initialHost
                }
                focused = true
                scheduleListing()
            }
            .onChange(of: text) { _, _ in scheduleListing() }
            .onChange(of: hostFilter) { _, _ in scheduleListing() }
            .onDisappear { listTask?.cancel() }
        }
    }

    // MARK: - Field

    private var pathField: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("/path/to/project, or a name to search", text: $text)
                    .font(.system(.subheadline, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.done)
                    .focused($focused)
                    .onSubmit { commitTyped() }
                    .accessibilityIdentifier("pathPicker.field")
                if !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .accessibilityIdentifier("pathPicker.clear")
                }
                // Shell-style one level up. A phone keyboard has no
                // Option+Backspace, so the web's deleteLastSegment gets a button.
                if text.contains("/") {
                    Button {
                        text = PathInput.deleteLastSegment(text)
                    } label: {
                        Image(systemName: "arrow.up.left")
                            .font(.caption.weight(.semibold))
                    }
                    .accessibilityIdentifier("pathPicker.up")
                }
            }
            statusLine
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    /// One honest line about the typed path. Never blocks: a host that timed out
    /// yields no verdict, so the user who knows the path is right still proceeds.
    @ViewBuilder
    private var statusLine: some View {
        let failures = live.filter { if case .failed = $0.value.status { return true } else { return false } }
        if !failures.isEmpty {
            Text(failures.count == 1
                 ? "\(hostLabel(failures.keys.first!)) didn't answer — you can still type a path."
                 : "\(failures.count) hosts didn't answer — you can still type a path.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("pathPicker.degraded")
        } else if options == nil {
            Text("No recent folders yet — type an absolute path.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("pathPicker.noOptions")
        } else if !typedIsUsable, !text.isEmpty {
            Text("Paths must be absolute (start with /).")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var hostMenu: some View {
        Menu {
            Button {
                hostFilter = ""
            } label: {
                if hostFilter.isEmpty { Label("All hosts", systemImage: "checkmark") } else { Text("All hosts") }
            }
            ForEach(options?.hosts ?? []) { host in
                let key = host.alias.isEmpty ? PathRanking.localHostKey : host.alias
                Button {
                    hostFilter = key
                } label: {
                    if hostFilter == key {
                        Label(host.label, systemImage: "checkmark")
                    } else {
                        Label(host.label, systemImage: NewSessionSheet.hostIcon(alias: host.alias, label: host.label))
                    }
                }
            }
        } label: {
            Text(hostFilter.isEmpty ? "All hosts" : hostLabel(hostFilter))
                .font(.subheadline)
                .lineLimit(1)
        }
        .accessibilityIdentifier("pathPicker.hostFilter")
    }

    // MARK: - List

    private var candidateList: some View {
        List {
            // A typed absolute path that isn't already the top candidate: offer it
            // verbatim. This is the escape hatch that keeps a missing listing from
            // being a dead end.
            if typedIsUsable, !sections.contains(where: { $0.items.first?.cwd == normalizedTyped }) {
                Section {
                    Button {
                        commitTyped()
                    } label: {
                        row(
                            title: PathRanking.pathBasename(normalizedTyped),
                            subtitle: normalizedTyped,
                            icon: "arrow.turn.down.right",
                            trailing: "use this path"
                        )
                    }
                    .accessibilityIdentifier("pathPicker.useTyped")
                }
            }
            ForEach(sections) { section in
                Section(section.label) {
                    // prefix(40): the list is lazy, but a 300-entry directory
                    // (measured: /Users/…/myCode lists 306) makes the sheet a wall
                    // of rows with no way to see the ranked head. Typing narrows it.
                    ForEach(section.items.prefix(40)) { item in
                        Button {
                            pick(item)
                        } label: {
                            row(
                                title: PathRanking.pathBasename(item.cwd),
                                subtitle: item.cwd,
                                icon: item.source == .history ? "clock.arrow.circlepath" : "folder",
                                trailing: trailingText(item),
                                selected: item.cwd == normalizedTyped
                            )
                        }
                        .accessibilityIdentifier("pathPicker.row")
                    }
                }
            }
            if sections.isEmpty, !typedIsUsable {
                Section {
                    Text(anyLoading ? "Looking…" : "Nothing matched. Type an absolute path to use it anyway.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("pathPicker.empty")
                }
            }
        }
        .listStyle(.plain)
    }

    private func row(
        title: String, subtitle: String, icon: String,
        trailing: String? = nil, selected: Bool = false
    ) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(selected ? Theme.tint : .primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 4)
            if selected {
                Image(systemName: "checkmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.tint)
            } else if let trailing {
                Text(trailing)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
    }

    private func trailingText(_ item: RankedPath) -> String? {
        if let history = item.history, let ago = NewSessionSheet.relativeLastUsed(history.lastUsed) {
            return ago
        }
        guard let host = item.host, !host.isEmpty else { return nil }
        return item.hostLabel ?? host
    }

    // MARK: - Candidates

    private var state: PathInputState {
        PathInput.classifyInput(text)
    }

    /// History (frequent dirs) + live children, filtered by the host filter, fed
    /// to the shared ranker. Exactly the web's candidate assembly.
    private var candidates: [PathCandidate] {
        var out: [PathCandidate] = []
        var seen = Set<String>()

        let historyEntries = (options?.dirs ?? []).filter { passesHostFilter(hostKey($0.host)) }
        var historyByKey: [String: SessionLaunchOptions.Dir] = [:]
        for dir in historyEntries {
            historyByKey[PathRanking.pathChipKey(dir: dir)] = dir
        }

        // Live children first so a directory that is BOTH live and historical is
        // emitted once, as a live row carrying its history (marker + frecency).
        for (key, listing) in live {
            guard passesHostFilter(key), listing.status == .done else { continue }
            let parent = listing.parent.hasSuffix("/") ? listing.parent : listing.parent + "/"
            for cwd in listing.dirs {
                let chipKey = PathRanking.pathChipKey(cwd: cwd, host: key == PathRanking.localHostKey ? nil : key)
                guard !seen.contains(chipKey) else { continue }
                seen.insert(chipKey)
                let relative = cwd.hasPrefix(parent) ? String(cwd.dropFirst(parent.count)) : cwd
                let depth = max(1, relative.split(separator: "/").count)
                let hist = historyByKey[chipKey]
                out.append(PathCandidate(
                    cwd: cwd,
                    host: key == PathRanking.localHostKey ? nil : key,
                    hostLabel: hist?.hostLabel ?? hostLabelIfRemote(key),
                    source: .live,
                    depth: depth,
                    history: hist.map { .init(count: $0.count, lastUsed: $0.lastUsed) }
                ))
            }
        }

        for dir in historyEntries {
            let chipKey = PathRanking.pathChipKey(dir: dir)
            guard !seen.contains(chipKey) else { continue }
            seen.insert(chipKey)
            out.append(PathCandidate(
                cwd: dir.cwd,
                host: dir.host.isEmpty ? nil : dir.host,
                hostLabel: dir.hostLabel,
                source: .history,
                depth: 0,
                history: .init(count: dir.count, lastUsed: dir.lastUsed)
            ))
        }
        return out
    }

    private var sections: [PathSection] {
        let ranked = PathRanking.rankCandidates(state: resolvedState, candidates: candidates)
        // Group by host only when the user hasn't narrowed to one: with a filter
        // applied every row shares a host and a per-host header is noise.
        let grouping = hostFilter.isEmpty
        var activity: [String: Int] = [:]
        for dir in options?.dirs ?? [] {
            let key = hostKey(dir.host)
            activity[key, default: 0] += dir.count
        }
        return PathRanking.buildSections(ranked: ranked, hostGrouping: grouping, hostActivity: activity)
    }

    /// Space ambiguity ("/a/b my dir") resolved against the live children of the
    /// base, so a real folder whose name contains a space stays a PATH.
    private var resolvedState: PathInputState {
        let children = live.values.filter { $0.status == .done }.flatMap(\.dirs)
        return PathInput.resolveSpaceAmbiguity(state: state, childrenOfBase: children)
    }

    // MARK: - Listing

    private func scheduleListing() {
        listTask?.cancel()
        epoch += 1
        let myEpoch = epoch
        guard let parent = PathInput.parentDirOf(resolvedState), parent.count >= 2 else {
            // browse mode: history only, nothing to list.
            if !live.isEmpty { live = [:] }
            return
        }
        let targets = listingTargets()
        guard !targets.isEmpty else { return }
        listTask = Task {
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled, myEpoch == epoch else { return }
            live = Dictionary(uniqueKeysWithValues: targets.map { ($0, HostListing(status: .loading)) })
            // Parallel fan-out: each host lands independently (local is fastest
            // and shows first) so one slow SSH host can't hold up the whole list.
            await withTaskGroup(of: (String, HostListing).self) { group in
                for key in targets {
                    group.addTask { [api] in
                        do {
                            let listing = try await api.listDirs(
                                prefix: parent,
                                host: key == PathRanking.localHostKey ? nil : key
                            )
                            return (key, HostListing(
                                status: .done, parent: listing.parent,
                                exists: listing.exists, dirs: listing.dirs
                            ))
                        } catch {
                            return (key, HostListing(status: .failed(error.localizedDescription)))
                        }
                    }
                }
                for await (key, listing) in group {
                    // Epoch guard on EVERY arrival, not just before the fan-out:
                    // the group outlives a keystroke, and a stale reply landing
                    // after newer input is exactly how the list starts lying.
                    guard myEpoch == epoch else { continue }
                    live[key] = listing
                }
            }
        }
    }

    private func listingTargets() -> [String] {
        if !hostFilter.isEmpty { return [hostFilter] }
        var keys = [PathRanking.localHostKey]
        for host in options?.hosts ?? [] where !host.alias.isEmpty {
            keys.append(host.alias)
        }
        return keys
    }

    private var anyLoading: Bool {
        live.values.contains { $0.status == .loading }
    }

    // MARK: - Selection

    private func pick(_ item: RankedPath) {
        // The wire wants "" for local; the ranker uses nil. One conversion point.
        onSelect(item.cwd, item.host ?? "")
        dismiss()
    }

    private func commitTyped() {
        guard typedIsUsable else { return }
        // A typed path has no host of its own, so it lands on whichever host the
        // filter names; "all hosts" means the primary box (the only host a path
        // can be assumed to exist on without a listing to prove otherwise).
        let host = (hostFilter.isEmpty || hostFilter == PathRanking.localHostKey) ? "" : hostFilter
        onSelect(normalizedTyped, host)
        dismiss()
    }

    private var normalizedTyped: String {
        var t = text.trimmingCharacters(in: .whitespaces)
        while t.count > 1, t.hasSuffix("/") { t.removeLast() }
        return t
    }

    /// Same absolute-path gate the server enforces, applied before Start so a
    /// doomed launch never becomes an opaque session error later.
    private var typedIsUsable: Bool {
        normalizedTyped.hasPrefix("/") && normalizedTyped.count > 1
    }

    // MARK: - Hosts

    private func hostKey(_ wireHost: String) -> String {
        wireHost.isEmpty ? PathRanking.localHostKey : wireHost
    }

    private func passesHostFilter(_ key: String) -> Bool {
        hostFilter.isEmpty || hostFilter == key
    }

    private func hostLabelIfRemote(_ key: String) -> String? {
        guard key != PathRanking.localHostKey else { return nil }
        return options?.hosts.first { $0.alias == key }?.label
    }

    private func hostLabel(_ key: String) -> String {
        if key == PathRanking.localHostKey { return "This Mac" }
        return options?.hosts.first { $0.alias == key }?.label ?? key
    }
}
