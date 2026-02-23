import { useState, useMemo } from 'react';
import type { MemoryBrowseTree, BrowseItem, BrowseDailyItem } from '@/api/memory';

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
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

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
  const filteredProjects = useMemo(
    () => filterProjectTree(projectNodes, filter),
    [projectNodes, filter],
  );
  const showGlobal = useMemo(
    () => tree?.global && (!filter || matchesFilter('Global Memory', 'MEMORY.md', filter)),
    [tree?.global, filter],
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
        <span className="memory-tree-header-title">Memory</span>
      </div>
      <div className="memory-tree-filter">
        <input
          type="text"
          className="memory-filter-input"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="memory-tree-sections">
        {/* Global */}
        {showGlobal && (
          <Section title="Global" id="global" collapsed={collapsed} onToggle={toggleSection}>
            <TreeItem
              label="MEMORY.md"
              path="MEMORY.md"
              selected={selectedPath === 'MEMORY.md'}
              onClick={() => onSelect('MEMORY.md')}
            />
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

        {/* Empty state when all sections are hidden */}
        {!showGlobal &&
          filteredDaily.length === 0 &&
          filteredProjects.length === 0 &&
          filteredSessions.length === 0 &&
          filteredKnowledge.length === 0 && (
            <div className="memory-tree-empty">No matching files</div>
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
        <span className="memory-tree-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
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
  path: string;
  selected: boolean;
  onClick: () => void;
  depth?: number;
}

function TreeItem({ label, selected, onClick, depth = 0 }: TreeItemProps) {
  return (
    <button
      className={`memory-tree-item${selected ? ' memory-tree-item-selected' : ''}`}
      onClick={onClick}
      style={depth > 0 ? { paddingLeft: `${12 + depth * 16}px` } : undefined}
      title={label}
    >
      <span className="memory-tree-item-label">{label}</span>
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
          <span className="memory-tree-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
          <span className="memory-tree-folder-name">{node.name}</span>
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
