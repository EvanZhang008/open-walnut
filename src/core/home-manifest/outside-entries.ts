/**
 * State the server (or the daemon on its machine) keeps outside WALNUT_HOME. Each place
 * is kept out of the data home on purpose (git sync never carries it, a reboot does
 * not wipe it, or it is the engine's own), so a standby copy has to name it here.
 */
import { outside } from './build.js'
import type { OutsideEntry } from './types.js'

export const OUTSIDE_ENTRIES: readonly OutsideEntry[] = [
  // $XDG_STATE_HOME/open-walnut (default ~/.local/state).
  outside('leader-data', 'xdg-state', 'state.secrets-master', 'open-walnut/secrets-master', 'dir', 'Fleet secrets: the leader\'s master copy of every secret it shares with hosts', { sensitive: true }),
  outside('leader-data', 'xdg-state', 'state.vault', 'open-walnut/vault', 'dir', 'The password vault (vault.json and its side files)', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.vault.machine', 'open-walnut/vault/machine.json', 'file', 'This machine\'s key that opens the vault, and the retired keys of earlier vaults', { sensitive: true, match: /^open-walnut\/vault\/machine-[^/]+\.json$/ }),
  outside('machine', 'xdg-state', 'state.vault.sessions', 'open-walnut/vault/sessions.json', 'file', 'Vault unlock sessions on this machine', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.vault.browsers', 'open-walnut/vault/browsers.json', 'file', 'Keys of the browsers paired with this machine\'s vault', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.secrets', 'open-walnut/secrets', 'dir', 'This host\'s copy of the fleet secrets shared with it', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.tasks', 'open-walnut/tasks', 'dir', 'Task working folders of sessions that ran on this machine: on purpose, they belong to the host a session runs on, and a leader switch does not move sessions'),
  outside('machine', 'xdg-state', 'state.leader-instance', 'open-walnut/leader-instance', 'dir', 'The instance lock of a switchable leader: one leader server per machine id holds the write permission'),
  outside('machine', 'xdg-state', 'state.leader-witness', 'open-walnut/leader-witness', 'dir', 'The records this machine keeps as a witness of another machine\'s write permission (one per Walnut): a witness that lost its record never starts over, so it never travels with a copy'),
  outside('machine', 'xdg-state', 'state.approvals', 'open-walnut/approvals', 'dir', 'Wait tokens of approval asks made from this machine\'s shell', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.net', 'open-walnut/net', 'dir', 'This machine\'s host network identity (always under ~/.local/state)', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.console', 'open-walnut/console', 'dir', 'The console of this machine after it handed the leader over (always under ~/.local/state): the address its leader served, the switch and the console device\'s token, written at the handover; and which replica holds that address now', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.machine-id', 'open-walnut/machine-id', 'file', 'This machine\'s stable id (always under ~/.local/state): sent in the daemon\'s hello, and the holder id of a switchable leader\'s write permission'),
  outside('machine', 'xdg-state', 'state.host-credentials', 'open-walnut/host-credentials', 'dir', 'This host\'s door credential for each Walnut it serves (always under ~/.local/state, next to the machine id): the token it dials its leader\'s door with and the key that proves the leader', { sensitive: true }),
  outside('machine', 'xdg-state', 'state.net-members', 'open-walnut/net-members.json', 'file', 'The companion\'s list of machines allowed on the host network'),
  outside('machine', 'xdg-state', 'state.clone-identity', 'open-walnut/clone-identity', 'dir', 'Pending clone identity marks of this machine\'s sessions'),
  outside('machine', 'xdg-state', 'state.daemon-previous', 'open-walnut/daemon-previous', 'dir', 'The previous daemon build, kept for a rollback'),
  outside('machine', 'xdg-state', 'state.primary-daemon', 'open-walnut/primary-daemon', 'dir', 'The tunnel daemon of this machine'),
  // ~/.local/share/open-walnut.
  outside('machine', 'xdg-data', 'share.daemon', 'open-walnut/daemon', 'dir', 'The login service\'s daemon state and boot script'),
  outside('machine', 'xdg-data', 'share.daemon.service-mode', 'open-walnut/daemon/service-mode.json', 'file', 'Whose follower the login service runs as the host\'s one Walnut service, and for which version (written only by walnut daemon install or update)'),
  outside('rebuildable', 'xdg-data', 'share.bin', 'open-walnut/bin', 'dir', 'Voice input helper binaries, installed again on demand'),
  outside('rebuildable', 'xdg-data', 'share.stt-llama', 'open-walnut/stt-llama', 'dir', 'Local voice model runtime, installed again on demand'),
  outside('rebuildable', 'xdg-data', 'share.stt-mlx', 'open-walnut/stt-mlx', 'dir', 'Local voice model runtime, installed again on demand'),
  outside('rebuildable', 'xdg-data', 'share.tts-mlx', 'open-walnut/tts-mlx', 'dir', 'Local Chinese voice (text to speech) runtime, installed again on demand'),
  // The engine's own home: its data, never Walnut's.
  outside('machine', 'claude-home', 'claude', '', 'dir', 'The engine\'s own home on this machine'),
  outside('machine', 'claude-home', 'claude.projects', 'projects', 'dir', 'Engine transcripts (JSONL) of sessions that ran on this machine: on purpose, they belong to the host a session runs on, and a leader switch does not move sessions'),
  outside('machine', 'claude-home', 'claude.settings', 'settings.json', 'file', 'The engine\'s settings and enabled plugins'),
  outside('machine', 'claude-home', 'claude.skills', 'skills', 'dir', 'The engine\'s user skills'),
  outside('machine', 'claude-home', 'claude.plugins', 'plugins', 'dir', 'The engine\'s plugins and marketplaces'),
  outside('machine', 'claude-home', 'claude.credentials', '.credentials.json', 'file', 'The engine\'s subscription sign-in (Walnut only checks it exists)', { sensitive: true }),
  outside('machine', 'claude-home', 'claude.debug', 'debug', 'dir', 'The engine\'s debug logs'),
  // The runtime dir (LOG_DIR).
  outside('machine', 'daemon-dir', 'daemon-dir', '', 'dir', 'Runtime files: the local daemon\'s port, pid and registry'),
  outside('machine', 'daemon-dir', 'daemon-dir.stamp', 'daemon.stamp', 'file', 'The pid daemon.pid names and its start time, so a leader tells the daemon from a reused pid'),
  outside('rebuildable', 'daemon-dir', 'daemon-dir.logs', '', 'file', 'Server and browser logs', { match: /^open-walnut-[^/]+\.log$/ }),
  outside('machine', 'daemon-dir', 'daemon-dir.streams', 'streams', 'dir', 'Live session output streams'),
  outside('machine', 'daemon-dir', 'daemon-dir.term', 'term', 'dir', 'Terminal sockets'),
  outside('machine', 'daemon-dir', 'daemon-dir.images', 'images', 'dir', 'Images pasted or attached in sessions on this machine'),
  outside('machine', 'daemon-dir', 'daemon-dir.pastes', 'pastes', 'dir', 'Oversized pastes spilled to disk'),
  outside('machine', 'daemon-dir', 'daemon-dir.net', 'net', 'dir', 'Host network identity of a throwaway daemon'),
  // The account's home.
  outside('machine', 'user-home', 'home.machine-hold', '.config/walnut', 'dir', 'Machine holds that stop test runs here'),
  outside('machine', 'user-home', 'home.session-host-launch', 'Library/Application Support/Open Walnut', 'dir', 'How the Mac app launches the session host'),
  outside('machine', 'user-home', 'home.systemd-unit', '.config/systemd/user', 'dir', 'The daemon\'s login service unit on Linux'),
  outside('machine', 'user-home', 'home.launch-agents', 'Library/LaunchAgents', 'dir', 'The daemon\'s login service on macOS'),
  outside('machine', 'user-home', 'home.host-replica', '.open-walnut-host', 'dir', 'This machine\'s replicas of a Walnut led by another machine (walnuts/<id>/data, run, logs): the copies its leader sends and the program it runs. A machine that handed the leader over serves its console from here, never from the handed-over home'),
]
