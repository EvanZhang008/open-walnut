import { useState, useMemo, useCallback } from 'react';
import { useCronJobs } from '@/hooks/useCronJobs';
import { CronJobCard } from '@/components/cron/CronJobCard';
import { CronJobForm } from '@/components/cron/CronJobForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { CronJob, CreateCronJobInput, UpdateCronJobInput } from '@/api/cron';

type FilterTab = 'all' | 'enabled' | 'disabled';

export function CronPage() {
  const { jobs, loading, error, create, update, toggle, remove, runNow } = useCronJobs(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | undefined>(undefined);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'enabled': return jobs.filter((j) => j.enabled);
      case 'disabled': return jobs.filter((j) => !j.enabled);
      default: return jobs;
    }
  }, [jobs, filter]);

  const handleSave = useCallback(async (input: CreateCronJobInput | UpdateCronJobInput) => {
    if (editingJob) {
      await update(editingJob.id, input as UpdateCronJobInput);
    } else {
      await create(input as CreateCronJobInput);
    }
    setShowForm(false);
    setEditingJob(undefined);
  }, [editingJob, create, update]);

  const handleEdit = useCallback((job: CronJob) => {
    setEditingJob(job);
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingJob(undefined);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await remove(id);
  }, [remove]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Scheduled Jobs</h1>
          <p className="page-subtitle">Automated recurring tasks</p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={() => { setEditingJob(undefined); setShowForm(true); }}>
            + New Job
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <CronJobForm
            job={editingJob}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
      )}

      <div className="cron-filter-tabs">
        {(['all', 'enabled', 'disabled'] as const).map((tab) => (
          <button
            key={tab}
            className={`cron-filter-tab${filter === tab ? ' active' : ''}`}
            onClick={() => setFilter(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
            {tab === 'all' && ` (${jobs.length})`}
            {tab === 'enabled' && ` (${jobs.filter((j) => j.enabled).length})`}
            {tab === 'disabled' && ` (${jobs.filter((j) => !j.enabled).length})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">&#128337;</div>
          <p>{filter === 'all' ? 'No scheduled jobs yet' : `No ${filter} jobs`}</p>
          {filter === 'all' && (
            <p className="text-sm mt-2">Create a job to automate recurring tasks</p>
          )}
        </div>
      ) : (
        <div className="cron-job-list">
          {filtered.map((job) => (
            <CronJobCard
              key={job.id}
              job={job}
              onToggle={toggle}
              onRunNow={runNow}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
