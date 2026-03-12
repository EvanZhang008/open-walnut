import { useState, useEffect, useRef } from 'react';
import { fetchAvailableSprints, type SprintOption } from '@/api/tasks';

interface SprintPickerProps {
  sprint: string | undefined;
  onSprintChange: (sprintName: string | null) => void;
}

/**
 * Interactive sprint picker — clickable pill that opens a dropdown
 * with available sprints from the plugin cache.
 */
export function SprintPicker({ sprint, onSprintChange }: SprintPickerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sprints, setSprints] = useState<SprintOption[]>([]);
  const [currentSprintName, setCurrentSprintName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const handleOpen = async () => {
    if (!open) {
      setLoading(true);
      const { sprints: data, current } = await fetchAvailableSprints();
      setSprints(data);
      setCurrentSprintName(current);
      setLoading(false);
    }
    setOpen(!open);
  };

  const handleSelect = (name: string | null) => {
    onSprintChange(name);
    setOpen(false);
  };

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={`sprint-picker-pill${!sprint ? ' sprint-picker-empty-pill' : ''}`}
        onClick={handleOpen}
        title={sprint ? `Sprint: ${sprint}` : 'Set sprint'}
      >
        {sprint || '+ Sprint'}
      </button>
      {open && (
        <div className="sprint-picker-dropdown">
          {loading ? (
            <div className="sprint-picker-empty">Loading...</div>
          ) : sprints.length === 0 ? (
            <div className="sprint-picker-empty">No sprints available</div>
          ) : (
            <>
              {sprint && (
                <button
                  className="sprint-picker-option sprint-picker-clear"
                  onClick={() => handleSelect(null)}
                >
                  Clear sprint
                </button>
              )}
              {sprints.map((s) => (
                <button
                  key={s.id}
                  className={`sprint-picker-option${sprint === s.name ? ' sprint-picker-active' : ''}${s.name === currentSprintName ? ' sprint-picker-current' : ''}`}
                  onClick={() => handleSelect(s.name)}
                >
                  <span>{s.name}</span>
                  {s.name === currentSprintName && <span className="sprint-picker-current-badge">current</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
