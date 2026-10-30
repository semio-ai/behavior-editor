/**
 * The files a person opened or saved lately, remembered per browser in
 * IndexedDB: a file by its File System Access handle where the browser keeps
 * one, so it opens again without a picker; otherwise by its name and its
 * contents as last opened or saved. The list is also held in memory, which
 * goes on alone where storage is unavailable (a private window, storage
 * blocked) or fails: the list then lives as long as the page, and nothing the
 * editor does fails for it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BehaviorFile } from "./file-access";
import { FILE_FORMATS, type FileFormat } from "./file-formats";

/** How many files the list keeps: the oldest goes first. */
export const RECENT_LIMIT = 10;

/** A file opened or saved lately. */
export interface RecentFile {
  /** The entry's own id, which removing it names. */
  id: string;
  name: string;
  format: FileFormat;
  /** When it was last opened or saved, in milliseconds since the epoch. */
  at: number;
  /** Its handle, where the browser gives one and storage keeps it. */
  handle: FileSystemFileHandle | null;
  /** Its contents as last opened or saved: what it opens from without its handle. */
  text: string;
}

/** Where the entries are kept. Every operation may reject: storage may fail at any time. */
export interface RecentStore {
  /** The entries, newest first. */
  list(): Promise<RecentFile[]>;
  put(entry: RecentFile): Promise<void>;
  remove(id: string): Promise<void>;
}

const DATABASE = "semio-behavior-editor";
const ENTRIES = "recent-files";

const newest = (entries: RecentFile[]) => [...entries].sort((a, b) => b.at - a.at);

/** Entries kept in memory, as long as the page. */
export function memoryStore(): RecentStore {
  let entries: RecentFile[] = [];
  return {
    list: () => Promise.resolve(newest(entries)),
    put: (entry) => {
      entries = [...entries.filter((e) => e.id !== entry.id), entry];
      return Promise.resolve();
    },
    remove: (id) => {
      entries = entries.filter((e) => e.id !== id);
      return Promise.resolve();
    },
  };
}

function opened(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(ENTRIES, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"));
    request.onblocked = () => reject(new Error("IndexedDB is held by another version"));
  });
}

/** Run `change` in a read-write transaction, answering once it commits. */
function transact(db: IDBDatabase, change: (entries: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ENTRIES, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB refused the write"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted the write"));
    // A value it cannot store, a handle it cannot clone, throws here.
    change(tx.objectStore(ENTRIES));
  });
}

/** Whether `entry`, as storage holds it, is one this editor wrote. */
function isRecentFile(entry: unknown): entry is RecentFile {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Partial<RecentFile>;
  return (
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    typeof e.at === "number" &&
    FILE_FORMATS.some((f) => f.format === e.format) &&
    typeof e.text === "string"
  );
}

/**
 * Entries kept in IndexedDB, for this browser and this page's origin. A handle
 * this browser cannot store is left out: its entry opens from its contents.
 */
export async function indexedDbStore(): Promise<RecentStore> {
  const db = await opened();
  const put = (entry: RecentFile) => transact(db, (entries) => entries.put(entry));
  return {
    list: () =>
      new Promise((resolve, reject) => {
        const request = db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll();
        request.onsuccess = () =>
          resolve(newest((request.result as unknown[]).filter(isRecentFile)));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB refused the read"));
      }),
    put: async (entry) => {
      try {
        await put(entry);
      } catch (error) {
        if (!entry.handle) throw error;
        await put({ ...entry, handle: null });
      }
    },
    remove: (id) => transact(db, (entries) => entries.delete(id)),
  };
}

/**
 * `kept`, its entries also held in memory, with the handles it could not
 * keep: once it fails, the memory goes on alone, so an operation never fails
 * and the list stays as the page made it.
 */
export function heldInMemory(kept: RecentStore): RecentStore {
  let held = new Map<string, RecentFile>();
  let failed = false;
  const attempt = async (operation: () => Promise<void>) => {
    if (failed) return;
    try {
      await operation();
    } catch {
      failed = true;
    }
  };
  return {
    list: async () => {
      if (!failed) {
        try {
          const entries = await kept.list();
          held = new Map(
            entries.map((e) => [
              e.id,
              { ...e, handle: e.handle ?? held.get(e.id)?.handle ?? null },
            ]),
          );
        } catch {
          failed = true;
        }
      }
      return newest([...held.values()]);
    },
    put: async (entry) => {
      held.set(entry.id, entry);
      await attempt(() => kept.put(entry));
    },
    remove: async (id) => {
      held.delete(id);
      await attempt(() => kept.remove(id));
    },
  };
}

/** The store of this browser: IndexedDB held in memory, or memory alone where it does not open. */
export async function openRecentStore(): Promise<RecentStore> {
  try {
    if (typeof indexedDB === "undefined") return memoryStore();
    return heldInMemory(await indexedDbStore());
  } catch {
    return memoryStore();
  }
}

const newId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Whether `entry` is the file `file` names: the same handle's file, or, where
 * either has no handle, the file of its name.
 */
async function names(entry: RecentFile, file: BehaviorFile): Promise<boolean> {
  if (!file.handle || !entry.handle) return entry.name === file.name;
  try {
    return await entry.handle.isSameEntry(file.handle);
  } catch {
    return false;
  }
}

/**
 * Remember `file`, whose contents are `text`, as the newest entry, in place of
 * the entry for the same file, and forget the entries past the limit. Answers
 * the list as storage holds it after, or as it was where it fails.
 */
export async function rememberFile(
  store: RecentStore,
  file: BehaviorFile,
  text: string,
  now = Date.now(),
): Promise<RecentFile[]> {
  try {
    const entries = await store.list();
    let same: RecentFile | undefined;
    for (const entry of entries) {
      if (await names(entry, file)) {
        same = entry;
        break;
      }
    }
    const entry: RecentFile = {
      id: same?.id ?? newId(now),
      name: file.name,
      format: file.format,
      // After every other entry, whatever the clock says: the list is in this order.
      at: Math.max(now, (entries[0]?.at ?? 0) + 1),
      handle: file.handle,
      text,
    };
    await store.put(entry);
    const kept = [entry, ...entries.filter((e) => e.id !== entry.id)];
    for (const old of kept.slice(RECENT_LIMIT)) await store.remove(old.id);
    return await store.list();
  } catch {
    return listRecent(store);
  }
}

/** Forget the entry `id`; answers the list after, or as it was where it fails. */
export async function forgetFile(store: RecentStore, id: string): Promise<RecentFile[]> {
  try {
    await store.remove(id);
  } catch {
    // The entry stays listed: the list says what storage holds.
  }
  return listRecent(store);
}

/** The entries, newest first; none where storage fails. */
export async function listRecent(store: RecentStore): Promise<RecentFile[]> {
  try {
    return (await store.list()).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export interface RecentFiles {
  /** The entries, newest first. */
  files: readonly RecentFile[];
  /** Remember a file opened or saved, with its contents as opened or saved. */
  remember(file: BehaviorFile, text: string): void;
  forget(id: string): void;
}

let thisPage: Promise<RecentStore> | null = null;

/**
 * This page's store, opened once: every editor on the page shares it, and
 * its memory, the list where storage fails, lasts as long as the page.
 */
function pageStore(): Promise<RecentStore> {
  thisPage ??= openRecentStore();
  return thisPage;
}

/** Open this page's store afresh at its next use, as a new page would: for tests. */
export function reopenPageStore() {
  thisPage = null;
}

/**
 * The recent files of this browser, kept in `store` (this browser's by
 * default). Each change waits for the one before, so each starts from the
 * list the one before left.
 */
export function useRecentFiles(store: () => Promise<RecentStore> = pageStore): RecentFiles {
  const held = useMemo(() => store(), [store]);
  const changes = useRef<Promise<unknown>>(Promise.resolve());
  const change = useCallback(
    (run: (s: RecentStore) => Promise<RecentFile[]>) => {
      const next = changes.current.then(() => held).then(run);
      changes.current = next.catch(() => undefined);
      return next;
    },
    [held],
  );
  const [files, setFiles] = useState<readonly RecentFile[]>([]);
  useEffect(() => {
    let current = true;
    held.then(listRecent).then((list) => current && setFiles(list));
    return () => {
      current = false;
    };
  }, [held]);
  const remember = useCallback(
    (file: BehaviorFile, text: string) => {
      change((s) => rememberFile(s, file, text)).then(setFiles);
    },
    [change],
  );
  const forget = useCallback(
    (id: string) => {
      change((s) => forgetFile(s, id)).then(setFiles);
    },
    [change],
  );
  return { files, remember, forget };
}
