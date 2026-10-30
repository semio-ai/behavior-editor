// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BehaviorFile } from "./file-access";
import {
  RECENT_LIMIT,
  type RecentStore,
  forgetFile,
  heldInMemory,
  indexedDbStore,
  listRecent,
  memoryStore,
  openRecentStore,
  rememberFile,
  useRecentFiles,
} from "./recent-files";

const file = (name: string): BehaviorFile => ({ name, format: "bt", handle: null });

/** A handle as the File System Access API gives one: the same file when its path is. */
const handle = (path: string) =>
  ({
    name: path.split("/").at(-1)!,
    path,
    isSameEntry(other: { path?: string }) {
      return Promise.resolve(other.path === path);
    },
  }) as unknown as FileSystemFileHandle;

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recent files", () => {
  it("keeps the files newest first, a file opened again moving to the top", async () => {
    const store = await indexedDbStore();
    await rememberFile(store, file("a.bt"), "a", 1);
    await rememberFile(store, file("b.bt"), "b", 2);
    const list = await rememberFile(store, file("a.bt"), "a, saved again", 3);
    expect(list.map((e) => [e.name, e.text])).toEqual([
      ["a.bt", "a, saved again"],
      ["b.bt", "b"],
    ]);
  });

  it("is kept in this browser's storage, for the next page to read", async () => {
    await rememberFile(await openRecentStore(), file("kept.yaml"), "nodes: []", 1);
    const again = await listRecent(await openRecentStore());
    expect(again.map((e) => e.name)).toEqual(["kept.yaml"]);
  });

  it(`keeps ${RECENT_LIMIT} files, forgetting the oldest`, async () => {
    const store = await indexedDbStore();
    for (let i = 0; i < RECENT_LIMIT + 2; i += 1) {
      await rememberFile(store, file(`f${i}.bt`), "", i);
    }
    const list = await listRecent(store);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]!.name).toBe(`f${RECENT_LIMIT + 1}.bt`);
    expect(list.at(-1)!.name).toBe("f2.bt");
  });

  it("forgets a file on request", async () => {
    const store = await indexedDbStore();
    await rememberFile(store, file("a.bt"), "a", 1);
    const [b] = await rememberFile(store, file("b.bt"), "b", 2);
    expect((await forgetFile(store, b!.id)).map((e) => e.name)).toEqual(["a.bt"]);
  });

  it("remembers a file by its handle, and the same file once whatever its name", async () => {
    const store = memoryStore();
    const one = { name: "x.bt", format: "bt" as const, handle: handle("/one/x.bt") };
    const other = { name: "x.bt", format: "bt" as const, handle: handle("/two/x.bt") };
    await rememberFile(store, one, "first", 1);
    await rememberFile(store, other, "other", 2);
    const list = await rememberFile(store, one, "first, again", 3);
    expect(list.map((e) => [(e.handle as unknown as { path: string }).path, e.text])).toEqual([
      ["/one/x.bt", "first, again"],
      ["/two/x.bt", "other"],
    ]);
  });

  it("remembers a file by its contents where storage cannot keep its handle", async () => {
    const store = await indexedDbStore();
    // A handle carries functions, which IndexedDB's structured clone refuses here.
    const list = await rememberFile(
      store,
      { name: "x.bt", format: "bt", handle: handle("/x.bt") },
      "the text",
      1,
    );
    expect(list).toEqual([
      expect.objectContaining({ name: "x.bt", handle: null, text: "the text" }),
    ]);
  });

  it("keeps a handle storage cannot keep for as long as the page, and the file once", async () => {
    const x = { name: "x.bt", format: "bt" as const, handle: handle("/x.bt") };
    const page = await openRecentStore();
    const [kept] = await rememberFile(page, x, "first", 1);
    expect(kept!.handle).toBe(x.handle);
    // The next page reads the entry by its contents, and saving the file again replaces it.
    const next = await openRecentStore();
    expect((await listRecent(next)).map((e) => [e.handle, e.text])).toEqual([[null, "first"]]);
    const list = await rememberFile(next, x, "second", 2);
    expect(list.map((e) => [e.id, e.text])).toEqual([[kept!.id, "second"]]);
  });

  it("goes on in memory when storage fails once open", async () => {
    let failing = false;
    const kept = memoryStore();
    const store = heldInMemory({
      list: () => (failing ? Promise.reject(new Error("gone")) : kept.list()),
      put: (e) => (failing ? Promise.reject(new Error("quota")) : kept.put(e)),
      remove: (id) => (failing ? Promise.reject(new Error("gone")) : kept.remove(id)),
    });
    const [a] = await rememberFile(store, file("a.bt"), "a", 1);
    failing = true;
    await rememberFile(store, file("b.bt"), "b", 2);
    expect((await listRecent(store)).map((e) => e.name)).toEqual(["b.bt", "a.bt"]);
    expect((await forgetFile(store, a!.id)).map((e) => e.name)).toEqual(["b.bt"]);
  });

  it("makes each change from the list the one before left", async () => {
    const store = Promise.resolve(memoryStore());
    const open = () => store;
    const { result } = renderHook(() => useRecentFiles(open));
    act(() => {
      result.current.remember(file("a.bt"), "1");
      result.current.remember(file("a.bt"), "2");
      for (let i = 0; i < RECENT_LIMIT + 2; i += 1) result.current.remember(file(`f${i}.bt`), "");
    });
    await waitFor(() => expect(result.current.files).toHaveLength(RECENT_LIMIT));
    expect(result.current.files.filter((e) => e.name === "a.bt")).toEqual([]);
    expect(result.current.files[0]!.name).toBe(`f${RECENT_LIMIT + 1}.bt`);
  });

  it("makes the changes of two editors sharing a store one after the other", async () => {
    const store = Promise.resolve(memoryStore());
    const open = () => store;
    const one = renderHook(() => useRecentFiles(open));
    const two = renderHook(() => useRecentFiles(open));
    act(() => {
      for (let i = 0; i < RECENT_LIMIT; i += 1) one.result.current.remember(file(`a${i}.bt`), "");
      for (let i = 0; i < RECENT_LIMIT; i += 1) two.result.current.remember(file(`a${i}.bt`), "");
      two.result.current.remember(file("last.bt"), "");
    });
    await waitFor(() => expect(two.result.current.files[0]?.name).toBe("last.bt"));
    const list = await listRecent(await store);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(new Set(list.map((e) => e.name)).size).toBe(RECENT_LIMIT);
  });

  it("lists nothing it did not write", async () => {
    const store = await indexedDbStore();
    await rememberFile(store, file("a.bt"), "a", 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("semio-behavior-editor", 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("recent-files", "readwrite");
      tx.objectStore("recent-files").put({ id: "junk", name: 3 });
      tx.oncomplete = resolve;
    });
    expect((await listRecent(store)).map((e) => e.name)).toEqual(["a.bt"]);
  });

  it("keeps the list in memory where IndexedDB is missing or does not open", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const store = await openRecentStore();
    await rememberFile(store, file("a.bt"), "a", 1);
    expect((await listRecent(store)).map((e) => e.name)).toEqual(["a.bt"]);
    vi.stubGlobal("indexedDB", {
      open() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(await listRecent(await openRecentStore())).toEqual([]);
  });

  it("fails nothing when storage fails", async () => {
    const failing: RecentStore = {
      list: () => Promise.reject(new Error("quota")),
      put: () => Promise.reject(new Error("quota")),
      remove: () => Promise.reject(new Error("quota")),
    };
    expect(await rememberFile(failing, file("a.bt"), "a")).toEqual([]);
    expect(await forgetFile(failing, "a")).toEqual([]);
    expect(await listRecent(failing)).toEqual([]);
  });
});
