import type { GlobalOptions } from '../core/types.js';

/**
 * Print the REMOTE MS To-Do lists verbatim. Deliberately not grouped: with
 * Project as the only local grouping layer there is no second level to fold
 * a "Cat / Proj" list name into — the remote name is just a name (a project
 * migrated from that encoding keeps it via its `remote_list` alias).
 */
export async function runLists(globalOptions: GlobalOptions): Promise<void> {
  const { getTaskLists } = await import('../integrations/microsoft-todo.js');
  const lists = await getTaskLists();

  if (globalOptions.json) {
    const { outputJson } = await import('../utils/json-output.js');
    outputJson(lists.map((l) => ({ id: l.id, displayName: l.displayName })));
    return;
  }

  for (const list of lists) {
    console.log(`  ${list.displayName}  ${list.id.slice(0, 12)}...`);
  }
  console.log(`\n${lists.length} lists total`);
}

export async function runListsCreate(
  name: string,
  globalOptions: GlobalOptions,
): Promise<void> {
  const { createList } = await import('../integrations/microsoft-todo.js');
  const list = await createList(name);

  if (globalOptions.json) {
    const { outputJson } = await import('../utils/json-output.js');
    outputJson({ status: 'created', list });
  } else {
    console.log(`Created list "${list.displayName}" (${list.id})`);
  }
}

export async function runListsRename(
  idOrName: string,
  newName: string,
  globalOptions: GlobalOptions,
): Promise<void> {
  // Use renameProject to update both local tasks and the remote list
  const { renameProject } = await import('../core/task-manager.js');

  try {
    const { count, merged } = await renameProject(idOrName, newName);

    if (globalOptions.json) {
      const { outputJson } = await import('../utils/json-output.js');
      outputJson({ status: 'renamed', oldProject: idOrName, newProject: newName, tasksUpdated: count, merged });
    } else {
      const suffix = merged ? ', merged into the existing project' : '';
      console.log(`Renamed project "${idOrName}" to "${newName}" (${count} tasks updated${suffix})`);
    }
  } catch (err) {
    // Fall back to direct remote list rename if no local tasks match
    const { getTaskLists, renameList } = await import('../integrations/microsoft-todo.js');
    let listId = idOrName;
    if (!idOrName.includes('=')) {
      const lists = await getTaskLists();
      const match = lists.find(
        (l) => l.displayName.toLowerCase() === idOrName.toLowerCase() || l.id === idOrName,
      );
      if (!match) {
        throw new Error(`No list found matching "${idOrName}"`);
      }
      listId = match.id;
    }

    const list = await renameList(listId, newName);

    if (globalOptions.json) {
      const { outputJson } = await import('../utils/json-output.js');
      outputJson({ status: 'renamed', list });
    } else {
      console.log(`Renamed list to "${list.displayName}"`);
    }
  }
}

export async function runListsDelete(
  idOrName: string,
  globalOptions: GlobalOptions,
): Promise<void> {
  const { getTaskLists, deleteList } = await import('../integrations/microsoft-todo.js');

  // Resolve list ID
  let listId = idOrName;
  let listName = idOrName;
  if (!idOrName.includes('=')) {
    const lists = await getTaskLists();
    const match = lists.find(
      (l) => l.displayName.toLowerCase() === idOrName.toLowerCase() || l.id === idOrName,
    );
    if (!match) {
      throw new Error(`No list found matching "${idOrName}"`);
    }
    listId = match.id;
    listName = match.displayName;
  }

  await deleteList(listId);

  if (globalOptions.json) {
    const { outputJson } = await import('../utils/json-output.js');
    outputJson({ status: 'deleted', listId, listName });
  } else {
    console.log(`Deleted list "${listName}"`);
  }
}
