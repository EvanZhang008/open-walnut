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

        print("ProcessOutputReader EOF regression test passed")
    }
}
