/** Line icons for the Passwords app (24px grid, currentColor). */
interface P { size?: number }
const svg = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export const KeyIcon = ({ size = 18 }: P) => svg(size, <><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 20 3" /><path d="m16 7 3 3" /><path d="m18 5 2 2" /></>)
export const LockIcon = ({ size = 18 }: P) => svg(size, <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>)
export const StarIcon = ({ size = 18, filled = false }: P & { filled?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" /></svg>
)
export const GridIcon = ({ size = 18 }: P) => svg(size, <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>)
export const UserKeyIcon = ({ size = 18 }: P) => svg(size, <><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 11-5.7" /><circle cx="17.5" cy="16.5" r="2.5" /><path d="M19.3 18.3 22 21" /></>)
export const ClockIcon = ({ size = 18 }: P) => svg(size, <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)
export const CodeIcon = ({ size = 18 }: P) => svg(size, <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m13.5 5-3 14" /></>)
export const NoteIcon = ({ size = 18 }: P) => svg(size, <><path d="M5 3h10l4 4v14H5z" /><path d="M9 11h6M9 15h6M9 7h3" /></>)
export const CardIcon = ({ size = 18 }: P) => svg(size, <><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6 15h4" /></>)
export const ShieldIcon = ({ size = 18 }: P) => svg(size, <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" /><path d="m9 12 2 2 4-4" /></>)
export const TrashIcon = ({ size = 18 }: P) => svg(size, <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>)
export const PlusIcon = ({ size = 18 }: P) => svg(size, <><path d="M12 5v14M5 12h14" /></>)
export const SearchIcon = ({ size = 16 }: P) => svg(size, <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
export const CopyIcon = ({ size = 16 }: P) => svg(size, <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>)
export const EyeIcon = ({ size = 16 }: P) => svg(size, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>)
export const EyeOffIcon = ({ size = 16 }: P) => svg(size, <><path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>)
export const DiceIcon = ({ size = 16 }: P) => svg(size, <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1" fill="currentColor" /><circle cx="15.5" cy="15.5" r="1" fill="currentColor" /><circle cx="15.5" cy="8.5" r="1" fill="currentColor" /><circle cx="8.5" cy="15.5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>)
export const ImportIcon = ({ size = 16 }: P) => svg(size, <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" /></>)
export const LinkIcon = ({ size = 14 }: P) => svg(size, <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v6H4V6h6" /></>)
export const RobotIcon = ({ size = 16 }: P) => svg(size, <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13v1M15 13v1M9 17h6" /></>)
export const RestoreIcon = ({ size = 16 }: P) => svg(size, <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>)
export const EditIcon = ({ size = 16 }: P) => svg(size, <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>)
export const CheckIcon = ({ size = 16 }: P) => svg(size, <><path d="m5 12 5 5 9-10" /></>)
export const CloseIcon = ({ size = 16 }: P) => svg(size, <><path d="M6 6l12 12M18 6 6 18" /></>)
