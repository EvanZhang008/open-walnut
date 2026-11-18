/**
 * Every storage API a browser shows a page in the Files preview, and what the preview does with it
 * (preview-state-script.ts). The guard, tests/e2e/browser/file-html-preview-storage.spec.ts, lists
 * the names the page sees in Chromium and in WebKit that match STORAGE_API_PATTERN and fails on one
 * not listed here: a storage API a newer browser adds gets a decision, never a silent gap.
 *
 *  - 'works': the page has it, kept the way a browser keeps it (the spec tests each one);
 *  - 'type': a class or an event type, nothing to keep;
 *  - 'unsupported': the page cannot have it here, and why.
 */
export type StorageApiDecision = { kind: 'works' | 'type' } | { kind: 'unsupported'; why: string }

/** Names on `window`, `navigator.` and `document.` that the guard checks. */
export const STORAGE_API_PATTERN = /storage|cache|indexeddb|^idb|cookie|database|filesystem|serviceworker/i

const works = { kind: 'works' } as const
const type = { kind: 'type' } as const
const NO_ORIGIN = 'needs a real origin of its own, which the preview never gives a page (it would reach Walnut\'s sign-in); a page opened from a file has none either'

export const STORAGE_APIS: Record<string, StorageApiDecision> = {
  localStorage: works,
  sessionStorage: works,
  'document.cookie': works,
  cookieStore: works,
  'navigator.cookieEnabled': type,
  indexedDB: works,
  webkitIndexedDB: works,
  IDBFactory: works, IDBDatabase: works, IDBTransaction: works, IDBObjectStore: works, IDBIndex: works,
  IDBCursor: works, IDBCursorWithValue: works, IDBKeyRange: works, IDBRequest: works, IDBOpenDBRequest: works,
  IDBVersionChangeEvent: works,
  IDBRecord: type,
  caches: works,
  CacheStorage: type,
  Cache: works,
  'navigator.storage': works,
  StorageManager: type,
  Storage: type,
  StorageEvent: type,
  onstorage: { kind: 'unsupported', why: 'a storage event tells another tab of the same site about a change; a preview page has no other tab' },
  CookieStore: type, CookieStoreManager: type, CookieChangeEvent: type,
  'document.hasStorageAccess': works,
  'document.requestStorageAccess': works,
  'document.requestStorageAccessFor': works,
  'document.hasUnpartitionedCookieAccess': works,
  'navigator.serviceWorker': { kind: 'unsupported', why: `a service worker ${NO_ORIGIN}` },
  ServiceWorker: type, ServiceWorkerContainer: type, ServiceWorkerRegistration: type,
  FileSystemHandle: { kind: 'unsupported', why: `the origin private file system (navigator.storage.getDirectory) ${NO_ORIGIN}` },
  FileSystemFileHandle: type, FileSystemDirectoryHandle: type, FileSystemWritableFileStream: type, FileSystemSyncAccessHandle: type,
  FileSystemObserver: type,
  FileSystem: type, FileSystemEntry: type, FileSystemFileEntry: type, FileSystemDirectoryEntry: type, FileSystemDirectoryReader: type,
  webkitRequestFileSystem: { kind: 'unsupported', why: 'Chromium\'s old sandboxed file system, deprecated and never in WebKit' },
  webkitResolveLocalFileSystemURL: { kind: 'unsupported', why: 'part of Chromium\'s old sandboxed file system' },
  'navigator.webkitPersistentStorage': { kind: 'unsupported', why: 'the quota calls of Chromium\'s old sandboxed file system' },
  'navigator.webkitTemporaryStorage': { kind: 'unsupported', why: 'the quota calls of Chromium\'s old sandboxed file system' },
  openDatabase: { kind: 'unsupported', why: 'Web SQL, removed from Chromium and deprecated in WebKit' },
  SharedStorage: { kind: 'unsupported', why: 'cross-site storage for advertising worklets (Privacy Sandbox), meaningless for a page in the preview' },
  sharedStorage: { kind: 'unsupported', why: 'the Privacy Sandbox shared storage above, as the page reaches it' },
  SharedStorageWorklet: type, SharedStorageAppendMethod: type, SharedStorageClearMethod: type, SharedStorageDeleteMethod: type,
  SharedStorageModifierMethod: type, SharedStorageSetMethod: type,
  'navigator.storageBuckets': { kind: 'unsupported', why: `storage buckets ${NO_ORIGIN}` },
  StorageBucket: type, StorageBucketManager: type,
}
