import SwiftUI

/// Read through the body route (`frame=1&refs=1`) so the server, not the phone, links the document's references.
struct LetterRoutedHTMLBody: View {
    let letterId: String
    let inline: String?
    let route: URL?
    var sizeBytes: Int? = nil
    var idPrefix = "inbox.letter"
    var linkSource = LinkSource()

    @State private var fetched: (key: String, file: URL)?
    @State private var failure: (key: String, message: String)?
    @State private var attempt = 0

    private var key: String { route?.absoluteString ?? "" }

    // One view for both sources, so swapping inline for the routed file keeps the measured height.
    private var source: LetterHTMLBody.Source? {
        if let fetched, fetched.key == key { return .file(fetched.file) }
        return inline.map { .inline($0) }
    }

    var body: some View {
        Group {
            if let source {
                VStack(alignment: .leading, spacing: 6) {
                    LetterHTMLBody(source: source, linkSource: linkSource)
                    // The inline copy has no linked references: say so rather than show dead links as working.
                    if failure?.key == key, fetched?.key != key { inlineFailureLine }
                }
            } else if let failure, failure.key == key {
                VStack(alignment: .leading, spacing: 6) {
                    Text(failure.message).font(.callout).foregroundStyle(.secondary)
                    Button("Try Again") { attempt += 1 }
                        .font(.callout)
                }
                .accessibilityIdentifier("\(idPrefix).deferredBodyError")
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(Self.sizeLabel(sizeBytes)).font(.caption).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("\(idPrefix).deferredBodyLoading")
            }
        }
        .task(id: "\(key)#\(attempt)") { await fetch() }
    }

    private var inlineFailureLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Links in this document couldn't be prepared.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button("Retry") { attempt += 1 }
                .font(.caption.weight(.semibold))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(idPrefix).bodyRouteError")
    }

    static func sizeLabel(_ bytes: Int?) -> String {
        guard let bytes, bytes > 0 else { return "Loading the document…" }
        let mb = Double(bytes) / 1_048_576
        return mb >= 1
            ? String(format: "Loading the document (%.1f MB)…", mb)
            : "Loading the document…"
    }

    private func fetch() async {
        let key = self.key
        guard fetched?.key != key else { return }
        guard let route else {
            failure = (key, "This letter's body couldn't be located on the server.")
            return
        }
        if failure?.key == key { failure = nil }
        do {
            // Always html: a markdown body is capped well under the inline threshold, so a deferred one is html.
            let file = try await LetterBodyDownload.fetchDocument(from: route, isHTML: true, refs: true, owner: letterId)
            // A replaced route's late file must not be installed over the new document.
            guard !Task.isCancelled else { return }
            fetched = (key, file)
            if failure?.key == key { failure = nil }
        } catch {
            if Task.isCancelled { return }
            AppLog.info("inbox", "letter body route read failed", [
                "letterId": letterId, "inline": inline == nil ? "no" : "yes", "error": String(describing: error),
            ])
            failure = (key, error.localizedDescription)
        }
    }
}
