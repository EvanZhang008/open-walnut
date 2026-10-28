#!/bin/sh
# binary-old-kernel.sh <walnut-linux-x64 file>
#
# Rehearse the compiled file on an old kernel: CentOS 7 (kernel 3.10, glibc
# 2.17), booted under QEMU from its official cloud image, because a container
# shares the host's kernel and cannot test this. KVM is used when /dev/kvm is
# usable, otherwise QEMU emulates (slow, still correct). Runs the same
# rehearsal as scripts/binary-matrix.sh, inside the VM, as an unprivileged user.
#
# Needs qemu-system-x86_64, qemu-img, cloud-localds (cloud-image-utils), ssh,
# scp and ssh-keygen; on a Debian-like runner with passwordless sudo it installs
# them. Work files go to $WALNUT_VM_DIR (default: a temp dir, removed after).
set -eu

[ $# -eq 1 ] || { echo "usage: binary-old-kernel.sh <walnut-linux-x64 file>" >&2; exit 2; }
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
repo="$(cd "$(dirname "$0")/.." && pwd)"
image_url="https://cloud.centos.org/centos/7/images/CentOS-7-x86_64-GenericCloud-2211.qcow2c"
image_sha="8540fcfb73b41d2322644b7c4301b52cb1753c6daf9539866214d725870db673"
port="${WALNUT_VM_SSH_PORT:-2222}"

need() { command -v "$1" >/dev/null 2>&1; }
if ! need qemu-system-x86_64 || ! need cloud-localds; then
  if need apt-get && sudo -n true 2>/dev/null; then
    sudo -n apt-get update -qq
    sudo -n apt-get install -y -qq qemu-system-x86 qemu-utils cloud-image-utils openssh-client >/dev/null
  else
    echo "binary-old-kernel: needs qemu-system-x86_64 and cloud-localds" >&2
    exit 2
  fi
fi

dir="${WALNUT_VM_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/walnut-vm.XXXXXX")}"
mkdir -p "$dir"
pidfile="$dir/qemu.pid"
cleanup() {
  # Our own QEMU only: the pid it wrote into our own work dir.
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    case "$pid" in ''|*[!0-9]*) ;; *) [ "$pid" -gt 1 ] && kill "$pid" 2>/dev/null || true ;; esac
  fi
  [ -n "${WALNUT_VM_DIR:-}" ] || rm -rf "$dir"
}
trap cleanup EXIT INT TERM

base="$dir/centos7.qcow2c"
if [ ! -f "$base" ]; then
  echo "downloading the CentOS 7 cloud image..."
  curl -fsSL --retry 3 -o "$base.part" "$image_url"
  mv "$base.part" "$base"
fi
actual="$(sha256sum "$base" | cut -d' ' -f1)"
[ "$actual" = "$image_sha" ] || { echo "binary-old-kernel: image checksum mismatch ($actual)" >&2; exit 1; }
qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$dir/disk.qcow2" 20G

rm -f "$dir/key" "$dir/key.pub"
ssh-keygen -q -t ed25519 -N '' -f "$dir/key"
cat > "$dir/user-data" <<EOF
#cloud-config
users:
  - name: walnut
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$dir/key.pub")
EOF
printf 'instance-id: walnut-vm\nlocal-hostname: walnut-vm\n' > "$dir/meta-data"
cloud-localds "$dir/seed.iso" "$dir/user-data" "$dir/meta-data"

accel="-accel tcg"
if [ -w /dev/kvm ] || { [ -e /dev/kvm ] && sudo -n chmod 666 /dev/kvm 2>/dev/null; }; then accel="-enable-kvm -cpu host"; fi
# shellcheck disable=SC2086
qemu-system-x86_64 $accel -m 4096 -smp 2 -display none -daemonize -pidfile "$pidfile" \
  -drive "file=$dir/disk.qcow2,if=virtio" -drive "file=$dir/seed.iso,if=virtio,format=raw" \
  -netdev "user,id=n0,hostfwd=tcp:127.0.0.1:$port-:22" -device virtio-net-pci,netdev=n0 \
  -serial "file:$dir/console.log"

ssh_opts="-i $dir/key -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"
echo "waiting for the VM ($accel)..."
deadline=$(( $(date +%s) + 1500 ))
# shellcheck disable=SC2086
until ssh $ssh_opts walnut@127.0.0.1 true 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "binary-old-kernel: the VM never answered ssh" >&2; tail -40 "$dir/console.log" >&2 || true; exit 1; }
  sleep 10
done

tar -C "$repo" -cf "$dir/rehearsal.tar" package.json scripts tests/providers/mock-claude.mjs tests/providers/mock-claude-flags.mjs
cp "$bin" "$dir/walnut"
# shellcheck disable=SC2086
scp -q -P "$port" -i "$dir/key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$dir/walnut" "$dir/rehearsal.tar" walnut@127.0.0.1:
# shellcheck disable=SC2086
ssh $ssh_opts walnut@127.0.0.1 'set -e
  echo "kernel $(uname -r), $(ldd --version | head -1)"
  mkdir -p w && tar -C w -xf rehearsal.tar && chmod +x walnut
  cd w && BUN_BE_BUN=1 ../walnut scripts/release-rehearsal/run.mjs --binary "$HOME/walnut" --work /tmp/rehearsal'
