import Foundation
import Darwin

/// Samples the FROZEN main thread's call stack from a background thread —
/// the forensic tool the 0x8BADF00D reports were missing.
///
/// Every field kill so far delivered a thread-0 stack of anonymous system
/// frames (SwiftUICore / AttributeGraph offsets) captured by the OS at kill
/// time. That proves "died in layout" but never WHOSE view or WHOSE data fed
/// the layout. This sampler runs while the freeze is still happening (invoked
/// by MainThreadWatchdog's background queue) and records the main thread's
/// frames as `Image+0xOFFSET` strings, so Walnut frames symbolicate offline
/// against the build's dSYM and name the exact code path.
///
/// ## Safety rules (each is load-bearing — do not "simplify")
///
///  - **Zero allocation and zero user-level locks while the target is
///    suspended.** If the main thread got suspended in the middle of malloc
///    or any lock this code later needs, the sampler would deadlock the
///    watchdog too. Between `thread_suspend` and `thread_resume` this code
///    touches only stack locals, a buffer allocated BEFORE the suspend, and
///    mach traps (`thread_get_state`, `vm_read_overwrite`).
///  - **`vm_read_overwrite`, never raw pointer loads.** The frame-pointer
///    chain can be corrupt mid-prologue; a raw load of an unmapped address
///    would crash the app INSIDE its own crash tooling. The mach read returns
///    an error for bad addresses instead.
///  - **Formatting (dladdr, string building) happens after resume.**
///
/// arm64 only (device + Apple-silicon simulator) — the only architectures
/// Walnut ships on. Other targets return nil.
enum StallSampler {

    /// Max frames captured per sample. 32 covers every field stack seen so
    /// far (the kill reports show 20-30 frames of layout recursion).
    private static let maxFrames = 32

    /// Strip arm64e pointer-authentication bits so the address matches the
    /// image's on-disk layout (harmless on plain arm64).
    private static func strip(_ address: UInt64) -> UInt {
        UInt(address & 0x0000_007F_FFFF_FFFF)
    }

    /// Capture the given thread's stack and format each frame as
    /// `Image+0xOFFSET [symbol]`. Returns nil when unsupported or the
    /// suspend/state read fails. Call from a NON-main thread only.
    static func sample(thread: thread_act_t) -> [String]? {
        #if arch(arm64)
        // Everything the suspended window needs, allocated up front.
        var addresses = [UInt](repeating: 0, count: maxFrames)
        var captured = 0

        guard thread_suspend(thread) == KERN_SUCCESS else { return nil }
        // From here to thread_resume: mach traps + stack locals ONLY.
        var state = arm_thread_state64_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<UInt32>.size
        )
        let flavor: thread_state_flavor_t = 6 // ARM_THREAD_STATE64
        let kr = withUnsafeMutablePointer(to: &state) { pointer in
            pointer.withMemoryRebound(to: natural_t.self, capacity: Int(count)) { raw in
                thread_get_state(thread, flavor, raw, &count)
            }
        }
        if kr == KERN_SUCCESS {
            addresses[captured] = strip(state.__pc); captured += 1
            let lr = strip(state.__lr)
            if lr != 0, captured < maxFrames { addresses[captured] = lr; captured += 1 }
            // Walk the frame-pointer chain: fp → [saved fp, saved lr].
            var fp = UInt(state.__fp)
            while captured < maxFrames, fp != 0, fp & 0xF == 0 {
                var frame: (UInt64, UInt64) = (0, 0)
                var outSize: vm_size_t = 0
                let read = withUnsafeMutableBytes(of: &frame) { buffer -> kern_return_t in
                    vm_read_overwrite(
                        mach_task_self_,
                        vm_address_t(fp),
                        16,
                        vm_address_t(UInt(bitPattern: buffer.baseAddress)),
                        &outSize
                    )
                }
                guard read == KERN_SUCCESS, outSize == 16 else { break }
                let ret = strip(frame.1)
                guard ret > 0x1000 else { break }
                addresses[captured] = ret
                captured += 1
                let next = UInt(frame.0)
                guard next > fp else { break } // stacks grow down; loops/corruption stop here
                fp = next
            }
        }
        thread_resume(thread)
        guard kr == KERN_SUCCESS, captured > 0 else { return nil }

        // Post-resume: symbolication may allocate freely now.
        return (0..<captured).map { formatFrame(addresses[$0]) }
        #else
        _ = thread
        return nil
        #endif
    }

    /// `Image+0xOFFSET [symbol]` — offset is relative to the image's load
    /// address, so Walnut frames resolve offline against the dSYM without
    /// needing the randomized slide from the crash report.
    private static func formatFrame(_ address: UInt) -> String {
        var info = Dl_info()
        guard dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0,
              let base = info.dli_fbase
        else { return String(format: "?+0x%lx", address) }
        let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
        let offset = address - UInt(bitPattern: base)
        if let sname = info.dli_sname {
            return String(format: "%@+0x%lx [%@]", image, offset, String(cString: sname))
        }
        return String(format: "%@+0x%lx", image, offset)
    }
}
