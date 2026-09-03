#!/bin/bash
# Turn one onboarding run into a single mp4: the terminal recording (asciinema .cast →
# agg gif → h264) followed by the browser capture(s) of the first-run page.
#
#   render-video.sh <run-dir> <target>
#
# Long idle stretches (npm install, the build) are clipped to 2s so a 10-minute
# install reads as a 60-90s story. Needs: agg (brew install agg), ffmpeg.

set -uo pipefail
RUN_DIR="${1:?run dir}"; TARGET="${2:-onboarding}"
cd "$RUN_DIR" || exit 1
command -v agg >/dev/null || { echo "render: agg missing (brew install agg); keeping terminal.cast only"; exit 0; }
command -v ffmpeg >/dev/null || { echo "render: ffmpeg missing; keeping terminal.cast only"; exit 0; }
[ -s terminal.cast ] || { echo "render: no terminal.cast in $RUN_DIR"; exit 0; }

echo "render: terminal.cast → terminal.gif"
agg --idle-time-limit 2 --speed "${WALNUT_ONB_VIDEO_SPEED:-1.5}" --font-size 16 --theme monokai --cols 120 --rows 36 terminal.cast terminal.gif >/dev/null 2>&1 \
  || { echo "render: agg failed"; exit 0; }

echo "render: terminal.gif → terminal.mp4"
ffmpeg -y -loglevel error -i terminal.gif -vf 'scale=1280:800:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0x272822,format=yuv420p' \
  -c:v libx264 -preset veryfast -crf 22 -r 30 -movflags +faststart terminal.mp4 || { echo "render: ffmpeg gif→mp4 failed"; exit 0; }

# Concatenate terminal + every browser clip that exists, all normalized to 1280x800@30.
: > concat.txt
for clip in terminal.mp4 browser-readme.mp4 browser-npm.mp4; do
  [ -s "$clip" ] || continue
  norm="norm-$clip"
  ffmpeg -y -loglevel error -i "$clip" -vf 'scale=1280:800:force_original_aspect_ratio=decrease,pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p' \
    -r 30 -c:v libx264 -preset veryfast -crf 22 -an "$norm" && printf "file '%s'\n" "$norm" >> concat.txt
done
OUT="onboarding-$TARGET.mp4"
ffmpeg -y -loglevel error -f concat -safe 0 -i concat.txt -c copy -movflags +faststart "$OUT" || { echo "render: concat failed"; exit 0; }
rm -f norm-*.mp4 concat.txt
echo "render: wrote $RUN_DIR/$OUT ($(du -h "$OUT" | cut -f1), $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null | cut -d. -f1)s)"
