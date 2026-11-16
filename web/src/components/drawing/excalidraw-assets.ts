/**
 * Where the drawing editor loads its fonts from: this Walnut's own copy of the package's
 * `dist/prod/fonts`, served and emitted by `excalidrawAssets()` in web/vendor-assets.ts, which
 * also defines `__EXCALIDRAW_ASSET_PATH__` with the installed version. The editor falls back to
 * its CDN only for a font this path failed to answer, so the copy must be whole (it is: the
 * plugin copies the directory as the package ships it).
 */
declare const __EXCALIDRAW_ASSET_PATH__: string | undefined;

/** Fallback for a bundle built without the Vite plugin (a test fixture); kept equal by a test. */
export const EXCALIDRAW_VERSION = '0.18.1';

export const EXCALIDRAW_ASSET_PATH: string = typeof __EXCALIDRAW_ASSET_PATH__ === 'string'
  ? __EXCALIDRAW_ASSET_PATH__
  : `/excalidraw-assets/${EXCALIDRAW_VERSION}/`;

/** Must run before the editor module evaluates: it reads the path when it registers its fonts. */
export function pointEditorAtLocalAssets(): void {
  (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
}

// Imported first by ExcalidrawCanvas.tsx, so this runs before the editor module evaluates.
if (typeof window !== 'undefined') pointEditorAtLocalAssets();
