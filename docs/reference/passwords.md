# Passwords

Walnut keeps a password vault on the machine that runs the Walnut server (the Mac, the
leader). The web console and the Mac app have a Passwords app; the browser extension, the
iPhone app and agents come in later steps and use the same vault.

Code: `src/core/vault/` (crypto, store, sessions, generator, TOTP, site matching, import,
export), `src/web/routes/vault-v1.ts`, `web/src/components/passwords/`,
`web/src/components/settings/sections/PasswordsSection.tsx`.

## Where it lives

`$XDG_STATE_HOME/open-walnut/vault/` (default `~/.local/state/open-walnut/vault/`), outside
the git-synced data home, like the fleet secrets master. A throwaway server (tests, an
ephemeral server, a data home in a temp or task dir, a fake HOME) keeps its own vault in
`<data home>/vault` and never opens the real one. `WALNUT_VAULT_DIR` (absolute) overrides both.

| File | Holds |
| --- | --- |
| `vault.json` | ciphertext only: the KDF parameters, the wrapped vault key, every item sealed |
| `machine.json` (0600) | the Secret Key, and the machine key while "agents may ask while you are away" is on |
| `backups/vault-<date>.json` | the previous `vault.json`, one per day, newest 14 |

## Keys

All AES-256-GCM with a fresh 12-byte nonce and an additional-data label naming what each
ciphertext is (`walnut-vault:<vault id>:item:<item id>` and so on), WebCrypto only, so the
server, the web app and the extension run the same code.

- **Item key**: 32 random bytes per item, made new on every write, encrypting the item's JSON.
- **Vault key**: 32 random bytes, wrapping every item key.
- **Account unlock key**: the vault key's first wrap. Two secrets, as in 1Password:
  `pwKey = PBKDF2-HMAC-SHA256(master password NFKC, salt, 650,000)`, then
  `AUK = HKDF-SHA256(pwKey || Secret Key, aukSalt, "walnut-vault-auk-v1")`. The client derives
  `pwKey` where the password is typed, so the master password itself never crosses the wire
  (a page with no WebCrypto, plain http from another device, sends the password and the
  server derives it). The Secret Key is 128 random bits, shown once at setup as
  `W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX` and saved in the recovery kit.
- **Machine key**: the vault key's second wrap, so the server can open the vault after a
  restart and serve an agent request the person approves from the phone while no window is
  unlocked. Off by default. Turning it on or off asks for the master password again, and
  Settings says what it costs: any program running as the person on this Mac can then read
  `machine.json` and open the vault without the master password. While it is off the server
  holds the vault key only while some window has Passwords unlocked; when the last one locks
  or goes idle, the key goes.

A copy of `vault.json` alone (a backup, a stolen disk image without `machine.json`) needs
both the master password and the Secret Key. A process that reads both files without the
machine key can still try master passwords offline at PBKDF2's pace, as with any local
password manager that keeps its Secret Key on the device.

A new master password, and turning the machine key off, make a new vault key and wrap every
item key again under it (the items' own ciphertext stays), and the sealed side files are
sealed again. So an old password with an old backup, or a machine key copied earlier, opens
nothing written since. A new master password also locks every other window.

The Secret Key is shown at setup, and again for the master password in Settings → Passwords
(Download recovery kit).

## Unlocking

The vault being open on the server is not a person's unlock. Every item read or write
through the API carries a vault session (`x-walnut-vault-session`) that only the master
password buys (`POST /api/v1/vault/unlock`). Sessions live in memory: a restart locks every
window. A session ends after `passwords.auto_lock_minutes` unused (default 15), after 12
hours whatever happens, or on Lock / Lock all; the one-time code refreshing by itself does
not count as use. Wrong passwords: five free, then each try waits twice as long as the last
(30 s up to an hour). Every check of the master password counts (unlock, export, a new
password, the Secret Key, the machine key switch), and only one runs at a time, so a burst of
parallel guesses is refused rather than checked. An export asks for the master password again.
A window that read the KDF before another one changed the master password is told
`kdf_changed` and reads it again, instead of being charged a wrong password.

The typed master password crosses the wire only from a page with no WebCrypto, and only over
this machine, https or Tailscale; plain http on a shared network is refused.

## Who may open it

A person only: no session caller (`x-walnut-caller-sid`), no CLI automation mark, this
machine or a paired device, the approvals rule. Agents never get a vault session; they use
the vault through their own ops, each use gated by the item's agent access and a person's
approval. A test run may read the status and nothing else. The cloud companion never carries
these calls (`/vault` is in its kept routes, `src/web/v1-forward/policy.ts`), because it
would see them in the clear between its TLS and the bridge, and a follower answers
`vault_not_here`. No vault answer is kept in the applied-ops ledger, a plain file kept for
days, and none is answered from it (`SECRET_ROUTE_RE` in `src/web/middleware/op-id.ts`).

## Writes

Every change works on copies of the file and the items and replaces the in-memory state only
after the write succeeded, so a full disk leaves memory and disk the same. Each write is a temp
file, fsync and rename; the previous `vault.json` is kept once a day in `backups/`. A
`vault.json` put back by hand (a backup restored) is read again. When a server keeps its vault
in the data home (a throwaway server), git sync never carries it (`/vault/` in its ignores).

## Items

Types: login, secure note, card, API key (with the env var a command gets it as), identity
(later). Every item has favorites, tags, custom fields (hidden or not), notes, password
history (the last 20 passwords with when each was replaced), trash (purged after 30 days),
`agentAccess` (`never`, `ask`, `allow`) and `sensitive` (an agent's use needs Face ID or
Touch ID). Sites are normalized at save (`github.com` becomes `https://github.com`) and
matched by registrable domain with the public suffix list, private suffixes included, so two
`github.io` sites never match each other and an https login never fills an http page.

Import (dry run first, duplicates skipped): Bitwarden JSON (passkeys kept as they came) and
CSV, 1Password CSV, Apple Passwords CSV, Chrome CSV, Firefox CSV. Export: CSV with
Bitwarden's columns, or Walnut JSON.

The security check (weak, reused, not changed in a year, saved for plain http) runs on this
machine; no password or site leaves it.
