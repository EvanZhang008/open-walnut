#!/bin/sh
# Container entrypoint for the remote-host onboarding fixture (see Dockerfile).
# Installs the run's throwaway PUBLIC key, makes fresh host keys, runs sshd.
set -eu

if [ -z "${WALNUT_ONBOARDING_AUTHORIZED_KEY:-}" ]; then
  echo "walnut-onboarding: WALNUT_ONBOARDING_AUTHORIZED_KEY is empty; run.sh passes the public key there" >&2
  exit 64
fi

install -d -m 0755 -o root -g root /etc/ssh/authorized_keys
printf '%s\n' "$WALNUT_ONBOARDING_AUTHORIZED_KEY" > /etc/ssh/authorized_keys/alice
chown root:root /etc/ssh/authorized_keys/alice
chmod 0644 /etc/ssh/authorized_keys/alice

ssh-keygen -A >/dev/null
mkdir -p /run/sshd

# The key has been written; sshd does not need it in its environment.
exec env -u WALNUT_ONBOARDING_AUTHORIZED_KEY /usr/sbin/sshd -D -e
