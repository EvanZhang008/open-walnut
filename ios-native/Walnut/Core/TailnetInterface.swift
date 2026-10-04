import Darwin
import Foundation

/// Does this iPhone have a Tailscale tunnel up right now?
///
/// Tailscale gives every device an IPv4 address in the shared address space
/// 100.64.0.0/10 (RFC 6598) on the VPN tunnel interface (`utun*` on iOS). The
/// interface check matters: a cellular carrier may hand out the same range on
/// its own interface (`pdp_ip*`) for carrier-grade NAT, which says nothing
/// about Tailscale. Another VPN that also numbers its tunnel from this range
/// reads as a tailnet too; the guidance built on this is advice, never a gate.
enum TailnetInterface {
    /// One IPv4 address of one interface, as `getifaddrs` lists it.
    struct Address: Equatable, Sendable {
        let name: String
        let address: in_addr
        let isUp: Bool

        static func == (a: Address, b: Address) -> Bool {
            a.name == b.name && a.address.s_addr == b.address.s_addr && a.isUp == b.isUp
        }
    }

    private static let tunnelPrefixes = ["utun", "ipsec", "tun"]

    /// True when any interface that is up and a VPN tunnel holds an address
    /// in 100.64.0.0/10. Cheap (one `getifaddrs` walk), but not free: call it
    /// on appear or on a state change, never from a view body.
    static func hasTailnetInterface() -> Bool {
        hasTailnet(in: ipv4Addresses())
    }

    /// Pure decision over an interface list. Internal for WalnutTests.
    static func hasTailnet(in addresses: [Address]) -> Bool {
        addresses.contains { $0.isUp && isTunnelInterface($0.name) && isCgnatV4($0.address) }
    }

    static func isTunnelInterface(_ name: String) -> Bool {
        tunnelPrefixes.contains { name.hasPrefix($0) }
    }

    /// 100.64.0.0/10: the first 10 bits are 0110 0100 01.
    static func isCgnatV4(_ addr: in_addr) -> Bool {
        let host = UInt32(bigEndian: addr.s_addr)
        return host & 0xFFC0_0000 == 0x6440_0000
    }

    /// Same check on a dotted quad; false for anything that is not one.
    static func isCgnatV4(_ dotted: String) -> Bool {
        var addr = in_addr()
        guard inet_pton(AF_INET, dotted, &addr) == 1 else { return false }
        return isCgnatV4(addr)
    }

    private static func ipv4Addresses() -> [Address] {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        var out: [Address] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = cursor {
            let ifa = entry.pointee
            cursor = ifa.ifa_next
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { continue }
            let address = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
            out.append(Address(
                name: String(cString: ifa.ifa_name),
                address: address,
                isUp: (ifa.ifa_flags & UInt32(IFF_UP)) != 0
            ))
        }
        return out
    }
}
