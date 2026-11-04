---
name: walnut-passwords
description: >-
  Use a password, API key, one-time code or card from the user's Walnut password vault
  for a step you are doing: sign in to a site, call an API, run a CLI that needs a token,
  enter a 2FA code. Use it whenever a step needs a credential the user keeps, instead of
  asking them to paste it. `walnut pass run` gives a command its secrets as env vars
  without them entering your context; `password_use` returns values when you must type
  them yourself. The user picks whether agents use items at once (Any, the default), ask
  each time (Ask) or not at all (Off); a sensitive item always asks.
---

# Passwords for agents

The user keeps logins, API keys, one-time codes and cards in Walnut's password vault. You
never open the vault yourself: you name an item and say why, and Walnut decides.

- The user's switch is **Any** (the default: an item is given at once), **Ask** (every use
  sends the user a notification on their Mac and phone to approve or deny) or **Off** (you list
  nothing; an ask that names one item still reaches the user). An item set to **without asking**
  is given under Ask too.
- A **sensitive** item always asks, with Face ID or Touch ID.
- An item set to **never** is never given: ask the user to do that step themselves.
- A yes lasts as long as the user picked (48 hours by default, or once, or until they revoke
  it), for this task and session and the fields you asked for.
- Every list, use and refusal is logged where the user sees it (Passwords, Agent Activity),
  with how you used it: showed plaintext, gave it to a command, filled it into a page.
- Never ask the user for their master password, Secret Key or recovery code, and never read
  their recovery kit: nothing an agent does needs them. A user who forgot the master password
  uses "Forgot master password?" on the Passwords lock screen with the kit's recovery code.
- The user's own browser fills and saves their logins with the Walnut browser extension
  (Chrome, Firefox): if they ask how, point them to Settings, Browser extension.
  An agent never reads what it fills. Agents may work in tabs of their own in that browser
  when the user turns it on (skill `walnut-browser`).

## Pick the right way

| You need | Use |
| --- | --- |
| A command that reads a token from the environment (gh, aws, stripe, curl, a deploy script) | `walnut pass run --purpose "<why>" --env NAME=<item> -- <command>` |
| To see what you may ask for | `walnut pass list [words]` or `password_list` |
| A value you must type yourself (a browser login, a form) | `password_use`, then `password_wait` while it is pending |
| The current 2FA code | `password_use` with `fields: ["totp"]` |

`walnut pass run` is the default for anything a command reads: the secret goes into the
command's environment and every occurrence of it in the command's output (also URL-encoded,
JSON-escaped or inside base64) is replaced with `********`, so it never reaches your context,
the transcript or a log. `password_use` and `walnut pass get` print the value itself, which
then stays in your session's transcript: use them only for a value you must type yourself.

```bash
# An API key item that names its own env var (STRIPE_API_KEY):
walnut pass run --purpose "run the billing tests against the test account" --env "Stripe test key" -- npm test

# A login's password under the name the tool wants, and its username too:
walnut pass run --purpose "push the release tag" \
  --env GH_TOKEN=github.com --env GH_USER=github.com:username -- ./release.sh

# One value on stdout (only when a command cannot read the environment):
walnut pass get "Example Git" --purpose "sign in to the test server" --field username
```

An item is named by its id (from `walnut pass list`), its exact name, a site (`github.com`) or
an API key's env var name. More than one match is refused with the candidates: ask again with
the id.

## Rules

- **Say why in `purpose`**, in words the user reads on their phone before approving: what you
  will do and where ("sign in to git.example.com to merge PR 12"), never "need password".
- **Ask once and wait.** A pending ask waits up to ten minutes for the user. Do not ask again
  for the same item meanwhile; `walnut pass` waits for you, and `password_wait` holds 12 s per
  call.
- **A denial means no.** Do not ask again in this task unless the user tells you to; after
  three denials the task's asks pause for 30 minutes (`agent_paused`).
- **One ask covers the work.** An approval lasts the user's grant length (48 hours by default)
  for this task and session and the fields you asked for, so ask for every field you will need
  in that first ask. Ask for less with `scope: "once"` / `--once` when you need it one time.
- **Say how you use it**: `password_use` with `use: "reveal"` (you see the value) or
  `use: "env"` (a command gets it); `walnut pass get` and `run` say so for you.
- **Never repeat a value** in a reply, a file, a commit, a log, a Board post or a message to
  another task. Use it for the step you named and nothing else.
- **Locked** (`vault_locked`): the vault opens only while the user has Passwords unlocked (or
  allowed agents while away). Tell the user in your reply; do not retry in a loop.
- **Never** (`agent_never`), a denial, or a sync refused while access is Off (`agents_off`):
  the user decided. Ask them to do the step, or to change the setting if they want you to.
- Never ask the user to paste a password into the chat when the vault can hold it: suggest
  they add it in Passwords and set who may use it.
- **Bitwarden.** The vault can follow the user's Bitwarden one way (Settings, Passwords, "Sync
  from Bitwarden daily" or "Sync now"). If the user asks you to sync it now: `walnut pass
  sync-bitwarden` (or the op `password_sync_bitwarden`). Walnut runs `bw` itself on the Mac and
  the export never reaches you; you never pipe or post an export (only the user's own unlocked
  window may, `export_person_only`). Never run `bw export` yourself. A refused mass trash
  (`sync_mass_trash`) is the user's to confirm in Settings.
