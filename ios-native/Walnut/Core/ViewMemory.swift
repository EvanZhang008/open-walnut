import Foundation

/// A screen's view choice is kept: the tab in front, a sub-page over a chat, a mode, a
/// grouping (the owner, 2026-11-08: "whatever I had open last, for example a VP, must be what
/// opens next time"). The phone's twin of the web's `usePageView`: a choice held only in
/// `@State` comes back reset after a relaunch, so every view choice reads its first value
/// from here and writes each change back. `ViewMemoryGuardTests` fails on a new view-choice
/// `@State` that does neither.
///
/// Keys live under `walnut.view.` in `AppPrefs.defaults`, so the demo keeps its own. A UI test
/// starts with none kept (`freshArgument`, passed by `UITestLaunch`).
enum ViewMemory {
    static let prefix = "walnut.view."

    static func key(_ page: String, _ name: String, id: String? = nil) -> String {
        var key = "\(prefix)\(page).\(name)"
        if let id, !id.isEmpty { key += ".\(id)" }
        return key
    }

    /// The kept choice, or `initial` when nothing was kept or the kept word names no case
    /// any more (a renamed or removed view).
    static func read<T: RawRepresentable>(
        _ page: String, _ name: String, id: String? = nil, initial: T,
        defaults: UserDefaults = AppPrefs.defaults
    ) -> T where T.RawValue == String {
        guard let raw = defaults.string(forKey: key(page, name, id: id)), let value = T(rawValue: raw) else {
            return initial
        }
        return value
    }

    /// Optional form: nil when nothing is kept (a sub-page that was closed).
    static func readOptional<T: RawRepresentable>(
        _ page: String, _ name: String, id: String? = nil, as type: T.Type = T.self,
        defaults: UserDefaults = AppPrefs.defaults
    ) -> T? where T.RawValue == String {
        defaults.string(forKey: key(page, name, id: id)).flatMap(T.init(rawValue:))
    }

    /// The launch flag a UI test passes (`UITestLaunch`): every kept view choice is forgotten
    /// before the first view reads one, so a test never opens on what the run before it left.
    static let freshArgument = "walnut.uiTestFreshViews"

    static func eraseWhenAsked(defaults: UserDefaults = AppPrefs.defaults) {
        guard UserDefaults.standard.bool(forKey: freshArgument) else { return }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            defaults.removeObject(forKey: key)
        }
    }

    /// A kept id (the session a page shows), or nil.
    static func readId(
        _ page: String, _ name: String, defaults: UserDefaults = AppPrefs.defaults
    ) -> String? {
        defaults.string(forKey: key(page, name)).flatMap { $0.isEmpty ? nil : $0 }
    }

    static func writeId(
        _ id: String?, _ page: String, _ name: String, defaults: UserDefaults = AppPrefs.defaults
    ) {
        let key = key(page, name)
        if let id, !id.isEmpty { defaults.set(id, forKey: key) } else { defaults.removeObject(forKey: key) }
    }

    /// Keeps `value`; nil forgets the choice (the sub-page was closed).
    static func write<T: RawRepresentable>(
        _ value: T?, _ page: String, _ name: String, id: String? = nil,
        defaults: UserDefaults = AppPrefs.defaults
    ) where T.RawValue == String {
        let key = key(page, name, id: id)
        if let value { defaults.set(value.rawValue, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// Which page an Org node's chat is open on. The page kept over that chat is kept per page as
/// well as per node: the Chat tab and the Tasks tab each come back to their own (2026-11-09).
enum OrgPagePlace: String {
    /// The Chat tab and the Tasks tab, each with its own kept page. `other` is every other host
    /// of a session page (a sheet, the calendar, an Inbox letter): it keeps nothing, so it never
    /// changes what a tab comes back to.
    case chat, tasks, other

    /// The id the kept page is stored under, nil = not kept. The Chat tab keeps the key it always had.
    func keyId(_ nodeId: String) -> String? {
        switch self {
        case .chat: nodeId
        case .tasks: "\(rawValue).\(nodeId)"
        case .other: nil
        }
    }
}

import SwiftUI

extension EnvironmentValues {
    /// The page an Org node's chat sits on (`OrgPagePlace`): the Chat tab sets `.chat`, the Tasks
    /// tab `.tasks`; anywhere else keeps nothing.
    @Entry var orgPagePlace: OrgPagePlace = .other
}
