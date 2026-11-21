import { useState, useEffect } from 'react';
import { fetchRepository } from '@/api/repositories';
import type { RepoSummary } from '@/api/repositories';

interface RepoDetailProps {
  repo: RepoSummary;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function RepoDetail({ repo, onBack, onEdit, onDelete }: RepoDetailProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepository(repo.slug).then((detail) => {
      if (!cancelled) {
        setContent(detail.content);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [repo.slug]);

  const hostEntries = Object.entries(repo.hosts);

  return (
    <div className="repo-detail">
      <div className="repo-detail-toolbar">
        <button className="btn btn-ghost" onClick={onBack}>&larr; Back</button>
        <div className="repo-detail-toolbar-right">
          <button className="btn" onClick={onEdit}>Edit</button>
          <button className="btn btn-danger" onClick={onDelete}>Delete</button>
        </div>
      </div>

      <h2>{repo.name}</h2>
      {repo.description && <p className="repo-detail-desc">{repo.description}</p>}

      {repo.tech_stack && (
        <div className="repo-detail-section">
          <h4>Tech Stack</h4>
          <p>{repo.tech_stack}</p>
        </div>
      )}

      <div className="repo-detail-section">
        <h4>Hosts</h4>
        <div className="repo-hosts-list">
          {hostEntries.map(([label, info]) => (
            <div key={label} className="repo-host-item">
              <span className="repo-host-badge">{label}</span>
              <code className="repo-host-path">{info.path || '(no path)'}</code>
              {info.ssh_host && <span className="repo-host-ssh">via {info.ssh_host}</span>}
            </div>
          ))}
        </div>
      </div>

      <div className="repo-detail-section">
        <h4>Raw YAML</h4>
        {loading ? (
          <p className="text-muted">Loading...</p>
        ) : error ? (
          <p className="text-muted" style={{ color: 'var(--error)' }}>Failed to load: {error}</p>
        ) : (
          <pre className="repo-yaml-content">{content}</pre>
        )}
      </div>
    </div>
  );
}
