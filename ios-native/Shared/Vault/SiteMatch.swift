import Foundation

/// Which saved logins belong to the site iOS asks about. iOS matches the QuickType bar itself from
/// the identities Walnut gives it (CredentialIdentities); this ranks the list Walnut shows.
///
/// A login matches when the page's host is its saved host or a subdomain of it, or the other way
/// round (accounts.example.com and example.com), never two siblings under a shared suffix that
/// anyone can register under (two github.io sites, two herokuapp.com apps). The server holds the
/// full public suffix list (url-match.ts); this short list covers the shared hosts people sign in
/// on, and a miss here only means the login is not suggested: search still finds it.
enum SiteMatch {
    /// Parents nobody owns as a site of their own: a login saved for one never matches another.
    static let sharedSuffixes: Set<String> = [
        "github.io", "gitlab.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
        "web.app", "firebaseapp.com", "appspot.com", "azurewebsites.net", "cloudfront.net", "blogspot.com",
        "wordpress.com", "glitch.me", "repl.co", "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app",
        "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "ne.jp", "or.jp",
        "com.cn", "net.cn", "org.cn", "com.br", "co.nz", "co.in", "co.kr", "com.tw", "com.hk", "com.sg", "com.mx",
    ]

    /// The host of a saved site or of what iOS names (a URL, or a bare domain), lower case, without
    /// a leading "www.".
    static func host(of raw: String) -> String? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        let withScheme = t.contains("://") ? t : "https://\(t)"
        guard let h = URLComponents(string: withScheme)?.host?.lowercased(), !h.isEmpty else { return nil }
        let host = h.hasSuffix(".") ? String(h.dropLast()) : h
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// How well a saved host fits the page's host: 2 the same host, 1 a parent or child, 0 none.
    static func score(saved: String, page: String) -> Int {
        if saved == page { return 2 }
        if page.hasSuffix(".\(saved)") { return sharedSuffixes.contains(saved) || !saved.contains(".") ? 0 : 1 }
        if saved.hasSuffix(".\(page)") { return sharedSuffixes.contains(page) || !page.contains(".") ? 0 : 1 }
        return 0
    }

    /// The best fit of an item's sites for any of the hosts iOS names.
    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]

    /// Not the same site, but one like it: both this machine (localhost and 127.0.0.1), or the
    /// same name under another ending (example.com and example.org). Only ranks the picker; a
    /// pick from it still asks before filling.
    static func similar(saved: String, page: String) -> Bool {
        if loopback.contains(saved) && loopback.contains(page) { return true }
        func name(_ h: String) -> String? {
            let parts = h.split(separator: ".")
            guard parts.count >= 2 else { return nil }
            let n = String(parts[parts.count - 2])
            return n.count >= 3 && !sharedSuffixes.contains(n) ? n : nil
        }
        guard let a = name(saved), let b = name(page) else { return false }
        return a == b
    }

    static func similar(item: VaultItem, pageHosts: [String]) -> Bool {
        item.hosts.contains { saved in pageHosts.contains { similar(saved: saved, page: $0) } }
    }

    static func score(item: VaultItem, pageHosts: [String]) -> Int {
        var best = 0
        for saved in item.hosts {
            for page in pageHosts { best = max(best, score(saved: saved, page: page)) }
        }
        return best
    }
}

/// A login saved for one site, picked for a page of another: the person confirms it first, so
/// a tap on the wrong row never hands a password to the wrong site.
enum AutoFillCrossSite {
    /// A request names no page when an app asks without a site: nothing to compare then.
    static func needsConfirm(item: VaultItem, hosts: [String]) -> Bool {
        guard !hosts.isEmpty else { return false }
        return SiteMatch.score(item: item, pageHosts: hosts) == 0
    }

    static func title(_ item: VaultItem?, hosts: [String]) -> String {
        let page = hosts.first ?? "this page"
        guard let saved = item?.primaryHost else { return "This login is not saved for \(page)" }
        return "This login is saved for \(saved), not \(page)"
    }
}
