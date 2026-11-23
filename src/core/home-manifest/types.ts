/**
 * The shape of the data-location manifest (src/core/home-manifest/): one entry per
 * place the server keeps state, with the class that says what a standby copy of the
 * leader does with it. Pure types, no I/O.
 */

/**
 * - `leader-data`: belongs to this Walnut and moves with the leader (a standby copies it).
 * - `machine`: belongs to this machine; copying it to another one would be wrong
 *   (a lock, a writer id, a key bound to this machine, a pid or a port).
 * - `rebuildable`: not needed on the other side: derived, cached or disposable;
 *   the other side rebuilds it or does without.
 */
export type DataClass = 'leader-data' | 'machine' | 'rebuildable'

/** A sqlite entry implies its `-wal`, `-shm` and `-journal` siblings. */
export type DataKind = 'file' | 'dir' | 'sqlite'

interface EntryBase {
  /** Stable id: never reuse one for another place. */
  id: string
  kind: DataKind
  class: DataClass
  /** Credentials, tokens, keys, the password vault. */
  sensitive: boolean
  /** One plain English line. */
  what: string
  /** Names this entry also owns, tested against the whole relative path (a family of files). */
  match?: RegExp
  /**
   * A place only an older release wrote. Old data may still sit there, so it keeps its class,
   * but no doc names it (tests/core/artifacts/legacy-places-ratchet.test.ts).
   */
  legacy?: true
}

/** A place under WALNUT_HOME. */
export interface HomeEntry extends EntryBase {
  /** Relative to WALNUT_HOME, '/'-separated, no leading or trailing slash. */
  path: string
  /**
   * A dir that mixes classes (cache/, local/, sync/, tmp/): every child the code names has
   * an entry of its own (the source ratchet enforces it); this entry's class covers only
   * files the code does not name.
   */
  listsChildren?: true
  /**
   * A file that only ever grows: written by appending, never cut, rewritten or replaced in
   * place. The standby copy takes such a file up to its size at the batch's moment
   * (src/core/standby/append-only.ts). Set only after reading every writer of it.
   */
  appendOnly?: true
  /**
   * This machine's daemon writes here as it runs, whichever home leads (an installed daemon keeps
   * its state in the data home's tmp/ and local/, daemon-standalone.ts and daemon-source.ts). On
   * `machine` entries, and on `rebuildable` ones the running daemon writes (its host server's
   * install, plugin job bundles). A home that handed the leader over keeps every other path of its
   * leader data and machine data byte for byte; these go on changing (home-kept.ts skips them and
   * says so), and a switch's promotion is to leave them where they are.
   * Backups and the standby copy never read it: they decide by their own rules and by the class,
   * as before (tests/core/home-manifest/daemon-state.test.ts).
   */
  daemonState?: true
}

/**
 * Roots outside WALNUT_HOME:
 * - `xdg-state`: `$XDG_STATE_HOME`, else `~/.local/state`
 * - `xdg-data`: `~/.local/share`
 * - `claude-home`: the engine's own `~/.claude`
 * - `daemon-dir`: the runtime dir (LOG_DIR: `/tmp/open-walnut`, or `~/.cache/open-walnut`)
 * - `user-home`: the account's home dir
 */
export type OutsideRoot = 'xdg-state' | 'xdg-data' | 'claude-home' | 'daemon-dir' | 'user-home'

export interface OutsideEntry extends EntryBase {
  root: OutsideRoot
  /** Relative to the root, '/'-separated; '' is the root itself. */
  path: string
}

export type DataEntry = HomeEntry | OutsideEntry
