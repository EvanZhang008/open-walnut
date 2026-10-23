# A cloud companion box as scripts/cloud/setup.sh of v0.6.17 left one, before the
# compiled walnut file: Debian, git, procps, the walnut service user. Node, the
# code tree and the Mac's build come from the v0.6.17 release archive that
# tests/e2e/companion-old-box-e2e.test.ts mounts, laid out by box-setup.sh.
# Built with no context: docker build -t <tag> - < Dockerfile
FROM debian:12
RUN apt-get update \
 && apt-get install -y --no-install-recommends git procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# setup.sh: a system account whose home holds the data, the hub and the builds.
RUN useradd --system --home-dir /var/lib/walnut --create-home --shell /usr/sbin/nologin walnut
