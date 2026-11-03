# Walnut browser extension

Fills and saves passwords from your own Walnut vault in Chrome (and Edge, Brave, Arc) and Firefox.

- `src/background.ts`: the only part that talks to Walnut and holds the device token and the vault session.
- `src/content.ts` + `src/form-detect.ts`: finds login, sign-up, password-change and one-time-code fields, shows the Walnut icon and menu, notices a login being sent.
- `src/menu.ts`, `src/savebar.ts`: the in-page menu and save bar, extension pages framed into the site (the site cannot read them).
- `src/popup.ts`: the toolbar popup (connect, unlock, logins for this site, search, copy, generator).

Build: `bun run extension:build` (also part of `bun run web:build`) writes `dist/extension/{chrome,firefox}` and the downloads Walnut serves at `/downloads/walnut-extension-{chrome,firefox}.zip`.

How it connects, unlocks and what it may fill: [docs/reference/passwords.md](../../docs/reference/passwords.md#browser-extension).
