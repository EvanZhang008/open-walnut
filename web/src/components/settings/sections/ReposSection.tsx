import { useState, useMemo, useCallback } from 'react';
import { SettingsSection, SettingsEmpty } from '../SettingsSection';
import { useRepositories } from '@/hooks/useRepositories';
import { RepoCard } from '@/components/repositories/RepoCard';
import { RepoForm } from '@/components/repositories/RepoForm';
import { RepoDetail } from '@/components/repositories/RepoDetail';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/hooks/useConfirm';
import type { RepoSummary } from '@/api/repositories';

const REPOS_DESCRIPTION = 'Repositories Walnut knows about: what each one is, its tech stack, and where it lives on this machine.';

export function ReposSection() {
  const { repos, loading, error, save, remove, refresh } = useRepositories();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<RepoSummary | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tech_stack.toLowerCase().includes(q),
    );
  }, [repos, search]);

  const handleCreate = useCallback(() => {
    setSelected(null);
    setEditingSlug(null);
    setShowForm(true);
  }, []);

  const handleEdit = useCallback((slug: string) => {
    setEditingSlug(slug);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(async (slug: string, content: string) => {
    await save(slug, content);
    setShowForm(false);
    setEditingSlug(null);
  }, [save]);

  const handleDelete = useCallback(async (slug: string) => {
    if (!(await confirm({ title: `Delete repository “${slug}”?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await remove(slug);
      if (selected?.slug === slug) setSelected(null);
    } catch {
      // useRepositories.refresh() handles re-fetching; error is transient
    }
  }, [remove, selected, confirm]);

  const handleSelect = useCallback((repo: RepoSummary) => {
    setSelected(repo);
    setShowForm(false);
  }, []);

  const handleBack = useCallback(() => {
    setShowForm(false);
    setEditingSlug(null);
    setSelected(null);
  }, []);

  // Every state — loading, error, the add form, one repo's detail, the list —
  // renders in the SAME shell, so switching between them no longer changes the
  // card's width or its header.
  if (loading) {
    return (
      <SettingsSection id="repositories" title="Repositories" description={REPOS_DESCRIPTION}>
        <LoadingSpinner />
      </SettingsSection>
    );
  }
  if (error) {
    return (
      <SettingsSection id="repositories" title="Repositories" description={REPOS_DESCRIPTION}>
        <SettingsEmpty>Error: {error}</SettingsEmpty>
      </SettingsSection>
    );
  }

  if (showForm) {
    return (
      <SettingsSection id="repositories" title="Repositories" description={REPOS_DESCRIPTION}>
        <RepoForm
          editSlug={editingSlug}
          onSave={handleSave}
          onCancel={handleBack}
        />
      </SettingsSection>
    );
  }

  if (selected) {
    return (
      <SettingsSection id="repositories" title="Repositories" description={REPOS_DESCRIPTION}>
        <RepoDetail
          repo={selected}
          onBack={handleBack}
          onEdit={() => handleEdit(selected.slug)}
          onDelete={() => handleDelete(selected.slug)}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id="repositories"
      title="Repositories"
      description={REPOS_DESCRIPTION}
      actions={(
        <button className="btn btn-primary" onClick={handleCreate}>
          + Add Repository
        </button>
      )}
    >
      <div className="repos-search-row">
        <input
          className="repos-search-input"
          type="text"
          placeholder="Search repositories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="repos-count">{filtered.length} {filtered.length === 1 ? 'repo' : 'repos'}</span>
      </div>

      {filtered.length === 0 ? (
        <SettingsEmpty>
          {repos.length === 0
            ? 'No repositories registered yet. Use "+ Add Repository" to get started.'
            : 'No repositories match your search.'}
        </SettingsEmpty>
      ) : (
        <div className="repos-grid">
          {filtered.map((repo) => (
            <RepoCard
              key={repo.slug}
              repo={repo}
              onClick={() => handleSelect(repo)}
              onEdit={() => handleEdit(repo.slug)}
              onDelete={() => handleDelete(repo.slug)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
