/**
 * The command that installs a C compiler on a host (Walnut builds dtach with it, and dtach
 * keeps a terminal alive across disconnects). Every place that names one asks here, by the
 * package manager the host has: 2026-11-03 an Ubuntu machine was told `sudo yum install -y
 * gcc`, because the hint listed yum first for every Linux.
 *
 * The packages are the ones the daemon's automatic fix installs (host-fix-core.ts
 * packageArgs), so the command a user copies does what the fix would have done.
 * tests/core/hosts/compiler-install.test.ts keeps every other place from naming one itself.
 */

/** The package managers a host is asked about, in the order the daemon looks for them. */
export const PACKAGE_MANAGERS = ['dnf', 'yum', 'apt-get', 'apk', 'zypper'] as const
export type PackageManager = typeof PACKAGE_MANAGERS[number]

const INSTALL: Record<PackageManager, string> = {
  dnf: 'sudo dnf install -y gcc glibc-devel',
  yum: 'sudo yum install -y gcc glibc-devel',
  // A fresh Debian or Ubuntu (WSL's included) has no package lists until the first update.
  'apt-get': 'sudo apt-get update && sudo apt-get install -y gcc libc6-dev',
  apk: 'sudo apk add gcc musl-dev',
  zypper: 'sudo zypper install -y gcc glibc-devel',
}

export const XCODE_TOOLS = 'xcode-select --install'

export function asPackageManager(name: unknown): PackageManager | undefined {
  return PACKAGE_MANAGERS.find((p) => p === name)
}

/**
 * The commands to show, the one to copy first. A Mac's compiler comes with the Command Line
 * Tools, never from a package manager. A Linux host whose package manager is known gets its
 * command alone; with it unknown (a daemon older than the field), the common ones.
 */
export function compilerInstallCommands(host: { platform?: string; packageManager?: string }): string[] {
  if (host.platform === 'darwin') return [XCODE_TOOLS]
  const pm = asPackageManager(host.packageManager)
  if (pm) return [INSTALL[pm]]
  return [INSTALL['apt-get'], INSTALL.dnf, INSTALL.yum]
}
