# Chrome Web Store listing

Everything the Chrome Web Store asks for when the Walnut extension is submitted, ready to paste.
`bun scripts/extension-store-package.mjs` builds the upload (the Chrome zip), the icon and this
text into one folder.

Why the store at all: on macOS and Windows, Chrome installs an extension in one click only from its
store. Its own documentation: "On Windows and macOS, the update_URL must point to the Chrome Web
Store", and "As of Chrome 44, no external installs are allowed from a path to a local CRX file on
Mac OS" (https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions).
Published 2026-11-18: https://chromewebstore.google.com/detail/walnut/ngkloakmnoagffcjhgkjkkmdnomkphgn
(publisher Open Walnut). Settings, Browser extension offers it first; loading it from Walnut
(Developer mode, Load unpacked) stays as the other way.

## Store listing

- **Name:** Walnut
- **Summary (132 characters at most):** Your own Walnut in the browser: ask about any page, let your agents work in their own tabs, and fill passwords from your vault.
- **Category:** Productivity (Workflow and planning)
- **Language:** English

**Description:**

Walnut is a personal AI that keeps your tasks, notes and work sessions on your own computer. This
extension connects your browser to the Walnut you run, and to nothing else.

- Ask about the page: the side panel opens Walnut beside any page and can read it. Select text and
  right-click for a quick question about it.
- Agents in your browser, only when you turn it on: your Walnut agents open their own tabs in a
  separate window, signed in as you. A Walnut cursor shows where they act and goes away when they
  stop. Every tab has Stop and Take over, and a click that buys, sends or deletes waits for your yes.
- Hand a tab over: let the agent of one chat use the tab you are on, and only that tab.
- Passwords: fills logins and one-time codes from your Walnut vault on their own site only, and
  offers to save new ones. Your master password unlocks it; the vault never leaves your computer.

Walnut is open source: https://github.com/EvanZhang008/open-walnut

## Privacy practices

- **Single purpose:** Connect the browser to the person's own Walnut so it can answer questions
  about pages, fill the person's saved passwords, and let the person's Walnut agents use tabs when
  the person turns that on.
- **Data use:** The extension sends page text, screenshots of agent tabs and form fields only to the
  person's own Walnut server (on their computer, or one they run). It sends nothing to the
  developer or any third party, sells nothing, and uses nothing for advertising or credit.
- **Data types to declare:** Authentication information (saved logins it fills), Website content
  (pages the person asks about or an agent works in), Web history (the addresses of agent tabs),
  User activity (an agent's clicks and typing in its own tabs). All stay between the browser and the
  person's own Walnut.
- **Privacy policy URL:** https://github.com/EvanZhang008/open-walnut/blob/main/packages/browser-extension/store/PRIVACY.md
- **Remote code:** No. Every script ships in the package.

## Why each permission

| Permission | Why |
|---|---|
| `storage` | Remembers which Walnut it is connected to, the person's settings and the agent tabs it holds. |
| `alarms` | Agents and the update check come back after Chrome stopped the background. |
| `contextMenus` | "Quick question about ..." on a selection or a page. |
| `scripting` | Puts its page script into a tab open from before the install, or one an agent is handed. |
| `downloads` | An agent sees the files it downloaded in its own tabs. |
| `clipboardRead`, `clipboardWrite`, `offscreen` | Copies a password or code on request and clears it after 30 seconds only if it is still there. |
| `idle` | Locks the vault when the computer locks or goes idle. |
| `sidePanel` | Walnut beside the page. |
| `tabGroups` | Keeps each task's agent tabs in one folded group. |
| `debugger` | An agent's real mouse and keys in its own tabs, for pages that ignore scripted clicks; never in the person's tabs unless handed over. Off by a switch in the extension's Settings. |
| Host permission `<all_urls>` | Fills logins on any site the person signs in to, and takes the screenshots an agent needs of its tab (captureVisibleTab needs all addresses). |

## Images

- Icon 128x128: `icon-128.png` (the package copies it from the build).
- Screenshots (1280x800, at least one): the side panel on a page; an agent tab with the Walnut
  cursor; Settings, Browser extension. Captured from a test server, never from real data.
- Small promo tile 440x280: optional.
