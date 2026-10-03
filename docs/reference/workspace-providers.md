# Workspace providers

A task can ask for an **isolated workspace**: its own working copy, made for it on the host where its files live, so two tasks on the same repository never edit the same checkout. Its sessions start inside it. When the task is done and nothing in the workspace would be lost, Walnut removes it.

Who makes the workspace is a **provider**:

- `git-worktree` is built in. It makes a git worktree on a new branch.
- A plugin can add more. A plugin provider is a command, declared in the plugin's manifest, that Walnut runs on the task's host. The usual reason to write one is a monorepo tool whose workspace is made by its own CLI and holds several package repositories.

This page covers how it works for the user, how cleanup decides, and the protocol a plugin provider speaks.

## Using it

In a new task's draft, pick a folder, open **More** and turn on **Isolated workspace** (before a folder is picked the row is disabled and says "Pick a folder first"). Its options then show above the folder pill, led by an "Isolated workspace ✓" pill whose × turns it off. Walnut asks the folder's host which providers can isolate that folder: `git-worktree` when the folder is in a git repository, and every plugin provider (one that recognizes the folder is marked as a match and picked first). Pick one and fill in its fields, if it has any (a list of packages, for example), then Start.

The task is filed at once and shows **Preparing workspace…** with the provider's progress while the host works. The session starts only when the workspace is ready, inside it. If the provider fails, the task shows its error with **Retry**; there is never a session running in a half-made workspace.

On the task, the kebab menu's **Workspace** row shows the provider, the state, the folder, the branch and the repositories, and holds **Remove workspace…**.

## The built-in git worktree

- The worktree lives in a folder Walnut owns on that host, never inside the repository: `~/.open-walnut-worktrees/<repo>/<task-name>`. The daemon reads `WALNUT_WORKTREES_ROOT` to put it elsewhere.
- Its branch is `walnut/<task-name>`, made from the folder's current commit, or from the **Base branch** field when filled in.
- The session starts in the same sub-folder of the worktree that the task was started from.
- Refused outright: the home folder, `/`, system folders and mount roots as the repository (checked on the literal path and on the real path, so a symlink cannot launder one), and a workspace made from inside another workspace.
- git runs with a clean environment: an inherited `GIT_DIR`, `GIT_WORK_TREE` or `GIT_INDEX_FILE` would point it at another repository.
- A failed creation removes what it made: the folder, and the branch if this attempt created it (only when git did not register the worktree). A retry after an interruption finds the worktree it already made and keeps it.
- After a workspace is removed, the task's next start makes a new one with the same provider and fields, so it never runs in the folder the workspace was made from. The git provider checks out `walnut/<task-name>` again when the branch is still there.

## Cleanup

The rule: **a workspace is removed only when nothing in it would be lost.** The server decides; the daemon on the host checks again before it deletes anything, and removes nothing it cannot account for.

Before any removal the host probes the workspace. Each item below keeps it:

- **uncommitted changes** (including untracked files) in a repository, or a repository that cannot be read;
- a **detached HEAD** on a commit that no branch, remote-tracking ref or tag holds;
- git worktree: a folder git ignores that holds a repository (`git worktree remove` would delete it);
- **commits that exist nowhere else**. For a git worktree, its branch is not contained in its base branch, the base's upstream, or any other branch or tag. Exception: a removal by hand still goes ahead and keeps the branch.

A plugin workspace is checked harder, because its provider deletes the whole folder:

- its repositories are the ones recorded at creation **plus what `listRepos` answers at probe time**. A failed `listRepos` keeps the workspace;
- the root is scanned (3 folders deep, at most 4000 folders, `node_modules` skipped) for `.git` entries. A repository that nobody listed keeps it, and the reason names its path. So does a scan that could not finish;
- in every repository, `git rev-list --branches --not --remotes` must be empty: a commit on any local branch that no remote-tracking ref holds keeps it (a repository with no remote at all counts as unpushed);
- a stash (`refs/stash`) keeps it;
- the removal requires all of this even when started by hand.

**Ignored files go with the folder.** Files git ignores (an `.env`, a build folder) are in no commit, and both `git worktree remove` and a provider's removal delete them. The confirm dialog of a removal by hand lists how many there are and the first few names. Automatic cleanup removes them without asking.

| When | Clean, all work merged or pushed | Unmerged commits | Uncommitted or unreadable |
|---|---|---|---|
| Task completed | removed (branch deleted) | kept, the task says why | kept, the task says why |
| Task deleted | removed (branch deleted) | kept, a notification says where | kept, a notification says where |
| Remove workspace… (by hand) | removed after a confirm | git worktree: folder removed, **branch kept**; plugin: refused | refused |

Completion cleanup waits until no session process of the task is alive, idle ones included, since a live session keeps its working folder in the workspace. Completing a task already stops its sessions. A session that is still alive is not stopped for this: the cleanup runs again when that session stops, and after a restart. A task reopened meanwhile keeps its workspace: "still completed" is checked in the same write that starts the removal.

Only the Walnut that made a workspace resumes, launches, cleans up or removes it. Each workspace records it (`home`, the real path of that Walnut's data folder). A test server running over copied tasks with the real home folder leaves the copied workspaces alone, and refuses a removal by hand with "This workspace was made by another Walnut". Starting a new session in a copied ready workspace is ordinary use and works.

The confirm dialog of **Remove workspace…** says exactly what goes and what stays, for example "Deletes the worktree folder …" and "Keeps branch walnut/…: it has commits that are not merged or pushed anywhere". After the confirm, the request returns at once. The host probes again before it deletes anything and refuses when something changed. The task's Workspace row then shows why it was not removed.

A removal deletes a branch only when it is a `walnut/` branch, no worktree has it checked out, and its commits are in another ref. A branch name on the task row is never trusted further than that.

## Writing a plugin provider

A provider is declared in an `apiVersion: 1` plugin's `manifest.json`. The plugin needs no server code:

```json
{
  "apiVersion": 1,
  "id": "monorepo-workspaces",
  "name": "Monorepo workspaces",
  "version": "1.0.0",
  "capabilities": {
    "workspace": {
      "providers": [
        {
          "id": "monorepo-tool",
          "displayName": "Monorepo workspace",
          "priority": 50,
          "markers": ["workspace.toml"],
          "command": ["python3", "{script}"],
          "script": "provider.py",
          "roots": ["~/workspaces"],
          "timeouts": { "createSec": 900, "removeSec": 300 },
          "inputSchema": {
            "type": "object",
            "properties": {
              "packages": { "type": "array", "title": "Packages", "description": "Package repositories to check out" }
            },
            "required": ["packages"]
          }
        }
      ]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase, unique across plugins. `git-worktree` is taken. |
| `displayName` | What the provider picker shows. |
| `priority` | Higher is offered first when several providers claim a folder. git-worktree is 10; the default is 50. |
| `markers` | File names whose presence in the folder or an ancestor claims it (the search stops at the home folder). |
| `command` | The argv the host runs. **No shell**: no pipes, no `$VAR`, no globbing. `{script}` is replaced by the adapter's path on the host, a leading `~/` by the host's home. |
| `script` | Optional. One file inside the plugin folder (at most 512 KB). Walnut ships it to the host with the allowlist and writes it to the daemon's state folder, so the provider works on a remote host with nothing installed there but its interpreter. When that folder is under `/tmp` and a cleaner removed the file, the daemon writes it again before the next run. |
| `roots` | Folders a created workspace may live in besides the home folder. |
| `timeouts` | Seconds. `create` and `remove` default to 180, everything else to 30; at most 1800. A timed-out run has its whole process group stopped. |
| `operations` | The operations it implements, when not all five. |
| `inputSchema` | The fields the user fills in: `string` (optionally an `enum`), `boolean`, or `array` of strings (typed comma or space separated). `required` makes the Start button wait for them. |

Only manifests of plugins installed on the Mac running Walnut feed the allowlist. Nothing a browser, a phone or the cloud companion sends can add an entry or change a command.

### The protocol

For each operation the daemon runs the command once, with:

- **stdin**: one JSON object `{"version": 1, "operation": "<op>", "arguments": { … }}`;
- **environment**: the daemon's, minus git's redirect variables, plus `WALNUT_WORKSPACE_PROVIDER`, `WALNUT_WORKSPACE_OPERATION` and `WALNUT_WORKSPACE_PROTOCOL=1`;
- **working folder**: the workspace root when it exists, else the folder the task started from, else home.

It answers with one JSON object on **stdout**, either the whole output or its last line (so log noise before it is tolerated):

```json
{"version": 1, "ok": true, "result": { … }}
{"version": 1, "ok": false, "error": "a sentence the user reads", "code": "optional_short_code"}
```

Every line on **stderr** is progress: the last line shows on the task while it works. stdout is capped at 1 MB. The run ends when the command exits: a background process it left holding stdout does not keep it waiting.

| Operation | arguments | result |
|---|---|---|
| `detect` | `anchor`, `markerRoot` (when a marker was found) | `claimed` (boolean), `root`, `reason` |
| `create` | `anchor`, `name` (a safe one-segment name), `markerRoot`, `taskId`, `title`, `baseRef`, `inputs` | `root`, `cwd`, `repos`, `branch` |
| `listRepos` | `root`, `inputs` | `repos` |
| `status` | (not used today: Walnut probes the repositories itself) | |
| `remove` | `root`, `repos`, `anchor`, `inputs` | `removed` |

`repos` is a list of `{ "path": "…", "name": "…" }` with paths absolute or relative to the root. Walnut checks every repository listed before any removal, so list them all: `listRepos` runs again at every probe, and a repository under the root that it does not list keeps the workspace. A workspace that lists none is never treated as clean.

What Walnut checks in a `create` result before the task may use it: `root` is absolute and normalized, exists, is inside the home folder or a declared root (and is not that folder itself), is not a forbidden folder, and does not contain the folder the task started from. A result that fails is refused and nothing is removed; the provider owns cleaning up after itself when `create` fails.

`remove` is only ever called after Walnut's own probe found every repository clean and pushed and nothing unlisted under the root, and only for a root inside the allowed folders.

### Helper and tests

`@open-walnut/plugin-api/workspace` has the types above and `serveWorkspaceProvider(handlers)`, which reads the request, calls your handler, and writes exactly one reply (an exception becomes `ok: false` with its message). Bundle it into the one `script` file, because nothing is installed beside the script on the host.

The repository's test fixture `tests/fixtures/workspace-providers/fake-multirepo/provider.mjs` is a complete provider in one file: it makes a workspace folder holding several package clones, reports progress per package, and removes only what it made.
