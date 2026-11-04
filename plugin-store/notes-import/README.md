# Import notes

Bring your Notion pages into Walnut notes, then let Walnut organize them.

## What it does

- **Imports everything a Notion connection can see** (or only the top-level pages you pick, with
  everything under them) into a folder of your notes. `Import from Notion` by default; any folder
  you have, or a new one.
- **Keeps the shape**: the page tree (a page with sub-pages becomes a folder holding a note of the
  same name), headings, lists, to-dos, quotes, callouts, code, tables, toggles (folded until opened),
  equations (typeset), columns, synced blocks, and links between pages, which point at the
  imported notes.
- **Databases** become a note with a table of their rows (the first six properties), and every
  row becomes its own note with all its properties in a table at the top.
- **Images and files** Notion hosts are downloaded into the note's `_attachment` folder: images,
  PDFs and office files. Videos, audio and other types link back to their place in Notion.
- **Run it again** to bring in only what changed: each note remembers its Notion page
  (`notion_id` in its frontmatter), a page that did not change is skipped without fetching it, a
  changed one is updated in place, and a note you edited in Walnut since is left as you left it
  (the run lists those). Moving imported notes around is fine, even out of the folder: the next run
  finds them. A note you deleted stays deleted until its page changes in Notion. A stopped run
  continues where it stopped.
- **Organize with Walnut**: your AI reads the imported folder (it only reads) and proposes a plan
  of moves, merges of duplicates and index pages. You read the plan, leave out any step you do not
  want, and Apply carries the rest out, writing each change down first, and fixes every link to a
  moved or merged note, in any folder. Undo reverses those changes, newest first, even of a run
  that was cut off, and keeps what you changed or wrote after the run. Organize works on any folder
  of your notes.

It only ever reads from Notion. Nothing in your Notion workspace is changed, moved or deleted.

## Connecting Notion

Notion lets an app read a workspace through a connection the workspace makes. The page walks you
through it:

1. Open [Notion's integrations page](https://www.notion.so/profile/integrations), choose **New
   integration**, pick your workspace, keep the type **Internal**, and save.
2. On the connection's **Access** tab, choose the pages to import (their sub-pages come too). You
   can also open a page in Notion and use **•••** › **Connections**.
3. On the **Configuration** tab, copy the **Internal Integration Secret** (it starts with `ntn_`)
   and paste it into the page. Walnut checks it with Notion, keeps it in its secret store, and
   shows how many pages the connection can see.

## What Notion blocks become

Walnut notes are Markdown, so a few Notion blocks change form; no text is lost:

| Notion | In Walnut |
|---|---|
| Toggle | A folded callout, `> [!note]- Title`, closed until clicked open (inside a list: a bold item over its content) |
| Equation | A `math` code block, typeset in the note (inline: $`…`$) |
| Columns | One after the other |
| Callout | A callout; blue is info, green a tip, red a warning, any other colour a note |
| Embed, bookmark, external video | A link |
| Video, audio, other files Notion hosts | A link back to the block in Notion |
| Table of contents, breadcrumb | Left out (the notes app has its own outline) |

## Notes

- Notion allows about three requests a second, so a big workspace takes a while; the page shows
  the progress and you can leave it. Stopping keeps what was imported, and the next run continues.
- The import runs on your main Walnut. A test run (an automated browser) cannot import into your
  notes.
- Sources: Notion is the first. The importer (`src/server/importer.ts`) works on any source that
  can list its items and turn one into Markdown (`src/server/types.ts`).
