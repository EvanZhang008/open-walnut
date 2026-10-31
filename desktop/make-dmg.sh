#!/bin/bash
# make_dmg <volume name> <source folder> <out.dmg>: a compressed (UDZO) DMG of the
# folder. Sourced by build-release.sh.
#
# hdiutil sizes the image from its own estimate of the folder, and that estimate
# is sometimes short: 2026-10-31, the arm64 app of 0.6.21 failed with "hdiutil:
# create failed - No space left on device" on a runner with gigabytes free, after
# the app was signed and notarized, and the x64 build of the same release passed.
# The image is sized from `du` with room to spare, and a failed create is tried
# again (a busy disk image service fails the same way: "Resource busy").
MAKE_DMG_TRIES=${MAKE_DMG_TRIES:-3}
MAKE_DMG_RETRY_SECS=${MAKE_DMG_RETRY_SECS:-10}

make_dmg() {
    local volname=$1 src=$2 out=$3
    local kb size_mb try=1 err
    kb=$(du -sk "$src" | cut -f1)
    # A quarter more than the files, and at least 50 MB more: the filesystem's own space.
    size_mb=$(( kb * 5 / 4 / 1024 + 50 ))
    err=$(mktemp)
    while :; do
        rm -f "$out"
        if hdiutil create -volname "$volname" -srcfolder "$src" -size "${size_mb}m" \
            -ov -format UDZO "$out" > /dev/null 2> "$err"; then
            rm -f "$err"
            return 0
        fi
        echo "make_dmg: try $try of $MAKE_DMG_TRIES failed: $(tr '\n' ' ' < "$err")" >&2
        if [ "$try" -ge "$MAKE_DMG_TRIES" ]; then
            echo "make_dmg: the folder holds ${kb} KB, the image was ${size_mb} MB; free space:" >&2
            df -h "$(dirname "$out")" >&2 || true
            rm -f "$err"
            return 1
        fi
        try=$((try + 1))
        size_mb=$(( size_mb * 3 / 2 ))
        sleep "$MAKE_DMG_RETRY_SECS"
    done
}
