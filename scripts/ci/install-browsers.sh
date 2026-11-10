#!/usr/bin/env bash
# Installs Playwright's browsers and their system packages on a CI runner: bun x playwright
# install --with-deps <browsers>, bounded. Its apt reaches the runner's mirror, which can stall a
# fetch with no output (run 42763058265: a leg sat 58 minutes in apt-get update until the job's
# limit cancelled it) or crawl (a gate run took 8 minutes for 180 packages). So apt gives up on a
# stalled connection and tries it again itself, each try of the whole install is bounded, and a
# try killed mid-way waits for its apt-get to let go of dpkg's lock before the next one.
# Guard: tests/scripts/ci-playwright-install.test.ts.
set -u
[ "$#" -gt 0 ] || { echo "usage: install-browsers.sh <browser>..." >&2; exit 2; }
sudo tee /etc/apt/apt.conf.d/99-ci-network >/dev/null <<'CONF'
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
Acquire::Retries "5";
CONF
for try in 1 2; do
  timeout 900 bun x playwright install --with-deps "$@" && exit 0
  echo "::warning::playwright install try $try did not finish"
  # timeout ends bun, not the apt-get it started as root: wait until dpkg's lock is free.
  for _ in $(seq 60); do
    sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1 || break
    sleep 5
  done
done
exit 1
