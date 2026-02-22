interface ProjectTabsProps {
  projects: string[];
  active: string;
  onChange: (project: string) => void;
}

export function ProjectTabs({ projects, active, onChange }: ProjectTabsProps) {
  return (
    <div className="project-tabs">
      <button
        className={`project-tab${active === '' ? ' project-tab-active' : ''}`}
        onClick={() => onChange('')}
      >
        All
      </button>
      {projects.map((p) => (
        <button
          key={p}
          className={`project-tab${active === p ? ' project-tab-active' : ''}`}
          onClick={() => onChange(p)}
        >
          {p}
        </button>
      ))}
    </div>
  );
}
