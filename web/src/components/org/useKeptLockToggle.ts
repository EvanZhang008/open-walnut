/**
 * The lock on a kept row of the Org list (OrgKeptWhy; 2026-11-17, the user: "when I click this little
 * lock in the sidebar, it can unlock"). Unlocking does what the panel's own lock button does on this
 * page: a panel beside the page goes through its own toggle (togglePanelLock), a pin under another
 * node leaves the pins, and a lock Home holds is taken off this page (homeOff), never off Home. The
 * row stays with an open lock until the page closes, and a second click puts back exactly what the
 * first one took.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionSlot } from '@/pages/sessionColumns';
import { HOME_OFF_MAX, homeSlotKey, type OrgPin } from './org-side-columns';
import { slotTask } from './org-task-tabs';
import { useLeanCallback } from '@/hooks/useLeanCallback';

interface Undone { pins: OrgPin[]; home: string[]; node?: string }

export function useKeptLockToggle({ tasks, locked, pins, setPins, homeLocks, homeOff, setHomeOff, strip, togglePanelLock }: {
  tasks: readonly Task[];
  /** The tasks locked here now (lockedTaskIds). */
  locked: readonly string[];
  pins: readonly OrgPin[];
  setPins: (next: (prev: OrgPin[]) => OrgPin[]) => void;
  /** Home's locked slots this page shows (homeOff already left out). */
  homeLocks: readonly SessionSlot[];
  homeOff: readonly string[];
  setHomeOff: (next: string[]) => void;
  /** The panels beside the page now. */
  strip: readonly SessionSlot[];
  togglePanelLock: (id: string) => void;
}) {
  const [undone, setUndone] = useState<ReadonlyMap<string, Undone>>(() => new Map());
  // Locked again another way (its panel's own lock), a row forgets what this one undid: unlocked
  // later at the panel, it goes as any other.
  useEffect(() => {
    setUndone((prev) => (locked.some((id) => prev.has(id)) ? new Map([...prev].filter(([id]) => !locked.includes(id))) : prev));
  }, [locked]);
  const ofTask = useLeanCallback((id: string, taskId: string) => slotTask(id, tasks)?.id === taskId, [tasks]);

  const toggle = useLeanCallback((taskId: string) => {
    const mine = pins.filter((p) => ofTask(p.id, taskId));
    const home = homeLocks.filter((s) => s.locked && ofTask(s.id, taskId)).map((s) => homeSlotKey(s.id));
    if (mine.length || home.length) {
      // A panel standing beside the page unlocks through its own button's code.
      const shown = strip.find((c) => c.locked && ofTask(c.id, taskId));
      if (shown) togglePanelLock(shown.id);
      // Whatever else locks it here (a pin under another node, a lock Home holds) goes the same way.
      setPins((prev) => prev.filter((p) => !mine.some((m) => m.id === p.id && m.node === p.node)));
      if (home.length) setHomeOff([...homeOff, ...home.filter((h) => !homeOff.includes(h))].slice(-HOME_OFF_MAX));
      setUndone((prev) => new Map(prev).set(taskId, { pins: mine, home, ...(mine[0]?.node ? { node: mine[0].node } : {}) }));
      return;
    }
    const back = undone.get(taskId);
    if (!back) return;
    setPins((prev) => [...prev, ...back.pins.filter((p) => !prev.some((q) => q.id === p.id && q.node === p.node))]);
    if (back.home.length) setHomeOff(homeOff.filter((h) => !back.home.includes(h)));
    setUndone((prev) => { const next = new Map(prev); next.delete(taskId); return next; });
  }, [undone, pins, homeLocks, homeOff, strip, ofTask, setPins, setHomeOff, togglePanelLock]);

  // Rows unlocked here, with the node they were locked beside (keptByRow keeps them in place).
  const relockable = useMemo(() => new Map([...undone].map(([id, u]) => [id, u.node])), [undone]);
  return { toggle, relockable };
}
