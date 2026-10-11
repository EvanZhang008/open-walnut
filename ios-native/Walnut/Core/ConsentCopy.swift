import Foundation

/// Where Apple Health data and Places visits go, said the same way in every
/// consent: the in-app sheets and screens here, and the system prompts, whose
/// strings live in project.yml and Info.plist (ReviewSurfaceTests checks that
/// all of them carry `destination`).
///
/// The truth it states: the user's own Walnut server, which runs on their Mac
/// or on a cloud machine they run, and from there the AI provider that server
/// is set up with. Places adds Apple Maps, which names each place.
enum ConsentCopy {
    static let destination =
        "only to your own Walnut server, on your Mac or on a cloud machine you run, and from there to the AI provider that server uses"

    /// The Apple Health sentence.
    static let health = "It goes \(destination)."

    /// The Places sentences.
    static let places = "They go \(destination). Apple Maps names each place."
}
