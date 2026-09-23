import { useState, useMemo, useCallback } from 'react';
import { usePersistentState, oneOf, isString } from '@/hooks/usePersistentState';
import { useSkills } from '@/hooks/useSkills';
import { SkillCard } from '@/components/skills/SkillCard';
import { SkillDetail } from '@/components/skills/SkillDetail';
import { SkillForm } from '@/components/skills/SkillForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { SkillInfo } from '@/api/skills';

type SourceFilter = 'all' | 'workspace' | 'walnut' | 'claude' | 'plugin';
type StatusFilter = 'all' | 'enabled' | 'disabled';

export function SkillsPage() {
  const { skills, loading, error, create, update, toggle, remove } = useSkills();
  // View choices survive leaving the page (it unmounts on every navigation).
  const [sourceFilter, setSourceFilter] = usePersistentState<SourceFilter>(
    'walnut-skills-page-source', 'all', oneOf(['all', 'workspace', 'walnut', 'claude', 'plugin']),
  );
  const [statusFilter, setStatusFilter] = usePersistentState<StatusFilter>(
    'walnut-skills-page-status', 'all', oneOf(['all', 'enabled', 'disabled']),
  );
  const [search, setSearch] = usePersistentState<string>('walnut-skills-page-search', '', isString);
  // The selection is remembered by dirName and resolved against the live list, so
  // it both survives leaving the page and stays fresh after a refetch.
  const [selectedDir, setSelectedDir] = usePersistentState<string>('walnut-skills-page-selected', '', isString);
  const setSelected = useCallback((skill: SkillInfo | null) => setSelectedDir(skill?.dirName ?? ''), [setSelectedDir]);
  const [showForm, setShowForm] = useState(false);

  const filtered = useMemo(() => {
    let result = skills;
    if (sourceFilter !== 'all') {
      result = result.filter((s) => s.source === sourceFilter);
    }
    if (statusFilter === 'enabled') {
      result = result.filter((s) => s.enabled);
    } else if (statusFilter === 'disabled') {
      result = result.filter((s) => !s.enabled);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.dirName.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
    }
    return result;
  }, [skills, sourceFilter, statusFilter, search]);

  const counts = useMemo(() => ({
    all: skills.length,
    workspace: skills.filter((s) => s.source === 'workspace').length,
    walnut: skills.filter((s) => s.source === 'walnut').length,
    claude: skills.filter((s) => s.source === 'claude').length,
    plugin: skills.filter((s) => s.source === 'plugin').length,
    enabled: skills.filter((s) => s.enabled).length,
    disabled: skills.filter((s) => !s.enabled).length,
  }), [skills]);

  const selectedSkill = useMemo(() => {
    if (!selectedDir) return null;
    return skills.find((s) => s.dirName === selectedDir) ?? null;
  }, [skills, selectedDir]);

  const handleCreate = useCallback(async (input: { dirName: string; content: string; target: 'claude' | 'walnut' }) => {
    const skill = await create(input);
    setShowForm(false);
    setSelected(skill);
  }, [create, setSelected]);

  const handleSave = useCallback(async (dirName: string, content: string) => {
    await update(dirName, content);
  }, [update]);

  const handleToggle = useCallback(async (dirName: string, enabled: boolean) => {
    await toggle(dirName, enabled);
  }, [toggle]);

  const handleDelete = useCallback(async (dirName: string) => {
    await remove(dirName);
    if (selectedDir === dirName) setSelected(null);
  }, [remove, selectedDir, setSelected]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div className="skills-page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Skills</h1>
          <p className="page-subtitle">Manage skill extensions for AI agents</p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={() => setShowForm(true)}>
            + New Skill
          </button>
        )}
      </div>

      {showForm && (
        <SkillForm onSave={handleCreate} onCancel={() => setShowForm(false)} />
      )}

      <div className="skill-search-row">
        <input
          type="text"
          className="skill-search-input"
          placeholder="Search skills..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="skill-filters">
        <div className="skill-filter-group">
          {(['all', 'workspace', 'walnut', 'claude', 'plugin'] as const).map((tab) => (
            <button
              key={tab}
              className={`skill-filter-tab${sourceFilter === tab ? ' active' : ''}`}
              onClick={() => setSourceFilter(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)} ({counts[tab]})
            </button>
          ))}
        </div>
        <div className="skill-filter-group">
          {(['all', 'enabled', 'disabled'] as const).map((tab) => (
            <button
              key={tab}
              className={`skill-filter-tab${statusFilter === tab ? ' active' : ''}`}
              onClick={() => setStatusFilter(tab)}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}{tab !== 'all' ? ` (${counts[tab]})` : ''}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#9889;</div>
          <p>{search ? 'No skills match your search' : 'No skills found'}</p>
        </div>
      ) : (
        <div className="skill-layout">
          <div className="skill-card-list">
            {filtered.map((skill) => (
              <SkillCard
                key={skill.dirName}
                skill={skill}
                selected={selectedSkill?.dirName === skill.dirName}
                onSelect={setSelected}
                onToggle={handleToggle}
              />
            ))}
          </div>
          <div className="skill-detail-panel">
            {selectedSkill ? (
              <SkillDetail
                skill={selectedSkill}
                onSave={handleSave}
                onDelete={handleDelete}
                onToggle={handleToggle}
              />
            ) : (
              <div className="skill-detail-empty">
                <p className="text-muted">Select a skill to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
