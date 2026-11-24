import SwiftUI
import UIKit
import XCTest
@testable import Walnut

/// A task row's ask card drawn in a real `List` cell at a phone's width, kept as a picture
/// (2026-11-24: in a list cell its question was cut to one line, with no why and no keys). The
/// picture is the review: its question whole, its why folded with Expand, Yes and No under it.
@MainActor
final class ActionNeededWholeRenderTests: XCTestCase {
    func testTheCardInAListCellShowsItsQuestionWholeItsWhyAndItsKeys() throws {
        let width = 390, height = 760
        let task = WalnutTask(
            id: "t-render", title: "Log redaction review", status: "todo", phase: "IN_PROGRESS", priority: "none",
            project: "", dueDate: nil, createdAt: nil, updatedAt: nil, completedAt: nil,
            starred: nil, pinned: false, tags: nil, summary: nil
        )
        let yesNo = WalnutActionItem(
            kind: "ask", id: "ask-render-1",
            summary: "Push the second revision of the log redaction review (it no longer writes whole customer objects into the log)? I recommend pushing it.",
            sessionId: "s-render",
            detail: "Review: https://example.com/reviews/1234 . I checked again on 11-22: the review still has only its first revision, nobody approved it, and auto-merge is on. The second revision logs only the object's address and the fields that changed. Without it, an approval of the first revision merges it as it is.",
            formKind: "yes_no")
        let pick = WalnutActionItem(
            kind: "ask", id: "ask-render-2", summary: "Which build goes to the testers first?", sessionId: "s-render",
            options: [.init(id: "a", label: "The staging build", recommended: true), .init(id: "b", label: "The local build")],
            formKind: "single")
        let view = List {
            Text("Log redaction review").font(.body)
            ActionNeededView(task: task, items: [yesNo])
            Text("Release testing").font(.body)
            ActionNeededView(task: task, items: [pick])
        }
        .listStyle(.plain)
        .frame(width: CGFloat(width), height: CGFloat(height))

        let host = UIHostingController(rootView: view)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { _ in
            host.view.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let png = try XCTUnwrap(image.pngData())
        XCTAssertGreaterThan(png.count, 10_000, "the list drew nothing")
        let shot = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        shot.name = "ask-card-whole-in-a-list-cell.png"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
