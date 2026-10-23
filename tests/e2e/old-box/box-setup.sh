#!/bin/bash
# Lays out a cloud companion box the way v0.6.17 left one, then runs its
# service (supervise.sh). Run as root, the container's first process.
#
#   /opt/walnut                     root's code tree (setup.sh step 7), with the
#                                   v0.6.17 launcher (ensure-harness.sh's drop-in)
#   /var/lib/walnut/.open-walnut    the data dir, a clone of the hub
#   /var/lib/walnut/git             the hub
#   /var/lib/walnut/.open-walnut-host
#     app/<id>  deps/<hash>         the build a Mac on v0.6.17 installed
#     companion/current             naming it
#
# Inputs, read-only: /rel/release.tgz (the v0.6.17 Linux archive), and under
# /in companion-launch.mjs (v0.6.17's launcher), auth.json (the Mac's machine
# credential), walnut.env (the unit's EnvironmentFile). OLD_ID names the build.
set -euo pipefail
LIB=/var/lib/walnut
R="$LIB/.open-walnut-host"
DATA="$LIB/.open-walnut"
HUB="$LIB/git/walnut-data.git"
: "${OLD_ID:?OLD_ID names the v0.6.17 build}"
say() { printf '[box-setup] %s\n' "$*"; }
as_walnut() { setpriv --reuid=walnut --regid=walnut --init-groups -- env HOME="$LIB" PATH=/usr/local/bin:/usr/bin:/bin "$@"; }

say "node 22 from the v0.6.17 archive (setup.sh installs a system Node 22)"
mkdir -p /opt/rel
tar -xzf /rel/release.tgz -C /opt/rel --strip-components=1
# A file, not a link: Node names its real path as process.execPath, and the
# launcher starts the build with that.
install -m 755 /opt/rel/runtime/bin/node /usr/local/bin/node
ln -sf /opt/rel/runtime/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
PKG=/opt/rel/runtime/lib/node_modules/open-walnut

say "root's code tree /opt/walnut (npm ci, npm run build)"
mkdir -p /opt/walnut/scripts/cloud
cp -al "$PKG/dist" "$PKG/node_modules" /opt/walnut/
cp "$PKG/package.json" /opt/walnut/package.json
cp /in/companion-launch.mjs /opt/walnut/scripts/cloud/companion-launch.mjs
chown -R root:root /opt/walnut
chmod -R a+rX,go-w /opt/walnut

say "the hub and the data dir"
as_walnut git config --global user.name walnut
as_walnut git config --global user.email walnut@localhost
mkdir -p "$LIB/git" && chown walnut:walnut "$LIB/git"
as_walnut git init -q --bare -b main "$HUB"
as_walnut git clone -q "$HUB" "$DATA" 2>/dev/null
as_walnut git -C "$DATA" checkout -q -B main
as_walnut git -C "$DATA" commit -q --allow-empty -m "walnut data hub init"
as_walnut git -C "$DATA" push -q -u origin main
printf 'version: 1\nuser:\n  name: Box\n' > "$DATA/config.yaml"
install -m 600 /in/auth.json "$DATA/auth.json"
chown walnut:walnut "$DATA/config.yaml" "$DATA/auth.json"
mkdir -p /etc/walnut/claim && chmod 700 /etc/walnut
install -m 600 /in/walnut.env /etc/walnut/walnut.env

say "the build a Mac on v0.6.17 installed: $OLD_ID"
DEPS="$(printf '%s' "$OLD_ID" | sha256sum | cut -c1-16)"
mkdir -p "$R/deps/$DEPS" "$R/app/$OLD_ID" "$R/companion" "$R/incoming" "$R/data"
cp -a "$PKG/node_modules" "$R/deps/$DEPS/node_modules"
touch "$R/deps/$DEPS/.ready"
cp -a "$PKG/dist" "$R/app/$OLD_ID/dist"
cp "$PKG/package.json" "$R/app/$OLD_ID/package.json"
ln -s "../../deps/$DEPS/node_modules" "$R/app/$OLD_ID/node_modules"
touch "$R/app/$OLD_ID/.ready"
printf '%s\n' "$OLD_ID" > "$R/companion/current"
chown -R walnut:walnut "$R"

say "ready; starting walnut.service"
exec /bin/bash /box/supervise.sh
