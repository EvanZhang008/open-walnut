import type { RepoSummary } from '@/api/repositories';
import '@/styles/header-fit.css';

interface RepoCardProps {
  repo: RepoSummary;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function RepoCard({ repo, onClick, onEdit, onDelete }: RepoCardProps) {
  const hostLabels = Object.keys(repo.hosts);

  return (
    <div className="repo-card" onClick={onClick} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onClick()}>
      <div className="repo-card-header" data-fit-header="">
        <h3 className="repo-card-name" data-fit-title="">{repo.name}</h3>
        <div className="repo-card-actions" data-fit-actions="" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-icon" onClick={onEdit} title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button className="btn btn-icon btn-danger" onClick={onDelete} title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>

      {repo.description && (
        <p className="repo-card-desc">{repo.description}</p>
      )}

      <div className="repo-card-meta">
        {repo.tech_stack && (
          <span className="repo-card-tech">{repo.tech_stack}</span>
        )}
        {hostLabels.length > 0 && (
          <div className="repo-card-hosts">
            {hostLabels.map((h) => (
              <span key={h} className="badge repo-host-badge"><span>{h}</span></span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
