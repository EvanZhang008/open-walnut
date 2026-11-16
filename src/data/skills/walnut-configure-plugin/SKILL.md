---
name: walnut-configure-plugin
description: Configure any Walnut plugin by talking with the user, from any chat, the same way its page in Apps does. Use whenever someone asks to set up, configure, change or check a plugin's settings ("configure coderelay", "change the Slack plugin's channels", "set the mail poll interval to 5 minutes"), or a plugin waits for required settings.
---

# Configure a plugin

Every plugin's settings are read and changed with two ops, whatever the plugin is. They work from any chat (Main, a VP, a task, the "Configure with AI" chat on a plugin's page) and change the same settings the plugin's page shows, so the page shows the change at once.

| Op | What |
|---|---|
| `plugin_settings` | No arguments: every running plugin, one line each. `{"plugin":"<id or name>"}`: each setting with its label, help, type, allowed values (`enum`, `minimum`, `maximum`, `items`, `properties`), whether it is required or a secret, its value now (secrets masked), and the plugin's `page`. |
| `plugin_settings_set` | `{"plugin":"<id>","set":{"<key>":<value>},"unset":["<key>"]}`: checked against what the plugin declares, all or nothing. Answers `changes` (each `from` and `to`), `unchanged`, and what it refused (`refused`, `needsPerson`). |

## The way to do it

1. **Find the plugin.** `plugin_settings` without arguments when the name is unclear. A plugin that is off is not in the list: tell the person to turn it on on its page in Apps (`/apps`), then configure it.
2. **Read its settings.** `plugin_settings {"plugin":"<id>"}`. Match what the person asked to a setting by its label and help, not by guessing a key.
3. **Say what you will change, in one sentence, before you change it**: "I'll set Poll interval from 10 to 5 minutes." When the request is unclear (which channel? which model?), ask first.
4. **Change it.** `plugin_settings_set`. A list or an object is replaced whole: send the value you read with your edit in it (add one endpoint by sending the list with the new entry appended). A secret read back masked may stay in what you send as it is; it is kept.
5. **Report each setting that changed** from the answer's `changes`, in the person's words: "Done: Poll interval is now 5 minutes (was 10)." When nothing changed, say so.

## Secrets, sign-ins and money

- **Never type, guess or make up a secret** (an API key, a token, a password, a client secret). A setting marked `secret`, or a change that adds one inside a list or object, comes back in `needsPerson` and nothing is written. Tell the person which field to fill in and where: the plugin's page in Apps (`page`), or the plugin's own App when `settingsIn` is `app`. Then set the rest of what they asked.
- **A sign-in** (`signIn: true`) is done by the person on the plugin's page (its Sign in button); walk them through it, never do it for them.
- **A setting that spends money** (a budget, a paid tier, a model with a price): say what it costs as the plugin describes it, and change it only after the person agreed.

## When a plugin keeps more settings of its own

`plugin_settings` covers what Walnut stores for the plugin (`plugins.<id>` in config.yaml). Some plugins also hold settings in their own service (coderelay's rules and accounts live in each coderelay). Its `tools` list names the plugin's own ops and `skills` says it ships a skill: read that skill (`skill_read`) for those settings. When the plugin offers no way to change one, say so and send the person to its App; never edit the service's files on a machine to get around it.

## When it refuses

- `refused`: the value does not fit (wrong type, out of range, not one of `enum`, a key the plugin has no setting for). Read the reason, fix the value, call again.
- `unknown_plugin`: the answer lists the plugins that run. `ambiguous_plugin`: use the id.
- `enabled` is the plugin's on/off switch, not a setting: the person turns it on or off on its page.
