import { RoutinesView } from '@/components/routines/RoutinesView';

export function RoutinesPage() {
  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Routines</h1>
        <p className="page-subtitle">Templated automations that run on a schedule — describe one in plain language</p>
      </div>
      <RoutinesView />
    </div>
  );
}
