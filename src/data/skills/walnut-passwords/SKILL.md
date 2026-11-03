---
name: walnut-passwords
description: >-
  Use a password, API key, one-time code or card from the user's Walnut password vault
  for a step you are doing: sign in to a site, call an API, run a CLI that needs a token,
  enter a 2FA code. Use it whenever a step needs a credential the user keeps, instead of
  asking them to paste it. `walnut pass run` gives a command its secrets as env vars
  without them entering your context; `password_use` returns values when you must type
  them yourself. Each use is the user's to approve unless the item allows agents.
---

# Passwords for agents

The user keeps logins, API keys, one-time codes and cards in Walnut's password vault. You
never open the vault yourself: you name an item and say why, and Walnut decides.

- An item the user set to **without asking** is given at once.
- An item set to **ask** (the default) sends the user a notification on their Mac and phone;
  they approve or deny it. A **sensitive** item needs Face ID or Touch ID.
- An item set to **never** is never given: ask the user to do that step themselves.
- The user can turn agent access off entirely. Every ask, use and refusal is logged where they
  see it (Passwords, Agent Activity).
- Never ask the user for their master password, Secret Key or recovery code, and never read
  their recovery kit: nothing an agent does needs them. A user who forgot the master password
  uses "Forgot master password?" on the Passwords lock screen with the kit's recovery code.
- The user's own browser fills and saves their logins with the Walnut browser extension
  (Chrome, Firefox): if they ask how, point them to Settings, Passwords, Browser extension.
  It is the user's: an agent never drives it or reads what it fills.

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
- **`scope: "task"` / `--task`** asks to use the item for an hour without asking again, in
  this session, for the fields you asked for. Ask for it only when the work will need the item
  several times, and ask for every field you will need in that first ask.
- **Never repeat a value** in a reply, a file, a commit, a log, a Board post or a message to
  another task. Use it for the step you named and nothing else.
- **Locked** (`vault_locked`): the vault opens only while the user has Passwords unlocked (or
  allowed agents while away). Tell the user in your reply; do not retry in a loop.
- **Off** (`agents_off`) or **never** (`agent_never`): the user decided. Ask them to do the
  step, or to change the setting if they want you to.
- Never ask the user to paste a password into the chat when the vault can hold it: suggest
  they add it in Passwords and set who may use it.
