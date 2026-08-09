/**
 * Cloud-init / user-data generator for the cloud companion's first boot.
 *
 * The script clones the repo, drops the pairing code into /etc/walnut/setup-token
 * (mode 0600, root-only dir), then hands off to scripts/cloud/setup.sh. The
 * server reads that file via WALNUT_SETUP_TOKEN_FILE and claims itself against
 * the operator's Mac — see src/core/device-auth.ts.
 *
 * SECURITY: every interpolated value is single-quote escaped, and the pairing
 * code appears in exactly ONE command (the printf that writes the file). It is
 * never passed to setup.sh, never exported, and never echoed.
 */

/**
 * Sentinel domain meaning "derive the hostname from this VM's public IP at boot"
 * (`<dashed-ip>.sslip.io`). Used when the operator has no domain of their own.
 */
export const SSLIP_AUTO = 'SSLIP_AUTO'

export const DEFAULT_REPO_URL = 'https://github.com/EvanZhang008/open-walnut.git'
export const DEFAULT_BRANCH = 'main'

export type UserDataFlavor = 'al2023' | 'ubuntu'

export interface BuildUserDataParams {
  /** Public hostname, or the SSLIP_AUTO sentinel to resolve it on the box. */
  domain: string
  /** 32 lowercase hex chars — must match device-auth's provisioned-token regex. */
  pairingCode: string
  repoUrl?: string
  branch?: string
  flavor: UserDataFlavor
}

/** Hostname shape we accept for `domain` (labels, dots, no scheme or path). */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i
/** Git URL shape for repoUrl — https only, no shell metacharacters. */
const REPO_URL_RE = /^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,128}$/

/** Wrap a value in single quotes, escaping any embedded single quote. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function assertSafeInputs(params: BuildUserDataParams): { repoUrl: string; branch: string } {
  const { domain, pairingCode } = params
  if (!/^[0-9a-f]{32}$/.test(pairingCode)) {
    throw new Error('Invalid pairing code: expected 32 lowercase hex chars')
  }
  if (domain !== SSLIP_AUTO && !HOSTNAME_RE.test(domain)) {
    throw new Error(`Invalid domain: ${JSON.stringify(domain)} is not a hostname`)
  }
  const repoUrl = params.repoUrl ?? DEFAULT_REPO_URL
  if (!REPO_URL_RE.test(repoUrl)) {
    throw new Error(`Invalid repoUrl: ${JSON.stringify(repoUrl)} must be an https URL`)
  }
  const branch = params.branch ?? DEFAULT_BRANCH
  if (!BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch: ${JSON.stringify(branch)}`)
  }
  return { repoUrl, branch }
}

/**
 * Package-manager install block. Autodetects dnf/apt so the script survives a
 * flavor mismatch (a wrong AMI choice shouldn't strand the box); `flavor` only
 * decides which manager is tried first.
 */
function installGitBlock(flavor: UserDataFlavor): string {
  const first = flavor === 'ubuntu' ? 'apt' : 'dnf'
  const lines = [
    'if command -v git >/dev/null 2>&1; then',
    '  echo "git already present"',
    `elif command -v ${first} >/dev/null 2>&1; then`,
    flavor === 'ubuntu'
      ? '  DEBIAN_FRONTEND=noninteractive apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y git'
      : '  dnf install -y git',
    flavor === 'ubuntu'
      ? 'elif command -v dnf >/dev/null 2>&1; then\n  dnf install -y git'
      : 'elif command -v apt-get >/dev/null 2>&1; then\n  DEBIAN_FRONTEND=noninteractive apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y git',
    'elif command -v yum >/dev/null 2>&1; then',
    '  yum install -y git',
    'else',
    '  echo "no supported package manager (dnf/apt/yum) — cannot install git" >&2',
    '  exit 1',
    'fi',
  ]
  return lines.join('\n')
}

/**
 * Resolve the public IP and derive `<dashed-ip>.sslip.io`. Polls until two
 * consecutive reads 5s apart agree — an Elastic IP association can land after
 * cloud-init starts, so the first read may be the ephemeral address.
 */
function sslipResolverBlock(): string {
  return [
    'public_ip() {',
    '  local token',
    '  token="$(curl -4 -s -m 5 -X PUT http://169.254.169.254/latest/api/token \\',
    '    -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)"',
    '  if [ -n "$token" ]; then',
    '    curl -4 -s -m 5 -H "X-aws-ec2-metadata-token: $token" \\',
    '      http://169.254.169.254/latest/meta-data/public-ipv4 || true',
    '  else',
    '    curl -4 -s -m 5 ifconfig.me || true',
    '  fi',
    '}',
    '',
    'IP=""',
    'prev=""',
    '# ~3 min cap: 36 reads x 5s.',
    'for _ in $(seq 1 36); do',
    '  cur="$(public_ip | tr -d "[:space:]")"',
    '  if [ -n "$cur" ] && [ "$cur" = "$prev" ]; then',
    '    IP="$cur"',
    '    break',
    '  fi',
    '  prev="$cur"',
    '  sleep 5',
    'done',
    'if [ -z "$IP" ]; then',
    '  echo "could not determine a stable public IP for sslip.io hostname" >&2',
    '  exit 1',
    'fi',
    'DOMAIN="$(echo "$IP" | tr . -).sslip.io"',
    'echo "resolved sslip hostname: $DOMAIN (ip $IP)"',
  ].join('\n')
}

/**
 * Build the first-boot script. Returns plain bash (callers base64 it if their
 * provider API needs that).
 */
export function buildUserData(params: BuildUserDataParams): string {
  const { repoUrl, branch } = assertSafeInputs(params)
  const { domain, pairingCode, flavor } = params

  const domainBlock = domain === SSLIP_AUTO
    ? sslipResolverBlock()
    : `DOMAIN=${shellQuote(domain)}`

  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'exec > >(tee /var/log/walnut-setup.log) 2>&1',
    '',
    'echo "walnut cloud companion: first boot started at $(date -u +%FT%TZ)"',
    '',
    '# ── git ──',
    installGitBlock(flavor),
    '',
    '# ── hostname ──',
    domainBlock,
    '',
    '# ── source ──',
    'rm -rf /opt/walnut',
    `git clone --branch ${shellQuote(branch)} ${shellQuote(repoUrl)} /opt/walnut`,
    '',
    '# ── pairing code ──',
    '# The one place the code touches this box. printf puts it in argv for the',
    '# duration of one builtin call, which is unavoidable when writing a secret',
    '# from a script; it is never passed to setup.sh, exported, or echoed.',
    'install -d -m 700 /etc/walnut',
    `printf '%s' ${shellQuote(pairingCode)} > /etc/walnut/setup-token`,
    'chmod 600 /etc/walnut/setup-token',
    '',
    '# ── install + start ──',
    'bash /opt/walnut/scripts/cloud/setup.sh "$DOMAIN"',
    '',
    'echo "walnut cloud companion: first boot finished at $(date -u +%FT%TZ)"',
    '',
  ].join('\n')
}

/** Numbered operator instructions for the manual (copy-paste) path. */
export function manualUserDataSteps(domain: string): string[] {
  const hostNote = domain === SSLIP_AUTO
    ? 'The script derives the hostname from the box\'s public IP (<dashed-ip>.sslip.io) — no DNS record needed.'
    : `Point an A record for ${domain} at the box's public IP before the script reaches the TLS step (DNS-only, no proxy).`
  return [
    'Create a VM with a public IPv4 address, ports 80 and 443 open inbound (2 GB RAM minimum, arm64 or x86_64).',
    hostNote,
    'Paste the script below as the VM\'s cloud-init / user-data, or save it on the box and run it as root.',
    'First boot clones the repo, installs Node and Caddy, builds Walnut, and obtains a certificate. It takes 5-15 minutes.',
    'Follow along on the box with: tail -f /var/log/walnut-setup.log',
    'Walnut watches for the box to come up and claims it automatically with the pairing code baked into the script.',
  ]
}
