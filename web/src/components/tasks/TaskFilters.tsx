interface TaskFiltersProps {
  status: string;
  priority: string;
  search: string;
  onStatusChange: (status: string) => void;
  onPriorityChange: (priority: string) => void;
  onSearchChange: (search: string) => void;
}

export function TaskFilters({
  status,
  priority,
  search,
  onStatusChange,
  onPriorityChange,
  onSearchChange,
}: TaskFiltersProps) {
  return (
    <div className="task-filters">
      <select value={status} onChange={(e) => onStatusChange(e.target.value)} aria-label="Filter by status">
        <option value="">All Status</option>
        <option value="todo">Todo</option>
        <option value="done">Done</option>
      </select>

      <select value={priority} onChange={(e) => onPriorityChange(e.target.value)} aria-label="Filter by priority">
        <option value="">All Priority</option>
        <option value="immediate">Immediate</option>
        <option value="important">Important</option>
        <option value="backlog">Backlog</option>
        <option value="none">None</option>
      </select>

      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search tasks..."
        className="task-filter-search"
        aria-label="Search tasks"
      />
    </div>
  );
}
