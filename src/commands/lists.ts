import type { GlobalOptions } from '../core/types.js';
import { parseGroupFromCategory } from '../utils/format.js';

export async function runLists(globalOptions: GlobalOptions): Promise<void> {
  const { getTaskLists } = await import('../integrations/microsoft-todo.js');
  const lists = await getTaskLists();

  if (globalOptions.json) {
    const { outputJson } = await import('../utils/json-output.js');
    outputJson(lists.map((l) => ({
      id: l.id,
      displayName: l.displayName,
      ...parseGroupFromCategory(l.displayName),
    })));
    return;
  }

  // Group lists by parsed group prefix
  const grouped = new Map<string, { id: string; displayName: string; listName: string }[]>();
  for (const list of lists) {
    const { group, listName } = parseGroupFromCategory(list.displayName);
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push({ id: list.id, displayName: list.displayName, listName });
  }

  for (const [group, items] of grouped) {
    console.log(`\n${group}`);
    for (const item of items) {
      const label = item.listName !== group ? `  ${item.listName}` : `  (root)`;
      console.log(`${label}  ${item.id.slice(0, 12)}...`);
    }
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
  // Use renameCategory to update both local tasks and remote list
  const { renameCategory } = await import('../core/task-manager.js');

  try {
    const { count } = await renameCategory(idOrName, newName);

    if (globalOptions.json) {
      const { outputJson } = await import('../utils/json-output.js');
      outputJson({ status: 'renamed', oldCategory: idOrName, newCategory: newName, tasksUpdated: count });
    } else {
      console.log(`Renamed category "${idOrName}" to "${newName}" (${count} tasks updated)`);
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
