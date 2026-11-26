import { useCallback, useMemo } from 'react';
import { EmptyState } from '@/components/common/EmptyState';
import { usePersistentState, isString, isStringArray } from '@/hooks/usePersistentState';
import type { MemoryBrowseTree, BrowseItem, BrowseDailyItem } from '@/api/memory';
import { SearchField } from '@/components/common/SearchField';
import { DisclosureChevron } from '@/components/controls';

/**
 * The two standing stores every session reads, named by what they hold; the file name stays
 * beside it for anyone who edits the files by hand. The content panel's path line uses it too.
 */
export const STANDING_STORES = {
  section: 'Read in every session',
  'USER.md': { label: 'Your profile', hint: 'Who you are and how you like to work' },
  'MEMORY.md': { label: 'Remembered facts', hint: 'Facts Walnut keeps across all projects' },
} as const;
const storeLabel = (file: 'USER.md' | 'MEMORY.md') => `${STANDING_STORES[file].label} (${file})`;

interface MemoryTreePanelProps {
  tree: MemoryBrowseTree | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

interface ProjectNode {
  name: string;
  fullPath: string;
  children: ProjectNode[];
  file: BrowseItem | null;
}

function buildProjectTree(items: BrowseItem[]): ProjectNode[] {
  const root: ProjectNode[] = [];
  for (const item of items) {
    // path: "projects/work/homelab/MEMORY.md" → segments: ["work", "homelab", "MEMORY.md"]
    const rel = item.path.replace(/^projects\//, '');
    const parts = rel.split('/');
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, fullPath: parts.slice(0, i + 1).join('/'), children: [], file: null };
        level.push(node);
      }
      level = node.children;
    }
    // Leaf file
    const existing = level.find((n) => n.name === parts[parts.length - 1]);
    if (existing) {
      existing.file = item;
    } else {
      level.push({ name: parts[parts.length - 1], fullPath: rel, children: [], file: item });
    }
  }
  return root;
}

function matchesFilter(title: string, path: string, filter: string): boolean {
  const lower = filter.toLowerCase();
  return title.toLowerCase().includes(lower) || path.toLowerCase().includes(lower);
}

function filterItems<T extends BrowseItem>(items: T[], filter: string): T[] {
  if (!filter) return items;
  return items.filter((item) => matchesFilter(item.title, item.path, filter));
}

function projectTreeHasMatch(node: ProjectNode, filter: string): boolean {
  if (node.file && matchesFilter(node.file.title, node.file.path, filter)) return true;
  return node.children.some((child) => projectTreeHasMatch(child, filter));
}

function filterProjectTree(nodes: ProjectNode[], filter: string): ProjectNode[] {
  if (!filter) return nodes;
  return nodes
    .filter((node) => projectTreeHasMatch(node, filter))
    .map((node) => ({
      ...node,
      children: filterProjectTree(node.children, filter),
    }));
}

export function MemoryTreePanel({ tree, selectedPath, onSelect }: MemoryTreePanelProps) {
  // Both survive leaving /memory (the page unmounts on navigation). The Set is
  // stored as an array; the two wrappers below keep the Set API the rest of the
  // component uses.
  const [filter, setFilter] = usePersistentState<string>('walnut-memory-tree-filter', '', isString);
  const [collapsedList, setCollapsedList] = usePersistentState<string[]>('walnut-memory-tree-collapsed', [], isStringArray);
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const setCollapsed = useCallback((update: (prev: Set<string>) => Set<string>) => {
    setCollapsedList((prev) => [...update(new Set(prev))]);
  }, [setCollapsedList]);

  const projectNodes = useMemo(() => (tree ? buildProjectTree(tree.projects) : []), [tree]);

  const filteredDaily = useMemo(() => filterItems(tree?.daily ?? [], filter), [tree?.daily, filter]);
  const filteredSessions = useMemo(
    () => filterItems(tree?.sessions ?? [], filter),
    [tree?.sessions, filter],
  );
  const filteredKnowledge = useMemo(
    () => filterItems(tree?.knowledge ?? [], filter),
    [tree?.knowledge, filter],
  );
  const filteredTopics = useMemo(
    () => filterItems(tree?.topics ?? [], filter),
    [tree?.topics, filter],
  );
  const filteredCompaction = useMemo(
    () => filterItems(tree?.compaction ?? [], filter),
    [tree?.compaction, filter],
  );
  const filteredRepos = useMemo(
    () => filterItems(tree?.repos ?? [], filter),
    [tree?.repos, filter],
  );
  const filteredSpecial = useMemo(
    () => filterItems(tree?.special ?? [], filter),
    [tree?.special, filter],
  );
  const filteredProjects = useMemo(
    () => filterProjectTree(projectNodes, filter),
    [projectNodes, filter],
  );
  const showGlobal = useMemo(
    () => tree?.global && (!filter || matchesFilter(storeLabel('MEMORY.md'), 'MEMORY.md', filter)),
    [tree?.global, filter],
  );
  const showUser = useMemo(
    () => tree?.user && (!filter || matchesFilter(storeLabel('USER.md'), 'USER.md', filter)),
    [tree?.user, filter],
  );

  const toggleSection = (section: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  if (!tree) return null;

  return (
    <div className="memory-tree-panel">
      <div className="memory-tree-header">
        <h1 className="pane-title page-name memory-tree-header-title">Memory</h1>
      </div>
      <div className="memory-tree-filter">
        <SearchField data-no-draft="search"
          type="text"
          className="memory-filter-input"
          placeholder="Filter files"
          aria-label="Filter memory files"
          value={filter}
          setText={setFilter}
          onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter(''); } }}
          onClear={() => setFilter('')}
        />
      </div>
      <div className="memory-tree-sections">
        {/* Special — Working Memory + Index */}
        {filteredSpecial.length > 0 && (
          <Section title="Memory v2" id="special" collapsed={collapsed} onToggle={toggleSection}>
            {filteredSpecial.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Topics — distilled wiki pages */}
        {filteredTopics.length > 0 && (
          <Section title="Topics" id="topics" collapsed={collapsed} onToggle={toggleSection} count={filteredTopics.length}>
            {filteredTopics.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Global: the two stores every session reads */}
        {(showGlobal || showUser) && (
          <Section title={STANDING_STORES.section} id="global" collapsed={collapsed} onToggle={toggleSection}>
            {showUser && (
              <TreeItem
                label={storeLabel('USER.md')}
                hint={STANDING_STORES['USER.md'].hint}
                path="USER.md"
                selected={selectedPath === 'USER.md'}
                onClick={() => onSelect('USER.md')}
              />
            )}
            {showGlobal && (
              <TreeItem
                label={storeLabel('MEMORY.md')}
                hint={STANDING_STORES['MEMORY.md'].hint}
                path="MEMORY.md"
                selected={selectedPath === 'MEMORY.md'}
                onClick={() => onSelect('MEMORY.md')}
              />
            )}
          </Section>
        )}

        {/* Daily Logs */}
        {filteredDaily.length > 0 && (
          <Section title="Daily Logs" id="daily" collapsed={collapsed} onToggle={toggleSection} count={filteredDaily.length}>
            {filteredDaily.map((item) => (
              <TreeItem
                key={item.path}
                label={item.date}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Projects */}
        {filteredProjects.length > 0 && (
          <Section title="Projects" id="projects" collapsed={collapsed} onToggle={toggleSection}>
            {filteredProjects.map((node) => (
              <ProjectNodeView
                key={node.fullPath}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggle={toggleSection}
              />
            ))}
          </Section>
        )}

        {/* Sessions */}
        {filteredSessions.length > 0 && (
          <Section title="Sessions" id="sessions" collapsed={collapsed} onToggle={toggleSection} count={filteredSessions.length}>
            {filteredSessions.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Knowledge */}
        {filteredKnowledge.length > 0 && (
          <Section title="Knowledge" id="knowledge" collapsed={collapsed} onToggle={toggleSection} count={filteredKnowledge.length}>
            {filteredKnowledge.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Compaction — archived context snapshots */}
        {filteredCompaction.length > 0 && (
          <Section title="Compaction" id="compaction" collapsed={collapsed} onToggle={toggleSection} count={filteredCompaction.length}>
            {filteredCompaction.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Repos — per-repository environment knowledge */}
        {filteredRepos.length > 0 && (
          <Section title="Repos" id="repos" collapsed={collapsed} onToggle={toggleSection} count={filteredRepos.length}>
            {filteredRepos.map((item) => (
              <TreeItem
                key={item.path}
                label={item.title}
                path={item.path}
                selected={selectedPath === item.path}
                onClick={() => onSelect(item.path)}
              />
            ))}
          </Section>
        )}

        {/* Empty state when all sections are hidden */}
        {!showGlobal &&
          filteredDaily.length === 0 &&
          filteredProjects.length === 0 &&
          filteredSessions.length === 0 &&
          filteredKnowledge.length === 0 &&
          filteredTopics.length === 0 &&
          filteredCompaction.length === 0 &&
          filteredRepos.length === 0 &&
          filteredSpecial.length === 0 && (
            <EmptyState size="section" title="No matching files" />
          )}
      </div>
    </div>
  );
}

/* ─── Section ─── */

interface SectionProps {
  title: string;
  id: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  count?: number;
  children: React.ReactNode;
}

function Section({ title, id, collapsed, onToggle, count, children }: SectionProps) {
  const isCollapsed = collapsed.has(id);
  return (
    <div className="memory-tree-section">
      <button
        className="memory-tree-section-header"
        onClick={() => onToggle(id)}
      >
        <DisclosureChevron open={!isCollapsed} className="memory-tree-chevron" />
        <span className="memory-tree-section-title">{title}</span>
        {count !== undefined && <span className="memory-tree-section-count">{count}</span>}
      </button>
      {!isCollapsed && <div className="memory-tree-section-body">{children}</div>}
    </div>
  );
}

/* ─── TreeItem (leaf) ─── */

interface TreeItemProps {
  label: string;
  /** What the file holds, for its tooltip (the label alone otherwise). */
  hint?: string;
  path: string;
  selected: boolean;
  onClick: () => void;
  depth?: number;
}

function TreeItem({ label, hint, selected, onClick, depth = 0 }: TreeItemProps) {
  return (
    <button
      className={`memory-tree-item${selected ? ' memory-tree-item-selected' : ''}`}
      onClick={onClick}
      style={depth > 0 ? { paddingLeft: `${12 + depth * 16}px` } : undefined}
      title={hint ? `${label}: ${hint}` : undefined}
    >
      <span className="memory-tree-item-label wn-title">{label}</span>
    </button>
  );
}

/* ─── ProjectNodeView (recursive) ─── */

interface ProjectNodeViewProps {
  node: ProjectNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}

function ProjectNodeView({ node, depth, selectedPath, onSelect, collapsed, onToggle }: ProjectNodeViewProps) {
  const hasChildren = node.children.length > 0;
  const nodeId = `proj-${node.fullPath}`;
  const isCollapsed = collapsed.has(nodeId);

  // Folder node (has children)
  if (hasChildren) {
    return (
      <div className="memory-tree-project-group">
        <button
          className="memory-tree-folder"
          onClick={() => onToggle(nodeId)}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <DisclosureChevron open={!isCollapsed} className="memory-tree-chevron" />
          <span className="memory-tree-folder-name wn-title">{node.name}</span>
        </button>
        {!isCollapsed && (
          <>
            {node.file && (
              <TreeItem
                label={node.file.title || 'MEMORY.md'}
                path={node.file.path}
                selected={selectedPath === node.file.path}
                onClick={() => onSelect(node.file!.path)}
                depth={depth + 1}
              />
            )}
            {node.children.map((child) => (
              <ProjectNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  // Leaf node (file only, no sub-folders)
  if (node.file) {
    return (
      <TreeItem
        label={node.name === 'MEMORY.md' ? `${node.name}` : node.file.title}
        path={node.file.path}
        selected={selectedPath === node.file.path}
        onClick={() => onSelect(node.file!.path)}
        depth={depth}
      />
    );
  }

  return null;
}
