#!/bin/sh
# Rehearsal (b): what the other machine has, read only (real-world.ts judges it before anything runs there):
#
#   ssh <host> sh -s -- <root> < scripts/leader-switch/real/preflight.sh
#
# One `key=value` per line: the machine, its cores and load, its free memory and disk where <root> would be, its C
# library, whether <root> exists, and its clock (ms) for the skew.
set -u
ROOT=${1:-}
ROOT=${ROOT%/}
# The free disk where <root> will be: its nearest folder that exists.
parent=$(dirname "$ROOT")
while [ ! -d "$parent" ] && [ "$parent" != / ]; do parent=$(dirname "$parent"); done
echo "hostname=$(hostname)"
echo "user=$(id -un)"
echo "uid=$(id -u)"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
echo "nproc=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)"
echo "load1=$(cut -d' ' -f1 /proc/loadavg)"
echo "mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
echo "disk_at=$parent"
echo "disk_avail_kb=$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 {print $4}')"
echo "glibc=$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}')"
echo "tar=$(command -v tar)"
echo "root_exists=$([ -e "$ROOT" ] && echo yes || echo no)"
echo "now_ms=$(date +%s%3N)"
