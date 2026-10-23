#!/bin/bash
# Fleet host start: the run's public key, the environment every SSH session
# gets (each FLEET_ENV_<NAME>=<value> becomes <NAME>=<value>), new host keys, sshd.
set -euo pipefail
H=/home/walnut
install -d -m 700 -o walnut -g walnut "$H/.ssh"
printf '%s\n' "${FLEET_AUTHORIZED_KEY:?no public key given}" > "$H/.ssh/authorized_keys"
env | sed -n 's/^FLEET_ENV_//p' > "$H/.ssh/environment"
chown walnut:walnut "$H/.ssh/authorized_keys" "$H/.ssh/environment"
chmod 600 "$H/.ssh/authorized_keys" "$H/.ssh/environment"
ssh-keygen -A >/dev/null
unset FLEET_AUTHORIZED_KEY
echo "fleet host ready"
exec /usr/sbin/sshd -D -e
