import Foundation

@main
struct ProcessOutputReaderTests {
    static func main() throws {
        let pipe = Pipe()
        let eof = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var events: [String] = []
        var eofCount = 0

        let reader = ProcessOutputReader(
            handle: pipe.fileHandleForReading,
            logger: { event, _ in
                lock.lock()
                events.append(event)
                lock.unlock()
            }
        )
        reader.start(
            onText: { _ in },
            onEOF: {
                lock.lock()
                eofCount += 1
                lock.unlock()
                eof.signal()
            }
        )

        try pipe.fileHandleForWriting.write(contentsOf: Data("ready\n".utf8))
        try pipe.fileHandleForWriting.close()

        guard eof.wait(timeout: .now() + 2) == .success else {
            fatalError("Timed out waiting for EOF")
        }
        Thread.sleep(forTimeInterval: 0.2)

        precondition(reader.isStopped, "Reader must stop at EOF")
        precondition(
            pipe.fileHandleForReading.readabilityHandler == nil,
            "EOF must detach the readability handler"
        )
        lock.lock()
        let observedEOFCount = eofCount
        let observedEvents = events
        lock.unlock()
        precondition(observedEOFCount == 1, "EOF callback must run exactly once")
        precondition(
            observedEvents == ["server_output_reader_started", "server_output_reader_stopped"],
            "Expected one start and one stop lifecycle event"
        )

        var restartPolicy = ServerRestartPolicy()
        precondition(restartPolicy.nextDelay(healthyFor: nil) == 1)
        precondition(restartPolicy.nextDelay(healthyFor: 5) == 2)
        precondition(restartPolicy.nextDelay(healthyFor: 5) == 4)
        precondition(restartPolicy.nextDelay(healthyFor: 5) == 8)
        precondition(restartPolicy.nextDelay(healthyFor: 5) == 16)
        precondition(
            restartPolicy.nextDelay(healthyFor: 5) == nil,
            "Repeated short-lived crashes must stop automatic restart"
        )
        precondition(
            restartPolicy.nextDelay(healthyFor: 120) == 1,
            "A healthy run must reset the restart backoff"
        )
        precondition(
            ServerRestartPolicy.ordinaryStartupTimeout == 180,
            "Ordinary startup must tolerate a loaded machine"
        )

        precondition(shouldAutomaticallyRestartServer(
            portConfirmed: true,
            ownsServer: true,
            isTerminating: false,
            isCurrentProcess: true
        ))
        precondition(!shouldAutomaticallyRestartServer(
            portConfirmed: true,
            ownsServer: true,
            isTerminating: true,
            isCurrentProcess: true
        ))
        precondition(!shouldAutomaticallyRestartServer(
            portConfirmed: false,
            ownsServer: true,
            isTerminating: false,
            isCurrentProcess: true
        ))
        precondition(!shouldAutomaticallyRestartServer(
            portConfirmed: true,
            ownsServer: false,
            isTerminating: false,
            isCurrentProcess: true
        ))
        precondition(!shouldAutomaticallyRestartServer(
            portConfirmed: true,
            ownsServer: true,
            isTerminating: false,
            isCurrentProcess: false
        ))

        // A start that never listened says why on the screen, never only in Console.
        let npm = "Open Walnut 0.6.17 is published (this is 0.6.16); installing it before starting. Set updates.auto: false\nnpm warn deprecated x@1\n"
        let stuck = StartupFailureText.timedOut(seconds: 180, output: npm)
        precondition(stuck.hasPrefix("The Walnut server did not become ready within 180 seconds. It was still installing a Walnut update before starting, which took longer than that.\n\n"))
        precondition(stuck.hasSuffix("npm warn deprecated x@1"))
        // An install that finished, or one the server left to run on its own, is not what held it.
        precondition(!StartupFailureText.timedOut(seconds: 180, output: npm + "Installed Open Walnut 0.6.17; starting it.\n").contains("still installing"))
        precondition(!StartupFailureText.timedOut(seconds: 180, output: npm + "Open Walnut 0.6.17 is still installing; starting 0.6.16 now.\n").contains("still installing a Walnut update"))
        precondition(StartupFailureText.timedOut(seconds: 300, output: "") == "The Walnut server did not become ready within 300 seconds.\n\nNo output was captured.")
        let many = (1...20).map { "line \($0)" }.joined(separator: "\n")
        precondition(StartupFailureText.timedOut(seconds: 180, output: many).hasSuffix((6...20).map { "line \($0)" }.joined(separator: "\n")))

        print("Desktop lifecycle regression tests passed")
    }
}
