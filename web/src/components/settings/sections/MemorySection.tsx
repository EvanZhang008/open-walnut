import { useNavigate } from 'react-router-dom';
import { SectionCard } from '../inputs/SectionCard';

export function MemorySection() {
  const navigate = useNavigate();

  return (
    <SectionCard
      id="memory"
      title="Memory"
      description="Browse and manage what the butler remembers — long-term memories, skills, and learned context."
    >
      <div className="form-group">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => navigate('/memory')}
        >
          Open Memory Browser
        </button>
      </div>
    </SectionCard>
  );
}
