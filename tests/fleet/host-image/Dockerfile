# A fleet host: a small Linux machine the Mac reaches over real SSH.
# It has sshd, one user (walnut), node (the host's `claude` is a mock that runs on
# it, and node is the daemon's last-resort runtime), procps and libfaketime.
# It has NO Walnut daemon, no bun, no curl or wget and no npm: the Mac deploys the
# daemon over SSH the way it does to a new host, and nothing here can download one.
FROM walnut-fleet-base:node22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server procps faketime \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && useradd -m -s /bin/bash walnut \
 && usermod -p '*' walnut \
 && mkdir -p /run/sshd /home/walnut/work \
 && chown walnut:walnut /home/walnut/work
COPY fleet-sshd.conf /etc/ssh/sshd_config.d/fleet.conf
COPY entrypoint.sh /usr/local/sbin/fleet-entrypoint
COPY mock-claude.cjs /usr/local/lib/fleet/mock-claude.cjs
RUN chmod 755 /usr/local/sbin/fleet-entrypoint \
 && chmod 644 /etc/ssh/sshd_config.d/fleet.conf /usr/local/lib/fleet/mock-claude.cjs \
 && printf '#!/bin/sh\nexec node /usr/local/lib/fleet/mock-claude.cjs "$@"\n' > /usr/local/bin/claude \
 && chmod 755 /usr/local/bin/claude
EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/fleet-entrypoint"]
