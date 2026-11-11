import Foundation

/// The code blocks the reader wrapped, kept while the app runs: the phone twin of
/// the web's per-tab memory (`web/src/utils/code-block-actions.ts`, sessionStorage).
/// Leaving a conversation and coming back finds every block as it was left; it used
/// to live in the timeline's coordinator and went with it.
///
/// A block is named by its conversation (the timeline scope, or a surface's own name
/// for a letter or a note) and its key (`CodeHighlighter.blockKey`), never by a row
/// id: a streaming reply's rows change ids as they settle into history. At most
/// `limit` blocks are kept; the one wrapped longest ago goes first.
///
/// Main thread only: the cells' Wrap and the hosts that read it are on it; the layout
/// actor gets a copy of the keys in its `TimelineInput`.
@MainActor
final class CodeWrapMemory {
    static let shared = CodeWrapMemory()
    /// The web's `WRAPPED_MAX`.
    static let limit = 200

    /// Oldest first; each entry once.
    private var order: [Entry] = []

    private struct Entry: Equatable {
        let scope: String
        let key: String
    }

    /// The keys wrapped in one conversation.
    func keys(scope: String) -> Set<String> {
        Set(order.lazy.filter { $0.scope == scope }.map(\.key))
    }

    func isWrapped(_ key: String, scope: String) -> Bool {
        order.contains(Entry(scope: scope, key: key))
    }

    /// Flip one block; returns whether it is wrapped now.
    @discardableResult
    func toggle(_ key: String, scope: String) -> Bool {
        let wrapped = !isWrapped(key, scope: scope)
        set(key, scope: scope, wrapped: wrapped)
        return wrapped
    }

    func set(_ key: String, scope: String, wrapped: Bool) {
        let entry = Entry(scope: scope, key: key)
        order.removeAll { $0 == entry }
        guard wrapped else { return }
        order.append(entry)
        if order.count > Self.limit { order.removeFirst(order.count - Self.limit) }
    }

    func resetForTesting() { order.removeAll() }
}
