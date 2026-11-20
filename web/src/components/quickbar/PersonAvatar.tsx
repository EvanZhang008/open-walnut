import { hueOf, initialsOf, type QuickPerson } from './quickbar-people';

/** A rounded square with a person's letters in their steady color; the CEO is Walnut green. */
export function PersonAvatar({ person, size = 24 }: { person: Pick<QuickPerson, 'id' | 'title' | 'kind'>; size?: number }) {
  const letters = initialsOf(person);
  const hue = person.kind === 'ceo' ? 148 : hueOf(person.id);
  const style = {
    width: size,
    height: size,
    fontSize: letters.length > 1 ? Math.round(size * 0.34) : Math.round(size * 0.5),
    background: person.kind === 'task'
      ? `linear-gradient(140deg, hsl(${hue} 14% 52%), hsl(${hue} 14% 40%))`
      : `linear-gradient(140deg, hsl(${hue} 52% 50%), hsl(${(hue + 24) % 360} 56% 38%))`,
  };
  return <span className="qb-avatar" style={style} aria-hidden="true">{letters}</span>;
}
