# Clean-room "second machine" for Open Walnut: a Linux dev box that Walnut has
# never seen, reached over real ssh, that Walnut must provision by itself.
#
# It copies the dev box that broke three things at once for a new user:
#   - no C compiler (gcc/cc/clang), so the terminal's dtach cannot be built;
#   - no node or npm anywhere, so an npm-installed `claude` cannot start;
#   - `claude` is the npm build: ~/.local/bin/claude links to a cli.js whose
#     shebang is `#!/usr/bin/env node`, and it fails with
#     `env: 'node': No such file or directory`, like the real one;
#   - ~/workplace is a symlink to /workplace (next to a real ~/workspace dir).
#
# Deliberately absent: Bun. Installing the daemon runtime on a bare host (the
# `install-runtime` connect step, `curl https://bun.sh/install | bash`) is part
# of what is under test, so it must happen for real, from inside the container.
#
# No key is baked in. The runner (run.sh) generates a throwaway key pair per run
# and passes the PUBLIC key in WALNUT_ONBOARDING_AUTHORIZED_KEY; entrypoint.sh
# writes it and generates fresh host keys at start.
#
# Ratchet: tests/scripts/remote-host-onboarding-ratchet.test.ts
#
# Pinned to the multi-arch index digest (amd64 for CI, arm64 for Apple Silicon)
# so a re-tagged ubuntu:24.04 cannot change the fixture under a PR. To bump:
#   docker buildx imagetools inspect ubuntu:24.04    # the "Digest:" line
# The digest names the bytes, so any registry that holds it gives the same image:
# run.sh moves to a public mirror of Docker Hub's library when Docker Hub refuses
# (its anonymous pull limit counts a hosted runner's shared address).
ARG BASE_REGISTRY=docker.io/library
FROM ${BASE_REGISTRY}/ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

ENV DEBIAN_FRONTEND=noninteractive

# --no-install-recommends matters: recommends are how a compiler sneaks in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server curl unzip ca-certificates git bash coreutils procps sudo \
 && rm -rf /var/lib/apt/lists/*

# Fail the BUILD if the image ever gains what the real dev box lacks. A fixture
# that quietly grew gcc or node would turn every assertion below into a lie.
RUN for tool in gcc cc clang tcc node nodejs npm bun; do \
      if command -v "$tool" >/dev/null 2>&1; then \
        echo "fixture invariant broken: $tool is installed ($(command -v "$tool"))" >&2; exit 1; \
      fi; \
    done

# alice: a normal login user. '*' means "no password" without the '!' lock
# prefix, which some sshd builds treat as "account locked" even for key auth.
# sudo is installed but alice has no sudoers entry and no usable password, like
# a dev box whose user cannot sudo without asking: `sudo -n` answers "a password
# is required", which is what an automatic gcc install must report.
RUN useradd --create-home --shell /bin/bash alice \
 && usermod -p '*' alice

# The folder-picker shape: /workplace holds the projects, ~/workplace points at
# it, and ~/workspace is an ordinary directory beside it.
RUN mkdir -p /workplace/proj-a /workplace/proj-b /home/alice/workspace \
 && chown -R alice:alice /workplace /home/alice/workspace \
 && ln -s /workplace /home/alice/workplace \
 && chown -h alice:alice /home/alice/workplace

# The npm build of Claude Code, laid out the way `npm install -g` with prefix
# ~/.local lays it out: a bin symlink into lib/node_modules.
COPY fixture/claude-cli.js /home/alice/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js
COPY fixture/claude-package.json /home/alice/.local/lib/node_modules/@anthropic-ai/claude-code/package.json
RUN mkdir -p /home/alice/.local/bin \
 && chmod 0755 /home/alice/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js \
 && ln -s ../lib/node_modules/@anthropic-ai/claude-code/cli.js /home/alice/.local/bin/claude \
 && chown -R alice:alice /home/alice

# sshd: public-key auth only, keys from a root-owned per-user file.
COPY sshd-onboarding.conf /etc/ssh/sshd_config.d/10-walnut-onboarding.conf
# pam_loginuid cannot write /proc/self/loginuid in an unprivileged container,
# and as `required` it would close every session right after auth.
RUN sed -i 's/^session\s\+required\s\+pam_loginuid\.so/session optional pam_loginuid.so/' /etc/pam.d/sshd \
 && rm -f /etc/ssh/ssh_host_*

# Tells the live test it is talking to this fixture and not to a real machine.
RUN echo walnut-onboarding-remote-host > /etc/walnut-onboarding-fixture

COPY entrypoint.sh /usr/local/sbin/walnut-onboarding-entrypoint
RUN chmod 0755 /usr/local/sbin/walnut-onboarding-entrypoint

EXPOSE 22
ENTRYPOINT ["/usr/local/sbin/walnut-onboarding-entrypoint"]
