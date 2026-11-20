/**
 * The `topics` experiment (src/core/experimental.ts): every topic surface renders only while it is
 * on. The hook is for views; `topicsOnNow` for a menu built at the click.
 */
import { experimentalOn, useExperimental } from '@/hooks/useExperimental';

export const useTopicsOn = (): boolean => useExperimental('topics');
export const topicsOnNow = (): boolean => experimentalOn('topics');
