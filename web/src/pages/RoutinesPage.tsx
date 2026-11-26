import { RoutinesView } from '@/components/routines/RoutinesView';

const HEAD = {
  title: 'Routines',
  subtitle: 'Automations that run on a schedule or when a check finds something, grouped by project.',
};

export function RoutinesPage() {
  return (
    <div>
      <RoutinesView head={HEAD} />
    </div>
  );
}
