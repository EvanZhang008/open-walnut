# Installs ffmpeg on a GitHub Windows runner, for the screen recordings of the Windows jobs
# (windows-join.yml, windows-app.yml). Chocolatey's feed fails now and then and says only
# "installed 0/0 packages", with a success exit (2026-11-24, Windows join runs 45332962850 and
# 45343305227: the next step could not start ffmpeg, so the join was never tried). So: try
# again, then check. A recording is a run's evidence, not its check: when ffmpeg is still
# missing, this says so as a warning and the run goes on without one (the callers start ffmpeg
# only when it is there).
for ($i = 1; $i -le 3 -and -not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue); $i++) {
  choco install ffmpeg --no-progress -y | Select-Object -Last 3
  if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) { Start-Sleep (15 * $i) }
}
if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
  '::warning::ffmpeg could not be installed: this run records no screen'
}
exit 0
