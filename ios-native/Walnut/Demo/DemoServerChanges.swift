import Foundation

// The demo server's Changed page (`/api/v1/sessions/:id/changes*`): one set of
// sample edits under the session's working directory, sized like a real
// afternoon's work (a few files with several changes each, a new stylesheet, a
// deleted file, one large generated file that opens a page at a time, and a
// built bundle whose single line is about 53,000 characters long).
extension DemoServer {
    func routeChanges(_ r: DemoRequest, _ s: [String], sessionID: String, cwd: String) -> DemoReply? {
        guard r.method == "GET" else { return nil }
        let sub = s.count > 3 ? s[3] : ""
        let files = DemoChanges.files(cwd: cwd)
        switch sub {
        case "":
            let light = r.query["light"] == "1"
            let wire = files.map { f -> SessionChangedFile in
                let counts = DiffEngine.diff(before: f.before, after: f.after)
                return SessionChangedFile(
                    filePath: f.filePath, relPath: f.relPath,
                    before: light ? "" : f.before, after: light ? "" : f.after, status: f.status,
                    oldRelPath: f.oldRelPath, partial: false,
                    additions: counts.additions, deletions: counts.deletions)
            }
            let group = SessionChangeGroup(repoRoot: cwd, label: (cwd as NSString).lastPathComponent,
                                           kind: "cwd", files: wire, compare: nil)
            return .encoded(SessionChangesResponse(sessionId: sessionID, groups: [group], fileCount: wire.count,
                                                   anyPartial: false, stale: false, light: light))
        case "file":
            guard let path = r.query["path"], !path.isEmpty else {
                return .error(400, "bad_request", "path is required")
            }
            guard let f = files.first(where: { $0.filePath == path }) else {
                return .error(404, "not_found", "File not in session changes")
            }
            DemoChanges.noteFileRead()
            return .encoded(SessionFileChangeResponse(sessionId: sessionID, repoRoot: cwd, file: f))
        case "refs":
            let now = clockNow.now.timeIntervalSince1970
            return .encoded(SessionGitRefs(
                repoRoot: cwd, current: "pricing-redesign", head: "4f2c9e1", defaultRef: "main",
                refs: [
                    SessionGitRef(name: "main", kind: "local", sha: "9a71d03", time: now - 86_400 * 2),
                    SessionGitRef(name: "pricing-redesign", kind: "local", sha: "4f2c9e1", time: now - 3_600),
                    SessionGitRef(name: "origin/main", kind: "remote", sha: "9a71d03", time: now - 86_400 * 2),
                ],
                commits: [
                    SessionGitCommit(sha: "4f2c9e1b7d", parent: "c03a5f2e11", parents: 1, author: "Sam",
                                     time: now - 3_600, subject: "Pricing: annual toggle and plan cards", onBranch: true),
                    SessionGitCommit(sha: "c03a5f2e11", parent: "9a71d03aa4", parents: 1, author: "Sam",
                                     time: now - 7_200, subject: "Move plan data out of the page", onBranch: true),
                    SessionGitCommit(sha: "9a71d03aa4", parent: "55e0b2c9d1", parents: 1, author: "Riley",
                                     time: now - 86_400 * 2, subject: "Footer links for the new docs", onBranch: false),
                ]))
        default:
            return nil
        }
    }
}

/// The sample edits, built from a few templates so the files read like code.
enum DemoChanges {
    private static let lock = NSLock()
    /// A file's newer text, as if the agent edited it again (tests use it).
    nonisolated(unsafe) private static var rewritten: [String: String] = [:]
    nonisolated(unsafe) private static var fileReadCount = 0

    /// The agent edits `relPath` again: the next read gets `after`.
    static func rewrite(_ relPath: String, after: String) { lock.withLock { rewritten[relPath] = after } }
    static var fileReads: Int { lock.withLock { fileReadCount } }
    static func noteFileRead() { lock.withLock { fileReadCount += 1 } }
    static func reset() { lock.withLock { rewritten.removeAll(); fileReadCount = 0 } }

    static func files(cwd: String) -> [SessionChangedFile] {
        let newer = lock.withLock { rewritten }
        func file(_ rel: String, _ before: String, _ after: String, _ status: String, old: String? = nil) -> SessionChangedFile {
            SessionChangedFile(filePath: "\(cwd)/\(rel)", relPath: rel, before: before, after: newer[rel] ?? after,
                               status: status, oldRelPath: old)
        }
        return [
            file("src/pages/pricing/PricingTable.tsx", pricingTableBefore, pricingTableAfter, "modified"),
            file("src/pages/pricing/plans.ts", plansBefore, plansAfter, "modified"),
            file("src/styles/pricing.css", "", pricingCSS, "added"),
            file("src/pages/pricing/OldBanner.tsx", oldBanner, "", "deleted"),
            file("docs/pricing-notes.md", notesBefore, notesAfter, "modified"),
            file("src/data/price-history.json", "", priceHistory, "added"),
            file("public/assets/pricing.min.js", "", pricingBundle, "added"),
        ]
    }

    /// A built bundle: one line of about 53,000 characters.
    static let pricingBundle: String = {
        let part = "function t(n){return n.monthly*12*(1-n.annualDiscount)}var e=[\"starter\",\"team\",\"business\"]"
        return (0..<420).map { "\(part).map(function(r,i){return r+i*\($0)})" }.joined(separator: ";") + "\n"
    }()

    private static let tableHelpers = (1...40).map { i in
        "function formatTier\(i)(amount: number): string {\n  return `$${(amount / 100).toFixed(2)}`\n}\n"
    }.joined(separator: "\n")

    static let pricingTableBefore = """
    import { plans } from './plans'
    import { Button } from '../../ui/Button'

    interface Props {
      currency: string
    }

    \(tableHelpers)
    export function PricingTable({ currency }: Props) {
      return (
        <table className="pricing">
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id}>
                <td>{plan.name}</td>
                <td>{plan.monthly} {currency}</td>
                <td><Button>Choose</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )
    }

    """

    static let pricingTableAfter = """
    import { useState } from 'react'
    import { plans, type Plan } from './plans'
    import { Button } from '../../ui/Button'
    import '../../styles/pricing.css'

    interface Props {
      currency: string
      /** Annual prices are shown by default: most teams pay yearly. */
      defaultAnnual?: boolean
    }

    \(tableHelpers)
    function price(plan: Plan, annual: boolean): number {
      return annual ? Math.round(plan.monthly * 12 * (1 - plan.annualDiscount)) : plan.monthly
    }

    export function PricingTable({ currency, defaultAnnual = true }: Props) {
      const [annual, setAnnual] = useState(defaultAnnual)
      return (
        <section className="pricing">
          <label className="pricing-toggle"><input type="checkbox" checked={annual} onChange={(e) => setAnnual(e.target.checked)} /> Pay yearly and save up to 20% on every plan, billed once a year from the day you start</label>
          <div className="pricing-cards">
            {plans.map((plan) => (
              <article key={plan.id} className={plan.featured ? 'card featured' : 'card'}>
                <h3>{plan.name}</h3>
                <p className="price">{price(plan, annual)} {currency}<span>/{annual ? 'year' : 'month'}</span></p>
                <Button variant={plan.featured ? 'primary' : 'secondary'}>Start with {plan.name}</Button>
              </article>
            ))}
          </div>
        </section>
      )
    }

    """

    static let plansBefore = """
    export const plans = [
      { id: 'starter', name: 'Starter', monthly: 9 },
      { id: 'team', name: 'Team', monthly: 29 },
      { id: 'business', name: 'Business', monthly: 99 },
    ]

    """

    static let plansAfter = """
    export interface Plan {
      id: string
      name: string
      monthly: number
      annualDiscount: number
      featured?: boolean
    }

    export const plans: Plan[] = [
      { id: 'starter', name: 'Starter', monthly: 9, annualDiscount: 0.1 },
      { id: 'team', name: 'Team', monthly: 29, annualDiscount: 0.2, featured: true },
      { id: 'business', name: 'Business', monthly: 99, annualDiscount: 0.2 },
    ]

    """

    static let pricingCSS = """
    .pricing { display: grid; gap: 24px; padding: 48px 16px; }
    .pricing-toggle { justify-self: center; font-weight: 500; }
    .pricing-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
    .card { border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
    .card.featured { border-color: var(--accent); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08); }
    .price { font-size: 32px; font-weight: 700; }
    .price span { font-size: 14px; color: var(--muted); }

    """

    static let oldBanner = """
    export function OldBanner() {
      return <div className="banner">Prices change on March 1</div>
    }

    """

    static let notesBefore = """
    # Pricing page notes

    The page lists three plans in a table.

    """

    static let notesAfter = """
    # Pricing page notes

    The page shows three plans as cards, with a yearly toggle that is on by default because most of the teams we talked to pay once a year and want to see that price first, not the monthly one.

    The Team plan is the featured card. Its discount is 20%; Starter gets 10%.

    """

    static let priceHistory: String = {
        var out = "[\n"
        for i in 0..<3_600 {
            out += "  { \"day\": \(i), \"starter\": \(900 + i % 7), \"team\": \(2900 + i % 11), \"business\": \(9900 + i % 13) },\n"
        }
        return out + "  { \"day\": 3600, \"starter\": 900, \"team\": 2900, \"business\": 9900 }\n]\n"
    }()
}
