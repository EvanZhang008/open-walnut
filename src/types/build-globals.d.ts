/**
 * Constants the build bakes in (tsup `define`). Absent when Walnut runs straight
 * from source (tsx, vitest), so every read must go through a `typeof` guard.
 */
declare const __WALNUT_VERSION__: string | undefined;
