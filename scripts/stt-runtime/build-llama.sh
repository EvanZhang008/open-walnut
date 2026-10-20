#!/usr/bin/env bash
# Build llama-server for the Qwen3-ASR Linux engine, inside a manylinux_2_28 container
# (glibc 2.28), so the binary runs on any glibc >= 2.28: Amazon Linux 2023, Debian 11,
# Ubuntu 20.04 and newer. Upstream's own Linux builds need glibc 2.38.
#   usage: build-llama.sh <llama.cpp tag> <out dir> <target: linux-x64|linux-arm64>
set -euo pipefail
TAG=$1 OUT=$2 TARGET=$3
SRC=/tmp/llama.cpp BUILD=/tmp/llama-build STAGE=/tmp/stage/llama-server
git clone --quiet --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp "$SRC"
# BACKEND_DL + CPU_ALL_VARIANTS: one archive carries a CPU backend per instruction set
# and llama-server loads the best one for the machine at start.
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE=OFF -DGGML_BACKEND_DL=ON -DGGML_CPU_ALL_VARIANTS=ON \
  -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON -DCMAKE_INSTALL_RPATH='$ORIGIN' \
  -DCMAKE_EXE_LINKER_FLAGS='-static-libstdc++ -static-libgcc' \
  -DCMAKE_SHARED_LINKER_FLAGS='-static-libstdc++ -static-libgcc' >/dev/null
cmake --build "$BUILD" -j"$(nproc)" >/dev/null
mkdir -p "$STAGE"
cp "$BUILD/bin/llama-server" "$STAGE/"
cp -P "$BUILD"/bin/*.so* "$STAGE/" 2>/dev/null || true
find "$BUILD" -name '*.so*' -path '*/bin/*' -exec cp -Pn {} "$STAGE/" \;
# The CPU backends use OpenMP; its runtime is not on a minimal system, so it ships
# alongside them (the rpath is $ORIGIN).
# awk reads to the end: leaving early would SIGPIPE ldd under pipefail.
GOMP=$(ldd "$STAGE"/*.so* | awk '/libgomp\.so/ && !seen {print $3; seen=1}')
[ -f "$GOMP" ] || { echo "libgomp not found" >&2; exit 1; }
cp -L "$GOMP" "$STAGE/"
printf '%s\n' "$TAG" > "$STAGE/VERSION"
# The point of this build: nothing in it may need a glibc newer than 2.28.
NEED=$(objdump -T "$STAGE"/llama-server "$STAGE"/*.so* | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)
echo "highest glibc symbol: $NEED"
[ "$(printf '%s\nGLIBC_2.28\n' "$NEED" | sort -V | tail -1)" = GLIBC_2.28 ] || { echo "needs $NEED > 2.28" >&2; exit 1; }
"$STAGE/llama-server" --version
mkdir -p "$OUT"
ARCHIVE="llama-server-$TAG-$TARGET.tar.gz"
tar -C /tmp/stage -czf "$OUT/$ARCHIVE" llama-server
(cd "$OUT" && sha256sum "$ARCHIVE" > "$ARCHIVE.sha256")
cat "$OUT/$ARCHIVE.sha256"
