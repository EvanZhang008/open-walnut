import Foundation

// `open-walnut://` links (src/core/plugin-install-link.ts): the app registers the
// scheme (CFBundleURLTypes in build.sh and build-release.sh), so a link clicked in
// a browser, a chat app or a README opens Walnut and hands the link to the
// console. The app never acts on a link itself: the console reads it and, for
// an install link, fills in the Plugin Store's form with its trust switch off.
//
// A page that is already open gets it through its desktop bridge
// (`window.__walnutDesktop.openLink`, web/src/utils/desktop-bridge.ts), so a
// link never reloads a page that may hold unsaved text. An older bundle without
// that hook gets the same link as a `#open-link=` fragment, which it ignores.
//
// Foundation only, so tests/desktop/app-link-tests.swift compiles it alone.

enum AppLink {
    static let scheme = "open-walnut"
    /// Same name as OPEN_LINK_FRAGMENT in src/core/plugin-install-link.ts.
    static let fragmentKey = "open-link"
    /// A link is a short URL; anything longer is not one we made.
    static let maxLength = 4_096

    /// True for a link this app was registered to receive.
    static func accepts(_ url: URL) -> Bool {
        return url.scheme?.lowercased() == scheme && url.absoluteString.count <= maxLength
    }

    /// encodeURIComponent: everything but A-Z a-z 0-9 - _ . ! ~ * ' ( ) is escaped.
    static func encodeComponent(_ value: String) -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    /// `#open-link=<link, encoded>`, the fragment the console reads.
    static func fragment(for url: URL) -> String? {
        guard accepts(url) else { return nil }
        return "#\(fragmentKey)=\(encodeComponent(url.absoluteString))"
    }

    /// A JavaScript string literal for any text (JSON is valid JavaScript).
    static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    /// What the app runs in the open page: the bridge when the page has it, the
    /// fragment otherwise. Answers how the link went in, for the app's log:
    /// "taken" or "refused" by the bridge, or "fragment" (the page reads it from
    /// the address, as a page still starting does).
    static func bridgeScript(for url: URL) -> String? {
        guard let fragment = fragment(for: url) else { return nil }
        let link = jsString(url.absoluteString)
        return """
        (function () {
          var bridge = window.__walnutDesktop;
          if (bridge && typeof bridge.openLink === 'function') return bridge.openLink(\(link)) === true ? 'taken' : 'refused';
          window.location.hash = \(jsString(fragment));
          return 'fragment';
        })()
        """
    }
}
