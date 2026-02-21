interface StarButtonProps {
  starred: boolean;
  onClick: () => void;
}

export function StarButton({ starred, onClick }: StarButtonProps) {
  return (
    <button
      className="star-button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={starred ? 'Unstar' : 'Star'}
      title={starred ? 'Unstar' : 'Star'}
    >
      {starred ? '\u2605' : '\u2606'}
    </button>
  );
}
