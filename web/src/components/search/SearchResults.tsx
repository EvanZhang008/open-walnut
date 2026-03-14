import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { PriorityBadge } from '../common/PriorityBadge';

interface MemoryResult {
  path: string;
  excerpt: string;
}

type SearchTask = Task & { snippet?: string; score?: number; matchField?: string; isAutoExpanded?: boolean };

interface SearchResultsProps {
  tasks: SearchTask[];
  memories: MemoryResult[];
  query: string;
}

export function SearchResults({ tasks, memories, query }: SearchResultsProps) {
  const navigate = useNavigate();

  if (!query) return null;
  if (tasks.length === 0 && memories.length === 0) {
    return <div className="empty-state"><p>No results for "{query}"</p></div>;
  }

  return (
    <div className="search-results">
      {tasks.length > 0 && (
        <div className="search-group">
          <h3 className="search-group-title">Tasks ({tasks.length})</h3>
          {tasks.map((task) => {
            const isChild = !!task.parent_task_id;
            const isAutoExpanded = !!(task as SearchTask).isAutoExpanded;

            return (
              <div
                key={task.id}
                className={[
                  'search-result-item',
                  isChild ? 'search-result-child' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => navigate(`/tasks/${task.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/tasks/${task.id}`); }}
              >
                <span className={`badge ${isChild ? 'badge-child' : 'badge-todo'}`}>
                  {isChild ? '↳ Child' : 'Task'}
                </span>
                <span className="search-result-title">{task.title}</span>
                <PriorityBadge priority={task.priority} />
                {isAutoExpanded && (
                  <span className="search-auto-expanded-badge" title="Auto-expanded from parent">
                    auto
                  </span>
                )}
                <span className="text-xs text-muted">{task.project}</span>
              </div>
            );
          })}
        </div>
      )}

      {memories.length > 0 && (
        <div className="search-group">
          <h3 className="search-group-title">Memory ({memories.length})</h3>
          {memories.map((mem) => (
            <div key={mem.path} className="search-result-item">
              <span className="badge badge-in_progress">Memory</span>
              <div className="search-result-body">
                <span className="search-result-title font-mono text-sm">{mem.path}</span>
                <p className="search-result-excerpt text-sm text-muted">{mem.excerpt}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
