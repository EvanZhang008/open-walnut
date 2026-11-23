# A Walnut host in a Kubernetes pod (docs/reference/kubernetes-hosts.md).
#
# The image holds only the operating system and the tools a session needs. Walnut itself,
# Claude Code, the host's network key and every session's history live in the user's home,
# which the pod mounts from a persistent volume: the first start joins the user's host network
# with an invite and installs Walnut there, and every later start runs what that volume holds.
# A new image never resets a host, and Walnut keeps the install up to date over its own link.
#
# Why cron: `walnut daemon install` keeps the daemon running with a systemd user unit, else
# with a cron @reboot line (src/providers/daemon-service-cron.ts). A container has no systemd,
# so cron is the container's main process and the crontab directory lives on the volume.
#
#   docker build -t walnut-host infra/kubernetes
FROM docker.io/library/debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# cron and procps (pgrep) are what the daemon's cron backend checks for; tini reaps the
# processes the daemon leaves to PID 1; dtach keeps the in-app terminal's shells.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates cron curl dtach git iproute2 jq less openssh-client procps \
      python3 ripgrep tini unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Debian's cron opens a PAM session per job; pam_loginuid fails in a container (no audit
# login uid to set), and with it every job, the daemon's @reboot line included.
RUN sed -i 's/^\(session[[:space:]]\+required[[:space:]]\+pam_loginuid\.so\)/# \1/' /etc/pam.d/cron

# The person Walnut runs as. Its home is the volume; /etc/skel fills a new one.
ARG WALNUT_UID=1000
RUN useradd --uid "${WALNUT_UID}" --create-home --shell /bin/bash walnut \
 && printf '%s\n' '' '# Walnut installs its commands here.' 'case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac' \
      >> /etc/skel/.profile

COPY entrypoint.sh /usr/local/bin/walnut-pod-entrypoint
RUN chmod 0755 /usr/local/bin/walnut-pod-entrypoint

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/walnut-pod-entrypoint"]
