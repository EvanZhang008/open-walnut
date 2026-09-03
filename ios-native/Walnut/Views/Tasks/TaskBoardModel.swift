import Foundation

// MARK: - The board's data model, as pure values
//
// The board is the PINNED WORKING SET: one list of pinned tasks grouped by pin
// tier (or by project, when the bar's filter says so). A task that HAS a session
// shows that session's state on the same row and expands into it — there is no
// second "session" object on this screen, and no card. That is the whole point:
// a session is a task that has a session, so one row type carries both.
//
// "Pinned working set" is a HARD boundary, not a default: nothing here may walk
// the task store to decide what a band contains. See the section above
// `boardTier` for what that replaced and why.
//
// Every rule that decides what a band contains, in what order, what a row says,
// and what a tapped tier token does is a static function over plain values here,
// so WalnutTests drives the REAL logic without a store, a network, or a running
// app. The views in TaskBoardList/TaskBoardRow only lay these values out.

/// One row: a task, the session that belongs to it, or (for a legacy session
/// whose owning task never reached the projection) a session on its own.
struct BoardRow: Identifiable, Equatable {
    var task: WalnutTask?
    var session: WalnutSession?

    /// The session ids the OWNING TASK reports (`GET /v1/tasks/:id` → `session_ids`),
    /// or nil when the phone has never read this task's detail.
    ///
    /// THREE-VALUED, and each value is a different answer rather than a shade of the
    /// same one:
    ///
    ///  - `nil` — unknown. The slim list projection (`GET /v1/tasks`) carries no
    ///    `session_ids` at all, so this is the state every row starts in.
    ///  - `[]` — asked and learned: this task has never had a session.
    ///  - non-empty — asked and learned: it HAS sessions, and `session` above is nil
    ///    only because the session LIST does not carry them (a session old enough to
    ///    have left the list, which is exactly the case that shipped as a bug).
    ///
    /// The distinction is what lets a tap on a row with no hydrated session open the
    /// session it actually has instead of a New Session draft (`BoardModel.tapRoute`),
    /// and what lets the row say it has history instead of "no session yet"
    /// (`BoardModel.state`). Collapsing unknown into "none" is the defect: the phone
    /// then states, on no evidence, that a task with 30 sessions has never had one.
    var knownSessionIds: [String]? = nil

    /// True when this row is known to have a session — hydrated, or known by id.
    ///
    /// A BOOL over a three-valued field, so it answers only the first question ("is there a
    /// session to open") and deliberately cannot answer the second ("do we know there isn't
    /// one"). Nothing may phrase a user-facing affordance from it directly: the menu label and
    /// the row's accessibility hint go through `BoardModel.affordance`, which keeps unknown
    /// separate — reading `!hasKnownSession` as "no session" is what offered "Start Session"
    /// on tasks that already had sessions.
    var hasKnownSession: Bool {
        if session != nil { return true }
        return BoardModel.newestSessionId(knownSessionIds) != nil
    }

    /// The task this row is ABOUT, whether or not the projection carries that task.
    ///
    /// A session-only row is not a row about a session: it is a row about the task
    /// that session was started for, drawn from the session because the phone's slim
    /// projection does not have the task. The session already names its owner
    /// (`task_id`, decoded), so "which task is this" is answerable in both cases and
    /// only a session with no owner at all has no answer.
    ///
    /// This exists because the board used TWO id spaces and one of them was invisible
    /// to everything else on the screen (measured, R25): a session-only row keyed
    /// itself by the CLI session UUID (`board.row.a1d81a24-…`) while every other row
    /// keyed itself by the task id, so the search dedup's visible-id set never
    /// matched the server's hit for that same task and the task drew TWICE, 55pt
    /// apart — once as the board row and once as a "Server Search" row.
    var owningTaskId: String? {
        if let id = task?.id, !id.isEmpty { return id }
        if let id = session?.taskId, !id.isEmpty { return id }
        return nil
    }

    /// Stable identity — the TASK when there is one, so a newer session for the
    /// same task replaces the session without the row losing its place (and
    /// without an expanded row collapsing under the user).
    ///
    /// ONE id space: the owning task id whenever it is resolvable (from the task, or
    /// from the session's own `task_id` when the projection lacks the task), and the
    /// session id only for a session that owns nothing. Uniqueness survives because
    /// the population walk in `bands` keys everything by row id in ONE dictionary, so
    /// a task-driven row and a session-only row for the same task id cannot both
    /// exist: the session pass skips any id the task pass already placed.
    ///
    /// On the pinned-only board a session that owns NOTHING has no row at all (there
    /// is no task to be pinned), so the session-id fallback survives only for the
    /// row shapes tests construct directly. It stays because the id space must not
    /// depend on which caller built the row.
    var id: String { owningTaskId ?? session?.id ?? "" }

    var title: String {
        if let task, !task.title.isEmpty { return task.title }
        return session?.rowTitle ?? ""
    }

    var isDone: Bool { task?.isDone ?? false }

    /// Project label, "" = Inbox (matches the rest of the app).
    var project: String { task?.project ?? session?.project ?? "" }

    /// A tier token can only move a TASK. A session-only row has nothing to pin,
    /// so its picker is absent rather than a control that quietly does nothing.
    var canRetier: Bool { task != nil }
}

/// What the row's second line says about the work. Derived ONLY from fields the
/// slim projection actually carries (`process_status`, `last_active_at`, and the
/// owning task's `phase`) — nothing here is inferred from data we do not have.
enum BoardRowState: Equatable {
    /// A CLI process is working right now.
    case running
    /// Alive but not working: it is waiting on the machine or on a human.
    case waiting
    /// Alive/finished AND the task is in AGENT_COMPLETE — the agent handed the
    /// work back and a human owes it a look. The one state worth its own colour.
    case handedBack
    /// The CLI is gone (a normal end).
    case ended
    /// The CLI died badly.
    case failed
    /// The task HAS a session, known by id only: the session list the phone holds does
    /// not carry it, so there is no `process_status` to report — just history.
    ///
    /// It is a state of its own because the two honest facts here differ from every
    /// other case: we know work happened, and we do NOT know how it ended. Folding it
    /// into `.ended` would invent an ending; folding it into `.none` (what shipped)
    /// makes the dot and the word vanish, so a task with sessions reads as sessionless
    /// and its row's tap looks like it should start one.
    case earlierSession
    /// No session has ever run for this task — or nothing has told the phone otherwise
    /// yet (see `BoardRow.knownSessionIds`).
    case none

    /// Leading word shown on the row and in the expanded strip.
    var word: String {
        switch self {
        case .running: return "running"
        case .waiting: return "waiting"
        case .handedBack: return "handed back"
        case .ended: return "session ended"
        case .failed: return "session failed"
        case .earlierSession: return "earlier session"
        case .none: return "no session yet"
        }
    }

    /// True when the row is about work that exists (as opposed to work never started).
    /// The trailing dot draws for exactly these.
    var hasSession: Bool { self != .none }
}

/// How the board groups its rows — the phone's half of the desktop's grouping
/// control.
///
/// The board's own structure is the tier split, so the pair here is tier (its
/// native shape) vs project (the desktop's) — a third "flat" option would throw
/// away the one thing that makes this screen a board.
///
/// # The WORDS are the desktop tier bar's, and `.tier` is its "Custom order"
///
/// The desktop's tier bar (`tier-view-bar` in TodoPanel) toggles `By project` ⇄
/// `↕ Custom order`, and "custom" there means the manual pin order rather than
/// project clusters. `.tier` IS that mode on the phone: `tierBands` follows the
/// tier split's own arrays, which the server returns in `pin_order`, so the rows
/// are in the order the user arranged. The only difference is screen shape — the
/// phone shows every tier at once (its bands ARE the tiers) where the desktop is
/// already inside one tier tab.
///
/// It used to say "Tier", which named the band split and said nothing about the
/// order, so the phone and the desktop had two names for one decision. One name,
/// used by every surface that presents this value (the toggle chip on the view
/// bar, the band bar's filter menu and sheet, VoiceOver).
enum BoardGrouping: String, CaseIterable, Identifiable {
    case tier, project
    var id: String { rawValue }
    var label: String {
        switch self {
        case .tier: return "Custom order"
        case .project: return "By project"
        }
    }
}

/// The board's whole answer for one pass: the chip rail, the bands to render, and the
/// tier scope that was actually honoured.
///
/// # Why the rail and the bands are ONE value
///
/// The screen asks two different questions of the same data — *which tier am I looking
/// at* (the rail) and *how are that tier's rows headed* (the bands) — and they have to be
/// answered from the SAME population walk. Two calls would walk the projection twice, and
/// (worse) could disagree: a rail whose Focus chip says 12 over a board showing 9 is the
/// "the bar and the board contradict each other" failure this screen has shipped before.
///
/// So the rail is the TIER bands over the whole board and the bands are the scope's rows
/// under the chosen grouping, both from one walk, and `scope` is the answer both of them
/// were built against — which is why the lit chip is read off this value rather than
/// re-derived from the requested id.
struct BoardAssembly: Equatable {
    /// The chip rail: the leading `All` plus one chip per non-empty TIER, in tier order.
    ///
    /// ALWAYS tiers, under every grouping. It used to be `chips(bands)`, so switching to
    /// `By project` replaced it with `proj:` / `folder:` chips — the rail became a list of
    /// folders and the tier selection had nowhere to live. The grouping decides how the
    /// rows BELOW are headed and ordered; it does not decide what the rail is.
    let rail: [BoardModel.BandChip]
    /// The bands to render: the scope's rows, headed and ordered by the grouping.
    let bands: [BoardBand]
    /// The tier scope in force, or nil for the whole board.
    ///
    /// This is the REQUESTED scope only when the rail has a chip for it. A scope naming a
    /// tier that is gone (a deleted custom tier) or one that emptied under the reader (its
    /// last row completed, a query narrowed it away) falls back to nil, which is the
    /// fallback `BoardModel.filtered` used to perform after the fact: the worst case is
    /// "you are looking at more than you asked for", which the rail itself makes obvious,
    /// and never an empty board with no explanation.
    let scope: String?

    static let empty = BoardAssembly(rail: [], bands: [], scope: nil)
}

/// The desktop's date filter, in the two values that earn their place on a phone
/// (`DATE_FILTER_OPTIONS` also has Overdue / This week / No date, which live in a
/// "More…" dropdown there — a menu inside a filter bar inside a board is three
/// levels for a filter the user has never asked for on the phone).
enum BoardDateFilter: String, CaseIterable, Identifiable {
    case all, now
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "All"
        case .now: return "Now"
        }
    }
}

/// One band: a sticky heading plus its rows and a create affordance at the foot.
///
/// `bandId` is a tier id under `.tier` grouping and `proj:<name>` under
/// `.project` — it is an IDENTITY, used for the scroll anchor, the accessibility
/// id and the `hide done` set, and never parsed back apart. What the heading's
/// `+` files into is stated outright by `createSeed` instead of inferred from the
/// id, which is what lets a project heading create into that project without the
/// view learning a second mapping.
struct BoardBand: Identifiable, Equatable {
    let bandId: String
    let label: String
    let rows: [BoardRow]
    /// Rows this band is currently suppressing because its done rows are folded —
    /// which is the DEFAULT now (see `bands(shownDoneTiers:)`), so on a board nobody
    /// has touched this is nonzero wherever a band has completed work. Shown on the
    /// heading (`show done (N)`) so folding is never a silent disappearance.
    let hiddenDone: Int
    /// What the foot's `+` creates, or nil for a band with no create affordance.
    ///
    /// Every band the board renders has one now: a tier band files into its tier, a
    /// project band into its project. The optional survives because it is what let
    /// the retired tail band (the COMPLEMENT of the others, so "create here" had no
    /// destination to mean) say so in DATA rather than have the view infer it from
    /// the band's id — the mistake that shipped `focus_tier: "proj:marina"`.
    let createSeed: NewTaskSeed?
    /// Set only on a FOLDER band: which project heading this band nests under, and
    /// whether this band is the one that draws that heading. nil on every other band,
    /// which is what makes "the board nests" a property of the DATA rather than
    /// something the layout infers from a band id (see `BoardBandNest`).
    ///
    /// A `var` with a default so the memberwise initializer keeps its existing shape:
    /// every band the tier grouping builds, and every project band the flat fallback
    /// builds, is constructed exactly as before.
    var nest: BoardBandNest? = nil

    var id: String { bandId }
    /// The heading's number is what you can actually SEE in the band — toggling the
    /// done fold changes it, which is the feedback that the toggle worked. A count
    /// that included hidden rows would disagree with the rows below it.
    ///
    /// Since done rows fold by default, this reads as the band's OPEN count on a
    /// board nobody has expanded, and the chip above it carries the same number
    /// (`chips` reads it off the band). Expand a band and it counts what is then on
    /// screen, done included: still "what you can see", and the `show done (N)` label
    /// is what carries the done count in the folded state.
    var count: Int { rows.count }
}

/// Where a FOLDER band sits in the project → folder tree.
///
/// The board is a flat `[BoardBand]` and stays one, deliberately: the chips, the chip
/// filter, the scroll anchors, the `hide done` set and the search dedup are all defined
/// over that one array, and a second container would give every one of them a second
/// shape to handle. So the nesting is carried as metadata ON the band, and the only thing
/// the layout does with it is draw the heading differently (indented, under a rail) and —
/// on the band that leads its project — draw the project's own heading above it.
struct BoardBandNest: Equatable {
    /// The folder's `group_id`. Carried explicitly so the folder heading's accessibility
    /// identifier (`board.folder.<slug>`) comes from the FOLDER, not from parsing the
    /// band id apart — the mistake that shipped `focus_tier: "proj:marina"`.
    let folderId: String
    /// The project band this folder belongs under (`proj:<name>`), which is also the id
    /// the project heading is addressed by.
    let projectBandId: String
    /// The project's display label ("Inbox" for the empty project).
    let projectLabel: String
    /// This band draws the PROJECT heading above its own.
    ///
    /// True only when no earlier band in the rendered array already drew it, which is
    /// how a project whose loose band is empty (every pinned row filed in a folder)
    /// still gets a project heading, and how a chip that selects a single folder band
    /// keeps its context. Computed in ONE place (`BoardModel.relead`) so the builder and
    /// the chip filter cannot disagree.
    var leadsProject: Bool
    /// How deep this folder sits: 1 directly under its project heading, 2 for a subfolder,
    /// clamped at `BoardFolderIndex.maxDepth`. The heading indents by it, which is what
    /// makes a subfolder read as being INSIDE its parent rather than beside it.
    ///
    /// Defaulted (with the two fields below) so the memberwise initializer keeps its
    /// existing shape: a one-level folder band, and every test that builds a nest by hand,
    /// is constructed exactly as before.
    var depth: Int = 1
    /// This folder's ancestors, root first. Carried on the band because `relead` is what
    /// decides which of them still need drawing, and it only sees the bands.
    var ancestors: [BoardFolderStep] = []
    /// The ancestor headings THIS band has to draw above its own, because no band before it
    /// did — the folder equivalent of `leadsProject`, and what keeps a subfolder from being
    /// shown nested under a name that is nowhere on the screen (its parent folder holds no
    /// rows of its own, or a chip selected the subfolder alone). Computed in `relead`.
    var leadFolders: [BoardFolderStep] = []
}

/// One folder in a nest's ancestry: what to draw, and how far in.
///
/// A value rather than a bare id, because the heading that draws it may be drawing an
/// ancestor whose OWN band is not on screen — there is nothing else to read the label and
/// the indent off.
struct BoardFolderStep: Equatable, Identifiable {
    let folderId: String
    let label: String
    /// Visual depth, on the same 1-based scale as `BoardBandNest.depth`.
    let depth: Int

    var id: String { folderId }
}

/// task → folder, and folder → label, inverted ONCE from `GET /tasks/groups`.
///
/// It exists because the wire has no other answer: `ProjectedTask` (what `GET /v1/tasks`
/// serves) carries no `group_id`, so the only way to know which folder a row is in is to
/// invert every folder's `member_ids`. Doing that per band rebuild would be a walk over
/// the whole membership on every keystroke, so the store builds this on adoption and the
/// board is handed the finished dictionaries.
///
/// `folderOf` being a DICTIONARY is load-bearing, not incidental: it makes "which folder
/// claims this row" single-valued, so a task that (through server-side drift) appears in
/// two folders' `member_ids` still gets exactly ONE band. That is what keeps the union of
/// the project bands equal to the tier bands' row set — the invariant a duplicated row
/// would break in the most confusing possible way (the same task, twice, on one screen).
struct BoardFolderIndex: Equatable {
    /// taskId → folder id.
    let folderOf: [String: String]
    /// folder id → display label.
    let labelOf: [String: String]
    /// folder id → PARENT folder id, and it is a NORMALISED map: a self-parent, a cycle,
    /// a parent nobody listed and a parent in another project are all absent, which makes
    /// that folder a root. See `build` for why each of those is a root and not a dropped
    /// band.
    ///
    /// The normalisation happens ONCE, in `build`, and its inputs (each folder's project,
    /// which is what rejects a cross-project link) stay local to that walk. This type
    /// deliberately does not keep them: a stored copy that no reader needs is a second
    /// answer to "which project owns this folder" waiting to disagree with `TaskFolder`.
    let parentOf: [String: String]

    static let empty = BoardFolderIndex(folderOf: [:], labelOf: [:])

    /// The server's own nesting ceiling (`FOLDER_MAX_DEPTH`): a folder is at depth 1 when
    /// it sits directly under its project. Mirrored here so the phone draws the same tree
    /// the server is willing to store — and so a chain that got deeper through drift is
    /// drawn CLAMPED rather than as an indent that walks off the screen.
    static let maxDepth = 5

    init(
        folderOf: [String: String],
        labelOf: [String: String],
        parentOf: [String: String] = [:]
    ) {
        self.folderOf = folderOf
        self.labelOf = labelOf
        self.parentOf = parentOf
    }

    /// True when there is no hierarchy to draw — the flat by-project board.
    var isEmpty: Bool { folderOf.isEmpty && labelOf.isEmpty }

    /// A folder's ancestors, ROOT FIRST, excluding itself. Empty for a root.
    ///
    /// Safe on any input because `parentOf` is acyclic by construction, and it still
    /// carries its own visited set: this is the function every renderer walks, and a
    /// hierarchy walk that can loop is worth two lines of insurance.
    func ancestors(of folderId: String) -> [String] {
        var chain: [String] = []
        var seen: Set<String> = [folderId]
        var current = parentOf[folderId]
        while let id = current, !seen.contains(id) {
            chain.append(id)
            seen.insert(id)
            current = parentOf[id]
        }
        return chain.reversed()
    }

    /// A folder's depth: 1 directly under its project, clamped at `maxDepth`.
    func depth(of folderId: String) -> Int {
        min(Self.maxDepth, ancestors(of: folderId).count + 1)
    }

    /// Invert `GET /tasks/groups` once: members → owning folder, and `parent_id` →
    /// a tree the board can render.
    ///
    /// # Every broken link becomes a ROOT, never a dropped folder
    ///
    /// The one failure this must not have is an invisible task: a folder whose parent is
    /// missing, hidden from the listing, in another project, its own parent, or part of a
    /// cycle still has REAL rows, and they have to appear somewhere. So each of those links
    /// is simply not honoured and the folder is drawn at the top level of its project. The
    /// alternative — skipping a folder whose parent cannot be resolved — is how a pinned
    /// task disappears from the one screen that is supposed to show all of them.
    ///
    /// Cycles are broken at the link that closes them, which is why the resolution is a
    /// walk with a visited set rather than a single `parent_id` lookup: two folders naming
    /// each other (server drift, or a `parent_id` written by an older build) would
    /// otherwise make every reader that follows the chain hang.
    static func build(_ folders: [TaskFolder]) -> BoardFolderIndex {
        var folderOf: [String: String] = [:]
        var labelOf: [String: String] = [:]
        // LOCAL, and it stays local: the only question it answers (may this child nest inside
        // that parent) is settled below, in this same call.
        var projectOf: [String: String] = [:]
        var claimed: [String: String] = [:]
        labelOf.reserveCapacity(folders.count)
        for folder in folders {
            guard !folder.groupId.isEmpty else { continue }
            // A folder with no label still needs one — its id is ugly but addressable,
            // and a blank heading would read as a rendering bug.
            labelOf[folder.groupId] = folder.label.isEmpty ? folder.groupId : folder.label
            projectOf[folder.groupId] = folder.project
            if let parent = folder.parentId, !parent.isEmpty, parent != folder.groupId {
                claimed[folder.groupId] = parent
            }
            for taskId in folder.memberIds where !taskId.isEmpty {
                folderOf[taskId] = folder.groupId
            }
        }

        // Keep only links whose parent EXISTS and lives in the same project (the server's
        // own rule for a nest), then drop any link that would close a cycle.
        var parentOf: [String: String] = [:]
        for (child, parent) in claimed {
            guard labelOf[parent] != nil else { continue }
            let childProject = (projectOf[child] ?? "").lowercased()
            let parentProject = (projectOf[parent] ?? "").lowercased()
            guard childProject == parentProject else { continue }
            parentOf[child] = parent
        }
        for child in parentOf.keys.sorted() where closesACycle(child, in: parentOf) {
            parentOf[child] = nil
        }

        return BoardFolderIndex(folderOf: folderOf, labelOf: labelOf, parentOf: parentOf)
    }

    /// Does following `start`'s parents come back to a folder already on the walk?
    ///
    /// Sorted iteration in the caller plus this check makes the break DETERMINISTIC: the
    /// same drifted store always yields the same tree, so a folder does not move between
    /// two headings on every refresh.
    private static func closesACycle(_ start: String, in parentOf: [String: String]) -> Bool {
        var seen: Set<String> = [start]
        var current = parentOf[start]
        while let id = current {
            if seen.contains(id) { return true }
            seen.insert(id)
            current = parentOf[id]
        }
        return false
    }
}

enum BoardModel {

    /// The band a PINNED row falls into when nothing more specific claims it.
    ///
    /// The server's own default, ported verbatim from `TasksStore.tierMap` ("any
    /// pinned id missing from every bucket is satellite by definition"), so a pin
    /// whose split has not landed yet lands in the band the split is about to put
    /// it in — the row does not visibly hop when the authoritative split arrives.
    static let defaultTierId = "satellite"

    // MARK: - What is ON this board (the PINNED working set, and nothing else)
    //
    // The board used to end in a trailing "Everything else" band holding the
    // COMPLEMENT of every tier, which on the real store was 2,903 of 3,161 rows —
    // it fetched, joined, filtered, sorted and COUNTED the whole task store on
    // every body pass, and the chip row advertised the result as "All 3,175".
    //
    // The user's question retired it: "已经有 pin 了,为什么还会有 all task" — the
    // board IS the pinned working set, so a task that is not pinned has no row
    // here. `All` now means the whole PINNED board, and its count is the board's
    // own row count. Everything else is reachable through search, which is a
    // server query over the store rather than a client-side walk of it.
    //
    // The completeness guarantee that mattered SURVIVES, one scope smaller, and
    // this is the line to keep reading before touching `boardTier`: a PINNED task
    // can never be missing from this board. That was the original bug ("I created
    // a task in Pinned and it just disappeared"), and every way a pin can be known
    // — the tier map, the tier ORDER arrays, the projection's own `pinned` flag —
    // puts the task in a band. A tier decides WHICH band, never WHETHER.

    /// Which band a row belongs to on the pinned board, or nil when the row does
    /// not belong on the board at all.
    ///
    /// - Parameters:
    ///   - pinned: the slim projection's own pin flag.
    ///   - splitTier: the tier the tier split names for this row, from EITHER half
    ///     of the split (the `taskId → tier` map, or the per-tier order arrays).
    ///     Both are consulted because dropping an id one half names and the other
    ///     has not caught up with is exactly how a row goes missing.
    ///   - knownTiers: the tier ids the board actually renders (built-ins plus the
    ///     registered custom tiers). A tier id outside that set — a custom tier
    ///     deleted while a task still pointed at it — folds to the default rather
    ///     than naming a band nothing draws, which would drop the row silently.
    static func boardTier(
        pinned: Bool?, splitTier: String?, knownTiers: Set<String>
    ) -> String? {
        if let splitTier, !splitTier.isEmpty {
            return knownTiers.contains(splitTier) ? splitTier : defaultTierId
        }
        // No tier anywhere: the pin flag is the only thing left that can say the
        // task is on the board, and it is enough.
        guard pinned == true else { return nil }
        return defaultTierId
    }

    // MARK: - Session join ("a session IS a task that has a session")

    /// Latest session per task id, by last-active. One pass, no per-row search:
    /// the board renders every band from this one dictionary.
    static func latestSessionByTask(_ sessions: [WalnutSession]) -> [String: WalnutSession] {
        var latest: [String: WalnutSession] = [:]
        for session in sessions {
            guard let taskId = session.taskId, !taskId.isEmpty else { continue }
            if let current = latest[taskId], WalnutSession.recencySort(current, session) { continue }
            latest[taskId] = session
        }
        return latest
    }

    /// The NEWEST session id in a task's `session_ids`, or nil when there is none.
    ///
    /// LAST wins, and that is the server's own order rather than a guess: every link
    /// path appends (`task.session_ids.push(sessionId)`), so the array is in link
    /// order and its tail is the most recent session. Blank entries are skipped — a
    /// slot that was cleared server-side leaves an empty string, and opening `""`
    /// would be a 404 dressed up as a destination.
    static func newestSessionId(_ ids: [String]?) -> String? {
        guard let ids else { return nil }
        for id in ids.reversed() {
            let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        return nil
    }

    /// Row state from the projection's own fields (see BoardRowState).
    ///
    /// `knownSessionIds` is the task's own `session_ids` when the phone has read them
    /// (nil = never asked). It only matters when there is no hydrated session: a task
    /// that HAS sessions the session list does not carry is `.earlierSession`, not
    /// `.none`, because "no session yet" would be a statement the data contradicts.
    static func state(
        task: WalnutTask?, session: WalnutSession?, knownSessionIds: [String]? = nil
    ) -> BoardRowState {
        guard let session else {
            return newestSessionId(knownSessionIds) != nil ? .earlierSession : .none
        }
        // AGENT_COMPLETE outranks the process state on purpose: a CLI can sit
        // idle for hours after handing back, and "waiting" would bury the one
        // row that needs a human.
        if task?.phase == "AGENT_COMPLETE" { return .handedBack }
        switch session.statusKind {
        case .running: return .running
        case .idle: return .waiting
        case .error: return .failed
        case .stopped, .unknown: return .ended
        }
    }

    // MARK: - Where a row's TAP goes
    //
    // The row has ONE tap and it is a destination, not a menu (see TaskBoardRow). So
    // this is the whole routing decision for the board, as a pure function over the
    // row — the view performs it and decides nothing.
    //
    // It exists because the version it replaces was `if let session = row.session {
    // push } else { showNewSession }`, i.e. "the session list does not carry a session
    // for this task" read as "this task has never had one". Those are different facts,
    // and a server projection that dropped older sessions turned the difference into a
    // shipped bug: a tap on a pinned task with a real session opened a NEW SESSION
    // DRAFT, which (with `taskId: nil`) would have manufactured a second, orphan
    // session on an already-sessioned task.
    //
    // The server no longer drops those rows. This is the second line of defence, and
    // it earns its place for a case that is not a bug at all: a session old enough to
    // have left the list legitimately (retention) still leaves a task whose
    // `session_ids` name it, and that session is still openable BY ID.

    /// What a New Session draft must carry so it can never orphan a session.
    ///
    /// A draft reached from a TASK ROW is always about that task, so the task rides
    /// along and `POST /v1/sessions` links the new session to it. The bug this closes
    /// is quiet: an unlinked draft creates a second session that no task points at, on
    /// a task that already had one.
    ///
    /// `Identifiable` so it can BE the sheet's item (`.sheet(item:)`) rather than a
    /// second `@State` beside a Bool — two values that must agree about one sheet is
    /// how a sheet opens with the previous row's task attached.
    struct BoardDraftSeed: Equatable, Identifiable {
        /// The task the draft links to, or nil for the toolbar's task-less New Session.
        let taskId: String?
        /// Its title, for the draft's own "this will be linked to …" line.
        let taskTitle: String?

        /// The toolbar's draft: no task, nothing to link.
        static let unattached = BoardDraftSeed(taskId: nil, taskTitle: nil)

        var id: String { taskId ?? "__unattached__" }
    }

    /// Where a tapped row goes.
    ///
    /// Each case carries everything the view needs to perform it, including the DRAFT
    /// FALLBACK for the two cases that can fail — so a failed lookup lands in a draft
    /// that is still attached to the task, and the view cannot invent a different one.
    enum BoardTapRoute: Equatable {
        /// The session list has the session: push it.
        case open(WalnutSession)
        /// The task names sessions the list does not carry: fetch this one BY ID and
        /// push it (`GET /v1/sessions/:id`).
        case resolve(sessionId: String, draftFallback: BoardDraftSeed)
        /// Nothing knows yet whether this task has sessions (the slim list projection
        /// carries no `session_ids`): ask the task's own detail, THEN route.
        case probe(taskId: String, draftFallback: BoardDraftSeed)
        /// Known sessionless: start a draft, attached to the task.
        case draft(BoardDraftSeed)
    }

    /// The draft a row would start — used for the `.draft` route and as the fallback
    /// carried by the two routes that can fail.
    static func draftSeed(_ row: BoardRow) -> BoardDraftSeed {
        BoardDraftSeed(
            taskId: row.owningTaskId,
            // The row's own title, which for a session-only row is the session's —
            // still the honest name of the work the draft is about.
            taskTitle: row.title.isEmpty ? nil : row.title
        )
    }

    static func tapRoute(_ row: BoardRow) -> BoardTapRoute {
        let fallback = draftSeed(row)
        if let session = row.session { return .open(session) }
        if let sessionId = newestSessionId(row.knownSessionIds) {
            return .resolve(sessionId: sessionId, draftFallback: fallback)
        }
        // Unknown (never asked) vs learned-empty. Only the FIRST is worth a request:
        // once a task's detail has said it has no sessions, tapping it opens the draft
        // with no round trip at all.
        if row.knownSessionIds == nil, let taskId = row.owningTaskId, !taskId.isEmpty {
            return .probe(taskId: taskId, draftFallback: fallback)
        }
        return .draft(fallback)
    }

    // MARK: - What a row is ALLOWED TO SAY about its session
    //
    // The route above is three-valued and the WORDS on the screen were two-valued, which is
    // the whole defect: `row.hasKnownSession ? "Open Session" : "Start Session"` reads the
    // ledger's `nil` (nobody has asked yet) as `[]` (asked, and there are none), so a task
    // that HAS sessions was offered "Start Session" on a long press — and a user who takes
    // that offer gets a SECOND session on an already-sessioned task, which is the duplicate
    // this board's tap routing exists to prevent.
    //
    // The board loads in the unknown state for every row: `GET /v1/tasks` carries no
    // `session_ids`, and only a task's own detail or the tap probe fills the ledger in. So
    // unknown is not an edge case at all — it is what the first screen looks like — and the
    // honest thing to say there is NEITHER promise.

    /// What a row may claim about the session behind it, from the three-valued ledger.
    ///
    /// The three cases are the three answers, in the same shape `BoardTapRoute` has: a row
    /// that KNOWS it has a session (hydrated, or by id) offers to open it, a row that has
    /// LEARNED it has none offers to start one, and a row that has not asked yet offers a
    /// neutral "Open" — which is exactly what its tap does (probe, then open the session it
    /// finds, or a draft attached to the task).
    enum SessionAffordance: Equatable {
        /// Known to have a session — hydrated, or named by id.
        case open
        /// Asked and learned: this task has never had a session.
        case start
        /// Nobody has asked yet. Says nothing it cannot back up.
        case unknown

        /// The long-press menu's first item.
        ///
        /// Sentence-free Title Case, matching the rest of this board's menu ("Mark as Done",
        /// "Move to Tier"). The unknown case drops the NOUN rather than inventing a new verb:
        /// "Open" claims a destination exists without claiming what kind, and it is the one
        /// word a menu can say before the answer is known.
        var menuLabel: String {
            switch self {
            case .open: return "Open Session"
            case .start: return "Start Session"
            case .unknown: return "Open"
            }
        }

        /// The menu item's glyph. Neutral for `unknown` for the same reason the word is: a
        /// speech bubble promises a conversation that may not exist, and a play triangle
        /// promises a fresh start that may be a duplicate.
        var menuIcon: String {
            switch self {
            case .open: return "bubble.left.and.text.bubble.right"
            case .start: return "play.circle"
            case .unknown: return "arrow.up.forward.app"
            }
        }

        /// The row's VoiceOver hint. Same three answers, because a hint that promised what
        /// the menu refused to promise would just move the defect to the screen reader.
        var accessibilityHint: String {
            switch self {
            case .open: return "Open the session"
            case .start: return "Start a session"
            case .unknown: return "Open the session, or start one"
            }
        }
    }

    /// The affordance a row has earned.
    ///
    /// `nil` vs `[]` is the whole function, and it is deliberately NOT expressible through
    /// `BoardRow.hasKnownSession` alone: that property is a Bool, so every caller that
    /// branched on it collapsed unknown into "no session" by construction.
    static func affordance(_ row: BoardRow) -> SessionAffordance {
        if row.hasKnownSession { return .open }
        return row.knownSessionIds == nil ? .unknown : .start
    }

    // MARK: - The band's done toggle

    /// What a band's done toggle says and which way it points — as ONE value, read off
    /// the BAND.
    ///
    /// The band is the only thing that knows: `hiddenDone` is how many rows it is
    /// actually suppressing, computed in the same pass that built the rows. The view
    /// used to phrase this from the expanded/folded SET instead, which was harmless
    /// while showing was the default and is not any more: with folding the default,
    /// every band would offer `show done` — including the ones with nothing done to
    /// show, i.e. a control that promises rows that do not exist. Same defect shape as
    /// `affordance` vs `hasKnownSession`: a label phrased from state the label's own
    /// subject can contradict.
    struct DoneToggle: Equatable {
        /// True while the band is suppressing rows, so the toggle offers to SHOW them.
        let folding: Bool
        /// The word (and the VoiceOver label): `show done (N)` while folding N rows,
        /// `hide done` otherwise. A band with no done rows at all reads `hide done` —
        /// tapping it is a no-op either way, and it is the phrase that band has always
        /// shown, so the flip introduces no new wording where there is nothing to fold.
        let word: String

        /// Closed eye hides, open eye shows — the glyph the heading falls back to when
        /// Dynamic Type takes the word away.
        var glyph: String { folding ? "eye" : "eye.slash" }
    }

    static func doneToggle(_ band: BoardBand) -> DoneToggle {
        band.hiddenDone > 0
            ? DoneToggle(folding: true, word: "show done (\(band.hiddenDone))")
            : DoneToggle(folding: false, word: "hide done")
    }

    // MARK: - "This row wants a human" (the red row)

    /// The desktop's rule, verbatim (`web/src/utils/session-status.ts`
    /// `taskNeedsAction`): phase AGENT_COMPLETE and not done. Both surfaces have to
    /// agree about what red means, so this is a port and not a reinterpretation.
    ///
    /// It covers more than "the agent finished": a session error drives the phase to
    /// AGENT_COMPLETE, and so does a permission prompt or a question waiting for an
    /// answer. All three are the same thing to the person scrolling — work stopped and
    /// it is your turn.
    ///
    /// It lives HERE, next to `state`, rather than inside the row view, for the reason
    /// every other rule on this screen does: it now decides a row's whole SURFACE
    /// (`BoardRowSurface`, applied by `TaskBoardList`) as well as the row's own ink, and
    /// two readers of one rule is exactly the shape that drifts into two rules. It takes
    /// the optional task the row carries, so a session-only row (no task in the
    /// projection) answers `false` rather than crashing or guessing — there is no phase
    /// to read, and inventing one would paint a row red on no evidence.
    static func needsHuman(_ task: WalnutTask?) -> Bool {
        guard let task else { return false }
        if task.isDone || task.phase == "COMPLETE" { return false }
        return task.phase == "AGENT_COMPLETE"
    }

    /// Compact age ("2m", "1h", "3d") for the row's second line. A row shows
    /// several of these, so the long relative form ("3 days ago") costs a line
    /// wrap on a two-line title. Pure so the tests don't need a clock.
    static func shortAge(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    // MARK: - Search

    /// Case-insensitive match over everything the row SHOWS (title, project) plus
    /// the session's host — the two things a person searches a board for.
    static func matches(_ row: BoardRow, query: String) -> Bool {
        guard !query.isEmpty else { return true }
        if row.title.localizedCaseInsensitiveContains(query) { return true }
        if row.project.localizedCaseInsensitiveContains(query) { return true }
        if let host = row.session?.host, host.localizedCaseInsensitiveContains(query) { return true }
        return false
    }

    // MARK: - Date filter ("Now")

    /// The desktop's "Now" rule, ported (`TodoPanel.matchesDateFilter` case
    /// `'now'` → `isDeferredByStart`): a task is hidden only when its START date
    /// says the work begins later. A due date is a DEADLINE — it marks a row
    /// overdue, it never hides one, because the day you most need to see a task
    /// is the day it was due.
    ///
    /// A done row is exempt. The desktop applies the same exemption
    /// (`t.status !== 'done' && !matchesDateFilter(…)`), and on this board it
    /// matters more: hiding completions is what the band's own `hide done` is
    /// for, and a date filter that quietly did it too would make that toggle
    /// look broken.
    ///
    /// One thing the desktop does that this cannot: inherit a parent's
    /// `start_date` when the task has none. The mobile projection carries no
    /// `parent_task_id`, so there is no chain to walk — a subtask with no start
    /// date of its own reads as actionable now. That is the honest answer from
    /// the data this surface has, not an approximation of the other one.
    static func isDeferred(_ row: BoardRow, filter: BoardDateFilter, now: Date) -> Bool {
        guard filter == .now, let task = row.task, !task.isDone else { return false }
        guard let start = task.startDateValue else { return false }
        return start > now
    }

    /// Everything a band checks before it keeps a row: the query, then the date
    /// filter. Both callers go through this so a row can never be admitted by one
    /// grouping and rejected by the other.
    static func admits(
        _ row: BoardRow, query: String, dateFilter: BoardDateFilter, now: Date
    ) -> Bool {
        matches(row, query: query) && !isDeferred(row, filter: dateFilter, now: now)
    }

    // MARK: - Band assembly

    /// Rows of one tier, in the ORDER THE SERVER KEEPS THEM.
    ///
    /// This is what makes "a new task lands at the foot of its band" true rather
    /// than aspirational: `pin_order` is max+1 for a new pin, and the tier split
    /// endpoint returns each bucket already in pin order — so following that
    /// array is following the server's placement. Ids the split hasn't caught up
    /// with yet (an optimistic local pin) are appended, which is also the foot.
    static func orderedIds(splitOrder: [String], extras: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for id in splitOrder where !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        for id in extras where !seen.contains(id) {
            seen.insert(id)
            out.append(id)
        }
        return out
    }

    /// The whole board: every PINNED row, in bands.
    ///
    /// `tasks` is the full projection because that is where the rows' CONTENT lives,
    /// not because every task gets one — the walk below reads each task once to ask
    /// `boardTier` whether it is on the board, and builds nothing for the ones that
    /// are not. If you are adding work here, that is the invariant to preserve: the
    /// cost of an idle pass scales with the PINNED set, not with the store.
    ///
    /// - Parameters:
    ///   - tierOf: taskId → tier id (TasksStore.taskTiers).
    ///   - tierOrder: tier id → ordered task ids (the split's own arrays).
    ///   - grouping: tier bands (the board's own shape) or project bands (the
    ///     desktop's). Same rows either way — only the headings change.
    ///   - folders: the project→folder hierarchy, used ONLY by project grouping. Empty
    ///     (the default, and what a failed `/tasks/groups` leaves behind) produces the
    ///     flat project bands this board drew before folders existed.
    ///   - dateFilter: "Now" hides work whose start date hasn't arrived.
    ///   - knownSessionIds: taskId → the task's own `session_ids`, for the tasks whose
    ///     detail the phone has read (`TasksStore.sessionIdsByTask`). A MISSING key is
    ///     "never asked", which is not the same as "no sessions" — see
    ///     `BoardRow.knownSessionIds`. Empty (the default) is the state a cold board
    ///     starts in and every row behaves exactly as it did before this existed.
    ///   - shownDoneTiers: the bands that are showing their done rows. Done FOLDS BY
    ///     DEFAULT (the empty set = every band folded), so this is the EXCEPTION set:
    ///     the bands the reader explicitly expanded with `show done (N)`.
    ///
    ///     The default is the flip this parameter's name records. It used to be
    ///     `hiddenDoneTiers`, an opt-OUT set, so the board counted and drew every
    ///     completed pin until you folded each band by hand — measured on the real
    ///     store: `Focus 75` over 16 open rows, `All 270` over 91, with 179 of the
    ///     270 finished. A working set's question is what is still open, so that is
    ///     what the band, its heading count and its chip now answer; a completed row
    ///     is memory, one tap away and never deleted.
    ///
    ///     What did NOT change: inside a band that IS showing its done rows, a
    ///     completed task stays EXACTLY where it was, struck through, because the
    ///     position is the memory of where the work happened.
    ///   - scope: the TIER the reader has narrowed to (a rail chip), or nil for the
    ///     whole board. Applied at CONSTRUCTION time — see `assemble`.
    ///   - now: injected so the date filter is testable without a clock.
    static func bands(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        tierOf: [String: String],
        tierOrder: [String: [String]],
        customTiers: [FocusTierInfo],
        query: String = "",
        grouping: BoardGrouping = .tier,
        dateFilter: BoardDateFilter = .all,
        shownDoneTiers: Set<String> = [],
        folders: BoardFolderIndex = .empty,
        knownSessionIds: [String: [String]] = [:],
        scope: String? = nil,
        now: Date = Date()
    ) -> [BoardBand] {
        assemble(
            tasks: tasks, sessions: sessions, tierOf: tierOf, tierOrder: tierOrder,
            customTiers: customTiers, query: query, grouping: grouping,
            dateFilter: dateFilter, shownDoneTiers: shownDoneTiers, folders: folders,
            knownSessionIds: knownSessionIds, scope: scope, now: now
        ).bands
    }

    /// The board's whole answer: the tier rail, the scope's bands, and the scope that was
    /// honoured — from ONE walk over the projection (see `BoardAssembly`).
    ///
    /// # The tier scope narrows at CONSTRUCTION time, and that is the whole fix
    ///
    /// `tierById` below is the ONE answer to "which tier owns this row", and it exists
    /// before the grouping branch — so the scope filter belongs exactly there, where both
    /// builders inherit it and cannot disagree. Post-filtering ASSEMBLED project bands
    /// (what the shipped board did, through `filtered`) is wrong twice over: under `By
    /// project` there is no band whose id is a tier, so the filter matched nothing and fell
    /// back to the whole board (the reported defect — `By project` inside Focus showed
    /// every tier's projects), and even where it matched, a band's COUNT was computed over
    /// the whole board while its rows were narrowed, i.e. a heading that disagrees with the
    /// rows under it.
    static func assemble(
        tasks: [WalnutTask],
        sessions: [WalnutSession],
        tierOf: [String: String],
        tierOrder: [String: [String]],
        customTiers: [FocusTierInfo],
        query: String = "",
        grouping: BoardGrouping = .tier,
        dateFilter: BoardDateFilter = .all,
        shownDoneTiers: Set<String> = [],
        folders: BoardFolderIndex = .empty,
        knownSessionIds: [String: [String]] = [:],
        scope: String? = nil,
        now: Date = Date()
    ) -> BoardAssembly {
        let sessionOf = latestSessionByTask(sessions)
        let tiers: [(id: String, label: String)] =
            TasksStore.builtinTiers.map { ($0.id, $0.label) }
            + customTiers.map { ($0.id, $0.label) }
        let knownTiers = Set(tiers.map(\.id))

        // What the SPLIT says, from both of its halves at once. The order arrays
        // carry their tier as the dictionary key, so they can answer the question
        // the map answers whenever the map has not caught up — and the map wins on
        // (impossible) disagreement, because it is the half a local pin writes
        // first. Dropping an id one half names and the other does not is how a row
        // goes missing, which is the whole reason both are read.
        var splitTierOf = tierOf
        for (tier, ids) in tierOrder {
            for id in ids where splitTierOf[id] == nil { splitTierOf[id] = tier }
        }

        // ONE walk over the projection, and it builds NOTHING for a task that is
        // not on the board.
        //
        // That is the fix, stated as cost: the retired tail band constructed a
        // `BoardRow` (a whole `WalnutTask` plus an optional `WalnutSession`) for
        // every task no tier claimed, computed a sort key for each — which parses
        // an ISO date — and then decorate-sorted ~2,800 of them, on EVERY body
        // pass, so that a heading could print a number. Membership is now a
        // dictionary lookup per task and the rows that get built are the ones that
        // get drawn.
        var rowById: [String: BoardRow] = [:]
        var tierById: [String: String] = [:]
        // Fallback order: the projection's own (already sorted) order, then the
        // session-only rows. Ids the split has named come FIRST inside each band
        // (that array is `pin_order`), so this only decides where the rest land.
        var order: [String] = []
        // Every id the projection carries, so a session can tell "the phone does
        // not have this task" from "the phone has it and it is not pinned".
        //
        // Built EAGERLY, unlike the version this replaces. That one deferred it
        // because the common shape never reached the check; with the board pinned
        // only, most sessions belong to a task that is present and unpinned, so the
        // deferral bought nothing and cost a branch nobody could reason about.
        var projectionIds = Set<String>()
        let capacity = splitTierOf.count + 8
        rowById.reserveCapacity(capacity)
        tierById.reserveCapacity(capacity)
        order.reserveCapacity(capacity)
        projectionIds.reserveCapacity(tasks.count)
        for task in tasks {
            projectionIds.insert(task.id)
            guard let tier = boardTier(
                pinned: task.pinned, splitTier: splitTierOf[task.id], knownTiers: knownTiers
            ) else { continue }
            // `knownSessionIds[task.id]` stays nil for a task nobody has asked about,
            // which is the row's "unknown" state and NOT "no sessions" (see BoardRow).
            rowById[task.id] = BoardRow(
                task: task, session: sessionOf[task.id],
                knownSessionIds: knownSessionIds[task.id]
            )
            tierById[task.id] = tier
            order.append(task.id)
        }

        // A session whose owning task never reached the slim projection is still
        // real work someone started, and it keeps a row — but only when the SESSION
        // itself reports pinned, because on a pinned-only board that flag is the
        // only evidence available that the missing task belongs here. It files into
        // the tier the session reports (`focus_tier`), which is the same value the
        // split would have given for that task.
        //
        // A session that owns no task at all has nothing to pin and therefore no
        // band; it used to ride the tail, and 96 of them are a measured part of the
        // "All 3,175" this change removes.
        for session in sessions {
            guard session.isPinned else { continue }
            guard let taskId = session.taskId, !taskId.isEmpty else { continue }
            // One row per task: only the LATEST session speaks for its owner.
            guard sessionOf[taskId]?.id == session.id else { continue }
            guard rowById[taskId] == nil else { continue }
            // The projection HAS the task and the walk above declined it, so the
            // task is known-unpinned. Its own flag outranks a session's memory.
            guard !projectionIds.contains(taskId) else { continue }
            let tier = boardTier(
                pinned: true, splitTier: splitTierOf[taskId] ?? session.focusTier,
                knownTiers: knownTiers
            ) ?? defaultTierId
            rowById[taskId] = BoardRow(
                task: nil, session: session, knownSessionIds: knownSessionIds[taskId]
            )
            tierById[taskId] = tier
            order.append(taskId)
        }

        // THE RAIL, first, and WHICH tiers it holds is the same question under every
        // grouping: the TIER bands over the WHOLE board. Built here rather than from the
        // rendered bands, which is what makes "the rail is the tier rail" true by
        // construction — feeding it the rendered bands is what turned it into a list of
        // projects and folders under `By project`.
        let railBands = tierBands(
            rowById: rowById, tierById: tierById, order: order,
            tiers: tiers, tierOrder: tierOrder, query: query,
            dateFilter: dateFilter, shownDoneTiers: shownDoneTiers, now: now
        )

        // …and each chip's COUNT is what the board SHOWS for that tier, which is why it is
        // recomputed per row here instead of read off `railBands`.
        //
        // The done fold is keyed by BAND id, and under `By project` the bands are
        // `proj:` / `folder:` — so a reader who taps `show done (3)` on a project heading
        // expands rows that no TIER band knows about. Reading the count off the tier band
        // would then leave the chip saying `Focus 1` over a board drawing 4 rows, which is
        // the bar-disagrees-with-the-board defect this screen has shipped before. The
        // predicate below is the same fold rule the rendering builder applies (`foldKey`),
        // so the two cannot drift.
        //
        // Note what this does NOT reintroduce: the count is still per TIER, still after the
        // date filter, and still independent of which projects the tier happens to hold —
        // so the tier counts do not move when the grouping changes unless the reader's own
        // fold decisions do.
        var countByTier: [String: Int] = [:]
        countByTier.reserveCapacity(tiers.count)
        for id in order {
            guard let tier = tierById[id], let row = rowById[id] else { continue }
            guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
            if row.isDone,
               !shownDoneTiers.contains(
                   foldKey(row, tier: tier, grouping: grouping, folders: folders)
               ) { continue }
            countByTier[tier, default: 0] += 1
        }
        var rail = [BandChip(
            bandId: nil, label: allChipLabel,
            count: countByTier.values.reduce(0, +)
        )]
        rail.append(contentsOf: railBands.map {
            BandChip(bandId: $0.bandId, label: $0.label, count: countByTier[$0.bandId] ?? 0)
        })

        // A scope is honoured only when the rail HAS a chip for it, which is the same
        // rule `filtered` encoded one step later: a tier that is gone or has emptied under
        // the reader falls back to the whole board, and the lit chip falls back to `All`,
        // so the bar can never disagree with the rows.
        let honoured = scope.flatMap { id in
            railBands.contains(where: { $0.bandId == id }) ? id : nil
        }

        // Nothing to narrow and nothing to re-head: the rail bands ARE the board.
        if honoured == nil && grouping == .tier {
            return BoardAssembly(rail: rail, bands: railBands, scope: nil)
        }

        // The scope filter, at construction, over the ONE membership map.
        var scopedRowById = rowById
        var scopedTierById = tierById
        var scopedOrder = order
        if let honoured {
            scopedOrder = order.filter { tierById[$0] == honoured }
            let keep = Set(scopedOrder)
            scopedRowById = rowById.filter { keep.contains($0.key) }
            scopedTierById = tierById.filter { keep.contains($0.key) }
        }

        let bands: [BoardBand]
        if grouping == .project {
            bands = projectBands(
                rows: scopedOrder.compactMap { scopedRowById[$0] }, query: query,
                dateFilter: dateFilter, shownDoneTiers: shownDoneTiers,
                folders: folders,
                // What the ONE remaining heading is called when there is no project worth
                // naming: the tier you are in, or `All`. See `projectBands`.
                soleHeadingLabel: honoured.flatMap { id in
                    tiers.first(where: { $0.id == id })?.label
                } ?? allChipLabel,
                now: now
            )
        } else {
            bands = tierBands(
                rowById: scopedRowById, tierById: scopedTierById, order: scopedOrder,
                tiers: tiers, tierOrder: tierOrder, query: query,
                dateFilter: dateFilter, shownDoneTiers: shownDoneTiers, now: now
            )
        }
        return BoardAssembly(rail: rail, bands: bands, scope: honoured)
    }

    /// Which band's done fold decides whether a row is DRAWN, under one grouping.
    ///
    /// One function because two readers need the same answer and a second copy of this rule
    /// would be a chip count that disagrees with the rows under it: the rendering builders
    /// apply it structurally (a band folds its own done rows), and the rail applies it per
    /// row to count what the board shows for a tier.
    static func foldKey(
        _ row: BoardRow, tier: String, grouping: BoardGrouping, folders: BoardFolderIndex
    ) -> String {
        guard grouping == .project else { return tier }
        let folderId = folders.folderOf[row.id] ?? ""
        return folderId.isEmpty
            ? projectBandPrefix + row.project
            : folderBandPrefix + folderId
    }

    /// The board grouped by pin tier — its native shape.
    ///
    /// `tierById` is the ONE answer to "which band owns this row", so a row can
    /// never be drawn twice: a split bucket that still names a task some other tier
    /// now claims is filtered out of that bucket, and the task appears in its own
    /// band's fallback order instead. Membership and rendering read the same map,
    /// which is what the retired tail band's `claimed` set existed to reconcile.
    static func tierBands(
        rowById: [String: BoardRow],
        tierById: [String: String],
        order: [String],
        tiers: [(id: String, label: String)],
        tierOrder: [String: [String]],
        query: String,
        dateFilter: BoardDateFilter,
        shownDoneTiers: Set<String>,
        now: Date
    ) -> [BoardBand] {
        var extrasByTier: [String: [String]] = [:]
        for id in order {
            guard let tier = tierById[id] else { continue }
            extrasByTier[tier, default: []].append(id)
        }

        var bands: [BoardBand] = []
        for tier in tiers {
            // The split's own order for this band, minus ids this band no longer
            // owns (moved tier, or gone from the projection entirely).
            let splitOrder = (tierOrder[tier.id] ?? []).filter { tierById[$0] == tier.id }
            let ids = orderedIds(splitOrder: splitOrder, extras: extrasByTier[tier.id] ?? [])
            // ONE pass that builds, search-filters and counts. Three chained
            // `filter`/`count` calls over the same array is three walks and two
            // throwaway arrays per band per body pass; a band is rebuilt on every
            // keystroke, so the pass count is what the budget notices.
            // Folded unless this band was explicitly expanded — the default, not the
            // exception (see `shownDoneTiers`).
            let hidingDone = !shownDoneTiers.contains(tier.id)
            var rows: [BoardRow] = []
            rows.reserveCapacity(ids.count)
            var doneCount = 0
            for id in ids {
                guard let row = rowById[id] else { continue }
                guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
                if row.isDone {
                    doneCount += 1
                    if hidingDone { continue }
                }
                rows.append(row)
            }
            guard !rows.isEmpty || doneCount > 0 else { continue }
            bands.append(BoardBand(
                bandId: tier.id, label: tier.label,
                rows: rows,
                hiddenDone: hidingDone ? doneCount : 0,
                createSeed: NewTaskSeed.tier(tier.id)
            ))
        }
        return bands
    }

    // MARK: - Project grouping (the desktop's "By project")

    /// Band id prefix for a project band. Namespaced because the two groupings
    /// share the `hide done` set and the scroll-anchor space, and a project
    /// literally called "focus" would otherwise collide with the Focus tier.
    static let projectBandPrefix = "proj:"

    /// Band id prefix for a FOLDER band. Same reasoning as `projectBandPrefix`, one
    /// level down: a folder's id shares the `hide done` set, the chip space and the
    /// scroll-anchor space with every tier and project on the board.
    static let folderBandPrefix = "folder:"

    /// The heading the rows of a project that are in NO folder are drawn under.
    ///
    /// It is the PROJECT's own heading, deliberately, and not a separate "No folder"
    /// row: that is what the desktop console does (loose tasks sit directly under the
    /// project header, folder clusters follow), and inventing an extra heading would
    /// add a level to the tree that the data does not have.
    ///
    /// # The one place this board's shape is worth arguing about
    ///
    /// The hierarchy is PROJECT → FOLDER → task, in that direction, and every layer of
    /// the product agrees: `task_groups.project` makes a folder belong to exactly one
    /// project (moving a task to another project CLEARS its folder server-side), the
    /// console renders `todo-group-project-header` (solid icon, "project" tag) as the
    /// outer row with folder headers indented inside it, and the field data is 60
    /// folders across ~14 projects with no folder owning more than one project. Drawing
    /// folders on the OUTSIDE would therefore shatter each project into as many
    /// sections as it has folders — "By project" would stop grouping by project — so
    /// the phone mirrors the console instead: projects outside, folders inside.
    ///
    /// # A heading that names something the whole list already is, is not drawn
    ///
    /// `soleHeadingLabel` is what the one remaining heading says when the rows being
    /// grouped span FEWER THAN TWO projects: with one project there is nothing to group
    /// by, and repeating that project's name over the whole list is noise (the desktop
    /// console gates its project headers on the same `>= 2` rule). The band itself
    /// survives — it is what carries `show done (N)`, the visible count and the create
    /// ring — so what changes is only the WORD on it: the tier you are scoped to, or
    /// `All`. Its `createSeed` still files into the project its rows are in.
    ///
    /// Which is why the create row does NOT print this heading: the ring under a band
    /// relabelled "Focus" writes into `marina`, so its words come from the seed
    /// (`TaskBoardList.createDestination`). A heading names the group; a create row makes a
    /// promise about a write, and this label is not a place you can write to (least of all
    /// `All`).
    ///
    /// The suppression is deliberately narrowed to the FLAT case (one project AND no
    /// folder band on screen). With a folder on screen the project heading is the root
    /// that the folder's indent refers to, and dropping it would leave an indented folder
    /// heading under a name the screen never said — the exact failure `leadsProject` and
    /// `leadFolders` exist to prevent.
    static func projectBands(
        rows source: [BoardRow],
        query: String,
        dateFilter: BoardDateFilter,
        shownDoneTiers: Set<String>,
        folders: BoardFolderIndex = .empty,
        soleHeadingLabel: String = allChipLabel,
        now: Date
    ) -> [BoardBand] {
        // Decorate-sort-undecorate: a `BoardRow` payload makes every swap copy two
        // whole structs (a `WalnutTask` plus an optional `WalnutSession`), so the
        // buckets hold INDICES into one flat `rows` array — the per-project sort
        // moves Ints and Dates, and each row is copied exactly once, when its band
        // is built. Same shape `WalnutTask.openSorted` uses for the task list.
        var rows: [BoardRow] = []
        rows.reserveCapacity(source.count)
        // project name → folder id ("" = the project's loose rows) → slots.
        //
        // TWO levels of dictionary and not a composite key, because the ORDER is
        // computed per level: projects sort one way (Inbox, then A→Z), the folders
        // inside a project another (loose first, then label A→Z), and a flat map keyed
        // by a joined string would have to take the composite apart again to sort it.
        var buckets: [String: [String: [(index: Int, live: Bool, done: Bool, at: Date)]]] = [:]

        for row in source {
            guard admits(row, query: query, dateFilter: dateFilter, now: now) else { continue }
            let at = row.session?.lastActiveValue ?? row.task?.updatedAtValue ?? .distantPast
            // `row.id` is the OWNING TASK id whenever one is resolvable (see
            // `BoardRow.owningTaskId`), which is exactly the key the server's
            // `member_ids` are expressed in — so a session-only row whose task is
            // missing from the projection still lands in its folder.
            let folderId = folders.folderOf[row.id] ?? ""
            buckets[row.project, default: [:]][folderId, default: []].append((
                rows.count, row.session?.statusKind.isAlive == true, row.isDone, at
            ))
            rows.append(row)
        }

        // Inbox ("") leads, then projects A→Z — the same order the project
        // sections elsewhere in this app use, so switching grouping doesn't also
        // reshuffle into an unfamiliar sequence.
        let names = buckets.keys.sorted { a, b in
            if a.isEmpty != b.isEmpty { return a.isEmpty }
            return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
        }

        // ONE project across every row AND no folder to indent under it: the project
        // heading has nothing left to say, so it is replaced by `soleHeadingLabel`.
        // `folders.folderOf` is consulted through the buckets that actually got rows, so a
        // folder the server lists but this board has no rows for does not keep a heading
        // alive that nothing is nested under.
        let hasFolderBand = buckets.values.contains { $0.keys.contains { !$0.isEmpty } }
        let noProjectWorthNaming = names.count < 2 && !hasFolderBand

        var bands: [BoardBand] = []
        for name in names {
            let projectBandId = projectBandPrefix + name
            let projectLabel = name.isEmpty ? NewTaskSeed.inboxHeader : name
            let inProject = buckets[name] ?? [:]
            // The project's LOOSE rows first (id `proj:<name>`, the shipped band id and
            // the shipped accessibility ids), then its folders as a TREE in pre-order:
            // a folder, then its subfolders, so a nested folder's rows are rendered
            // INSIDE the parent they belong to instead of after it as a sibling.
            let folderIds = folderOrder(
                withRows: inProject.keys.filter { !$0.isEmpty }, folders: folders
            )
            for folderId in [""] + folderIds {
                let isFolder = !folderId.isEmpty
                let bandId = isFolder ? folderBandPrefix + folderId : projectBandId
                let label: String
                if isFolder {
                    label = folders.labelOf[folderId] ?? folderId
                } else {
                    label = noProjectWorthNaming ? soleHeadingLabel : projectLabel
                }
                // Folded unless expanded, exactly as a tier band is: the default lives
                // in ONE place per builder and both builders state the same rule.
                let hidingDone = !shownDoneTiers.contains(bandId)
                let sorted = (inProject[folderId] ?? []).sorted { a, b in
                    if a.done != b.done { return !a.done }
                    if a.live != b.live { return a.live }
                    return a.at > b.at
                }
                let doneCount = sorted.count { $0.done }
                let bandRows = (hidingDone ? sorted.filter { !$0.done } : sorted).map { rows[$0.index] }
                // Same rule as everywhere else on this board: a band with nothing to
                // show is not rendered. That covers the project with no loose rows (its
                // heading then rides the first folder band, see `relead`) and the empty
                // folder the server lists but the pinned board has no rows for.
                //
                // One consequence, stated because it is a deliberate trade: a project
                // whose every pinned row is filed in a folder has no loose band and
                // therefore no create ring. That is the board's existing rule and not a
                // new hole — an empty TIER has no heading and no ring either — and the
                // ring comes back the moment the project has one loose pinned row.
                guard !bandRows.isEmpty || doneCount > 0 else { continue }
                bands.append(BoardBand(
                    bandId: bandId, label: label,
                    rows: bandRows,
                    hiddenDone: hidingDone ? doneCount : 0,
                    // A project heading's `+` files into THAT project and leaves the
                    // pin unspecified — the same call `NewTaskSeed.project` already
                    // makes for the project sections on the other filters.
                    //
                    // A FOLDER band has NO create affordance, and that is the honest
                    // answer rather than a missing feature: v1 exposes no folder write
                    // (and every folder write is 501 on a replica), so a ring here
                    // could only file the task into the project — landing it OUTSIDE
                    // the folder whose heading was tapped. A control that quietly does
                    // something else is the `focus_tier: "proj:marina"` mistake again.
                    // `projectLabel`, never the heading's `label`: a heading whose name was
                    // suppressed as redundant still files into the PROJECT its rows are
                    // in, and filing into a tier name ("Focus") would create a project
                    // called Focus. The row's WORDS follow this seed rather than the
                    // heading (`TaskBoardList.createDestination`), so the two cannot drift.
                    createSeed: isFolder ? nil : NewTaskSeed.project(projectLabel),
                    nest: isFolder ? BoardBandNest(
                        folderId: folderId,
                        projectBandId: projectBandId,
                        projectLabel: projectLabel,
                        // Filled in by `relead` below, in one place.
                        leadsProject: false,
                        depth: folders.depth(of: folderId),
                        ancestors: folderSteps(folders.ancestors(of: folderId), folders: folders)
                    ) : nil
                ))
            }
        }
        return relead(bands)
    }

    /// One project's folders, as a TREE walked in pre-order: a folder, then its
    /// subfolders, then the next sibling.
    ///
    /// # What this fixes
    ///
    /// The board used to sort the folders that HAVE ROWS by label and render them as one
    /// flat list, so a subfolder appeared as a sibling of its own parent ("你现在完完全是同
    /// 一个 level"). The data has always carried `parent_id`; only the rendering was flat.
    ///
    /// # Two rules, and both exist to keep rows on screen
    ///
    ///  - The walk covers every folder that has rows PLUS their ancestors, even ancestors
    ///    with no rows of their own. An ancestor with no rows contributes no band (the
    ///    empty-band rule is unchanged), but it has to take part in the ORDER, or its
    ///    children would be ordered against a parent the walk never visited.
    ///  - Anything the tree cannot place is placed at the TOP LEVEL rather than dropped: a
    ///    parent outside this project, or one `BoardFolderIndex.build` already refused
    ///    (missing, self, cyclic), leaves that folder a root. A folder that is not in the
    ///    returned order is a folder whose rows are not on the board, which is the one
    ///    outcome this function must never have.
    ///
    /// Siblings sort by label A→Z with the id as the tie-break, so two folders sharing a
    /// name still order deterministically — an unstable order would make rows jump between
    /// two identical-looking headings on every rebuild.
    static func folderOrder(
        withRows ids: [String], folders: BoardFolderIndex
    ) -> [String] {
        guard !ids.isEmpty else { return [] }
        // Every folder that takes part: the ones with rows, and their ancestors.
        var involved = Set(ids)
        for id in ids {
            for ancestor in folders.ancestors(of: id) { involved.insert(ancestor) }
        }
        // parent → children, with "" standing for the top level of this project.
        var childrenOf: [String: [String]] = [:]
        for id in involved {
            let parent = folders.parentOf[id]
            let key = (parent != nil && involved.contains(parent!)) ? parent! : ""
            childrenOf[key, default: []].append(id)
        }
        let label = { (id: String) in folders.labelOf[id] ?? id }
        for (key, children) in childrenOf {
            childrenOf[key] = children.sorted { a, b in
                let left = label(a)
                let right = label(b)
                if left != right {
                    return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
                }
                return a < b
            }
        }
        // Pre-order walk. `visited` is belt AND braces: `parentOf` is acyclic by
        // construction, and a hierarchy walk that could loop is not worth the risk.
        var order: [String] = []
        var visited = Set<String>()
        func walk(_ id: String) {
            guard !visited.contains(id) else { return }
            visited.insert(id)
            order.append(id)
            for child in childrenOf[id] ?? [] { walk(child) }
        }
        for root in childrenOf[""] ?? [] { walk(root) }
        // A folder the walk somehow missed still gets its band, at the top level. This is
        // the "an orphan's rows are never invisible" guarantee, stated as code rather than
        // as a comment about the code above.
        for id in ids.sorted() where !visited.contains(id) {
            visited.insert(id)
            order.append(id)
        }
        return order
    }

    /// Folder ids → the steps a heading can draw (label + indent depth).
    static func folderSteps(_ ids: [String], folders: BoardFolderIndex) -> [BoardFolderStep] {
        ids.map { id in
            BoardFolderStep(
                folderId: id, label: folders.labelOf[id] ?? id, depth: folders.depth(of: id)
            )
        }
    }

    /// Decide which band draws each project's heading, and which ANCESTOR FOLDER headings
    /// it has to draw with it.
    ///
    /// A folder band leads its project when nothing earlier in the array has already
    /// drawn that heading — i.e. when the project's loose band was dropped for being
    /// empty, or when a chip selection left only folder bands on screen. Run over the
    /// BUILT array (and again after `filtered`) so the rule has exactly one definition:
    /// the alternative is the builder deciding it and the chip filter silently
    /// invalidating that decision, which shows up as a folder heading floating with no
    /// project above it.
    ///
    /// Ancestor FOLDERS are the same rule one level down, and it earns its place the moment
    /// folders nest: a parent folder that holds no rows of its own gets no band, so without
    /// this its child would draw indented under nothing — and a chip that selects one
    /// subfolder would show it indented with neither its parent nor its project named.
    static func relead(_ bands: [BoardBand]) -> [BoardBand] {
        var drawn = Set<String>()
        return bands.map { band in
            var band = band
            guard var nest = band.nest else {
                // A project (or tier) band IS its own heading.
                drawn.insert(band.bandId)
                return band
            }
            nest.leadsProject = !drawn.contains(nest.projectBandId)
            drawn.insert(nest.projectBandId)
            nest.leadFolders = nest.ancestors.filter { !drawn.contains($0.folderId) }
            for step in nest.ancestors { drawn.insert(step.folderId) }
            drawn.insert(nest.folderId)
            band.nest = nest
            return band
        }
    }

    // The trailing "Everything else" band is GONE (this round), and with it
    // `unfiledRows`, `Tail`, `activeTierId` and `activeLabel`.
    //
    // What it was: the COMPLEMENT of every tier, i.e. every task no tier claimed
    // plus every session with no owning task. On the real store that was 2,903 of
    // 3,161 rows, and building it meant a `BoardRow` per unpinned task, an ISO date
    // parse per row for the sort key, and a decorate-sort over ~2,800 entries — on
    // every body pass, including the ones a scroll publishes. The `All` chip counted
    // that sum, which is where "All 3,175" came from.
    //
    // Why it is not replaced by a PAGED version: the user's question was not "page
    // it", it was "已经有 pin 了,为什么还会有 all task" — the board IS the pinned
    // working set, so the complement is not a band with a paging problem, it is a
    // band with no reason to exist. Unpinned work is reachable by SEARCH: a server
    // query over the whole store (`GlobalSearchSection`) plus the local open-task
    // sections `TasksView` appends while a query is live, neither of which walks the
    // store on an idle body pass.
    //
    // The one thing that had to survive is in `boardTier`: a PINNED task cannot be
    // missing from this board, whichever half of the split knows about the pin.


    // MARK: - Band chips (the floating bar) — a VIEW over bands, never a query
    //
    // The chips ARE bands: one chip per band handed in, in band order, plus a
    // leading `All`. That is deliberate to the point of being the rule this
    // section exists to state: chip selection must not open a second way to
    // decide what a band contains.
    //
    // WHICH bands moved (this round) and it is the user's complaint: the RAIL is always
    // built from the TIER bands over the whole board (`assemble`), never from the bands
    // being rendered. Feeding it the rendered bands is what made `By project` replace the
    // tier rail with `proj:` / `folder:` chips — the rail became a list of folders, the
    // tier selection had nowhere to live, and reaching a folder took several taps. The
    // rule above is unchanged: a chip still carries a count it read OFF a band, and that
    // band is still assembled once. It is just always a tier band now.
    //
    // The disappearing-task bug (see `boardTier`) came from two code paths
    // disagreeing about membership, and a chip row is exactly the shape that
    // invites a third one ("just re-query the tier for this chip"). So a chip
    // carries a band ID and a count it read OFF the band, and filtering is a
    // `filter` over the very array the rows are rendered from. One assembly, one
    // answer, and a chip can never show a count the band below it disagrees with.
    //
    // Chips mirror what is RENDERED, so an empty tier has no chip for the same
    // reason it has no heading: there is nothing to select.

    /// One chip in the board's floating band bar.
    struct BandChip: Identifiable, Equatable {
        /// The band this chip selects, or nil for the `All` chip (whole board).
        let bandId: String?
        let label: String
        /// The band's own visible count (`All` carries their sum).
        let count: Int

        var id: String { bandId ?? "__all__" }
    }

    /// Label on the chip that clears the band filter.
    ///
    /// `All` means the whole PINNED BOARD, and its count is the sum of the bands'
    /// own visible counts — i.e. the number of rows this screen is showing. It used
    /// to include the tail band, so it read "All 3,175" over a working set of ~264:
    /// the chip was reporting the size of the task STORE. Nothing about the
    /// arithmetic here changed; what changed is that no band is the store any more.
    ///
    /// The arithmetic still has not changed, and that is what carries the invariant
    /// through the done-fold flip: `All` sums what the bands SHOW, so on a default
    /// board it is the open count (measured on the real store: 91, not 270) and it
    /// grows by exactly N the moment a band's `show done (N)` is tapped.
    static let allChipLabel = "All"

    static func chips(_ bands: [BoardBand]) -> [BandChip] {
        var chips = [BandChip(
            bandId: nil, label: allChipLabel,
            count: bands.reduce(0) { $0 + $1.count }
        )]
        chips.append(contentsOf: bands.map {
            BandChip(bandId: $0.bandId, label: $0.label, count: $0.count)
        })
        return chips
    }

    // `filtered` and `selectedChip` are GONE (this round), and their absence is the
    // change rather than a cleanup.
    //
    // What they were: a POST-FILTER over the assembled bands (`bands.filter { $0.bandId ==
    // selected }`, re-`relead`ed) plus the matching "which chip reads as lit". Both were
    // written when the rail was `chips(bands)`, so a selection was a BAND id and narrowing
    // was a view over the rendered array.
    //
    // Why that could not survive: under `By project` no band's id is a tier, so a Focus
    // selection matched nothing and the filter fell back to the WHOLE board — the reported
    // defect. And where it did match, the band's `count` had already been computed over
    // every tier's rows while the rows it kept were narrowed, i.e. a heading that disagrees
    // with the rows under it. Narrowing has to happen at CONSTRUCTION time; see `assemble`.
    //
    // What SURVIVES, in `assemble`: an unknown or emptied scope still shows the whole board
    // rather than nothing (a selected tier can disappear under the reader — its last row
    // completed, a query narrowed it away — and answering "no rows" there is the
    // disappearing-task failure mode one level up), and `BoardAssembly.scope` is what the
    // lit chip reads, so the bar can never disagree with the rows.

    /// Every row id the bands already render.
    ///
    /// Used to keep a search on the board from showing a task TWICE: the bands
    /// hold pinned work, the search hits below hold matching open tasks, and a
    /// pinned task that matched belongs to both sets. Two rows for one task on one
    /// screen is exactly the confusion this design removes.
    static func rowIds(_ bands: [BoardBand]) -> Set<String> {
        var ids = Set<String>()
        for band in bands {
            for row in band.rows { ids.insert(row.id) }
        }
        return ids
    }

    /// Every id a server search hit could legitimately be about, for the rows the
    /// board is already showing.
    ///
    /// `rowIds` answers "what is this row keyed by" and is what the local task
    /// sections dedup against. This answers the different question the server-hit
    /// dedup asks — "is this hit about something already on screen" — and it is a
    /// SUPERSET on purpose, because one row can be named three ways: the row's own
    /// key, the owning task id, and (for a session-only row) the session id the
    /// server answers a session hit with. Keying the row by the task id fixed the
    /// duplicate at its source (see `BoardRow.owningTaskId`); carrying all three here
    /// is what makes the dedup indifferent to which id a row happened to be keyed by,
    /// so the same defect cannot come back through a new row shape.
    static func searchDedupIds(_ bands: [BoardBand]) -> Set<String> {
        var ids = Set<String>()
        for band in bands {
            for row in band.rows {
                if !row.id.isEmpty { ids.insert(row.id) }
                if let owning = row.owningTaskId, !owning.isEmpty { ids.insert(owning) }
                if let sessionId = row.session?.id, !sessionId.isEmpty { ids.insert(sessionId) }
            }
        }
        return ids
    }

    // MARK: - Tier tokens (move tier from the row's long-press menu)

    /// One tier choice for a row.
    struct TierToken: Identifiable, Equatable {
        let tierId: String
        let label: String
        let selected: Bool
        /// The "Unpin" token — takes the task off the board entirely.
        let isUnpin: Bool
        var id: String { isUnpin ? "unpin" : tierId }
    }

    /// What a tapped token should do. Returned rather than performed so the rule
    /// is testable and the view stays a dumb caller.
    enum TierAction: Equatable {
        case setTier(String)
        case unpin
        /// The token that is already selected — spend no request on it.
        case noop
    }

    static func tokens(current: String?, choices: [(id: String, label: String)]) -> [TierToken] {
        var tokens = choices.map {
            TierToken(tierId: $0.id, label: $0.label, selected: $0.id == current, isUnpin: false)
        }
        tokens.append(TierToken(tierId: "", label: "Unpin", selected: false, isUnpin: true))
        return tokens
    }

    static func action(for token: TierToken, current: String?) -> TierAction {
        if token.isUnpin { return current == nil ? .noop : .unpin }
        if token.tierId == current { return .noop }
        return .setTier(token.tierId)
    }
}

// MARK: - The bands, memoized on their inputs
//
// `BoardModel.bands` is a pure function of a handful of values, and `TasksView.body`
// calls it once per pass — but a pass happens on every `@State` publish, every ≤4Hz
// SSE batch and every keystroke, and most of those passes change NOTHING the bands
// are built from. This makes a repeat pass over unchanged inputs a dictionary-style
// hit instead of a rebuild, which is the same discipline `TasksStore`'s slice cache
// already applies to `tasks(for:)`.
//
// It is a plain reference box and NOT `@Observable`, deliberately: the view writes to
// it during its own body evaluation, and an observable write there would invalidate
// the body that just performed it (the non-converging feedback `ChromeCollapseTracker`
// exists to avoid, one layer down).
//
// It is not a substitute for the pinned-only board — that is what made an idle pass
// cheap in the first place. It is what makes a pass that changes nothing cost nothing,
// which is the other half of the top-of-list hitch: the two chrome thresholds and the
// search drawer all publish inside the first ~57pt of travel.

/// Everything `BoardModel.bands` reads, as one comparable value.
///
/// `inputsGen` stands in for the three collections (tasks, sessions, the tier split):
/// `TasksStore.boardInputsGen` is a monotonic counter that changes whenever any of them
/// does, so the key compares three Ints instead of ~3,000 rows. Comparing the arrays
/// themselves would spend more than the rebuild it is trying to skip.
///
/// `nowBucket` is how the clock gets into a memo without freezing it: `bands` defaults
/// `now` to call time, and the `.now` date filter is the only input that depends on it,
/// so the bucket is a coarse (per-minute) clock ONLY under that filter and a constant
/// under `.all`. A start date that passes then shows up within the minute instead of
/// never, and an `.all` board never re-derives for the clock at all.
struct BoardBandsKey: Equatable {
    let inputsGen: UInt64
    let query: String
    let grouping: BoardGrouping
    let dateFilter: BoardDateFilter
    /// The TIER the rail has narrowed to (nil = the whole board).
    ///
    /// Part of the key because the scope now narrows the row set at CONSTRUCTION time: a
    /// chip tap changes which rows exist, so a key without it would leave the board
    /// showing the previous tier until some unrelated input happened to move the key.
    /// (When the scope was a post-filter over assembled bands it legitimately did not
    /// belong here — that is exactly what changed.)
    var scope: String? = nil
    /// The bands the reader expanded to show their done rows (see
    /// `bands(shownDoneTiers:)`). Part of the key because it changes which rows a band
    /// holds — which is also what makes an explicit expand survive every rebuild the
    /// store publishes underneath it.
    let shownDoneBands: Set<String>
    let nowBucket: Int
}

@MainActor
final class BoardBandsCache {
    private var key: BoardBandsKey?
    private var value: BoardAssembly = .empty

    /// The memo. `build` runs only when the key moved.
    ///
    /// It memoizes the WHOLE assembly (rail + bands + honoured scope) and not just the
    /// bands, because those three come from one population walk and are only consistent
    /// with each other if they are cached together: two entries keyed the same way could
    /// be refreshed at different passes, which is a rail whose counts describe a board that
    /// is no longer on screen.
    ///
    /// The caller must still read the OBSERVED store properties before calling this
    /// (`TasksView.boardAssembly` does), or a cache hit would skip the reads SwiftUI needs
    /// to register a dependency on and the board would stop updating.
    func assembly(
        for key: BoardBandsKey, build: () -> BoardAssembly
    ) -> BoardAssembly {
        if let current = self.key, current == key { return value }
        let built = build()
        self.key = key
        self.value = built
        return built
    }
}
