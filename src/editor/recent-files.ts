/**
 * The files a person opened or saved lately, remembered per browser in
 * IndexedDB: a file by its File System Access handle where the browser keeps
 * one, so it opens again without a picker; otherwise by its name and its
 * contents as last opened or saved. Where storage is unavailable (a private
 * window, storage blocked) or fails, the list lives as long as the page, and
 * nothing the editor does fails for it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** Its handle, where the browser gives one and keeps it in storage. */
  handle: FileSystemFileHandle | null;
  /** Its contents as last opened or saved, kept when there is no handle to read it from. */
  text: string | null;
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
    (e.handle != null || typeof e.text === "string")
  );
}

/** Entries kept in IndexedDB, for this browser and this page's origin. */
export async function indexedDbStore(): Promise<RecentStore> {
  const db = await opened();
  return {
    list: () =>
      new Promise((resolve, reject) => {
        const request = db.transaction(ENTRIES, "readonly").objectStore(ENTRIES).getAll();
        request.onsuccess = () => resolve(newest((request.result as unknown[]).filter(isRecentFile)));
        request.onerror = () => reject(request.error ?? new Error("IndexedDB refused the read"));
      }),
    put: (entry) => transact(db, (entries) => entries.put(entry)),
    remove: (id) => transact(db, (entries) => entries.delete(id)),
  };
}

/** The store of this browser: IndexedDB, or memory where it does not open. */
export async function openRecentStore(): Promise<RecentStore> {
  try {
    if (typeof indexedDB === "undefined") return memoryStore();
    return await indexedDbStore();
  } catch {
    return memoryStore();
  }
}

const newId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Whether `entry` is the file `file` names: the same handle's file, or a handle-less file of its name. */
async function names(entry: RecentFile, file: BehaviorFile): Promise<boolean> {
  if (!file.handle || !entry.handle) return !file.handle && !entry.handle && entry.name === file.name;
  try {
    return await entry.handle.isSameEntry(file.handle);
  } catch {
    return false;
  }
}

/**
 * Remember `file`, whose contents are `text`, as the newest entry, in place of
 * the entry for the same file, and forget the entries past the limit. A handle
 * storage cannot keep is remembered by the file's contents instead. Answers
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
      at: now,
      handle: file.handle,
      text: file.handle ? null : text,
    };
    try {
      await store.put(entry);
    } catch (error) {
      if (!entry.handle) throw error;
      await store.put({ ...entry, handle: null, text });
    }
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

/** The recent files of this browser, kept in `store` (this browser's by default). */
export function useRecentFiles(
  store: () => Promise<RecentStore> = openRecentStore,
): RecentFiles {
  const held = useMemo(() => store(), [store]);
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
      held.then((s) => rememberFile(s, file, text)).then(setFiles);
    },
    [held],
  );
  const forget = useCallback(
    (id: string) => {
      held.then((s) => forgetFile(s, id)).then(setFiles);
    },
    [held],
  );
  return { files, remember, forget };
}
