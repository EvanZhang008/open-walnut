import { RoutinesView } from '@/components/routines/RoutinesView';

export function RoutinesPage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Routines</h1>
        <p className="page-subtitle">Automations that run on a schedule or when a check finds something, grouped by project.</p>
      </div>
      <RoutinesView />
    </div>
  );
}
