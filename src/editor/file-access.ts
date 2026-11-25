/**
 * Local behavior files, in every format of `FILE_FORMATS`. In a browser
 * (`browserFiles`): through the File System Access API where the browser has
 * it, which keeps a handle so Save writes the file in place; otherwise a file
 * input to open and a download to save. A host with files of its own, a
 * desktop app, gives its `FileAccess` instead. Opening and saving take the
 * same paths whatever the format.
 */
import {
  FILE_FORMATS,
  type FileFormat,
  extensionsOf,
  formatOf,
  labelOf,
  mimeOf,
  withExtension,
} from "./file-formats";

/**
 * Where a file is: a File System Access handle in a browser, or a path, for a
 * host's `FileAccess` reaching files by path.
 */
export type FileHandle = FileSystemFileHandle | string;

/**
 * A file the editor opened or saved: its name, its format, and its handle
 * when the browser, or the host, gives one.
 */
export interface BehaviorFile {
  name: string;
  format: FileFormat;
  handle: FileHandle | null;
}

/**
 * How the editor opens and saves files: the browser's (`browserFiles`) by
 * default, or a host's own, as a desktop app's dialogs and paths. Each answers
 * `null` where the person dismissed a dialog, and rejects with a message to
 * show otherwise.
 */
export interface FileAccess {
  /** Ask for a file to open: its text, and the format its name says. */
  open(): Promise<(BehaviorFile & { text: string }) | null>;
  /**
   * Open a file opened or saved before: through its handle, or, without one
   * this access reaches, from the contents kept with it.
   */
  reopen(recent: BehaviorFile & { text: string }): Promise<BehaviorFile & { text: string }>;
  /**
   * Write `text`, in `file`'s format, to `file`'s handle; with no handle, or
   * `saveAs`, ask where first, and refuse a name with another format's
   * extension.
   */
  save(text: string, file: BehaviorFile, saveAs: boolean): Promise<BehaviorFile | null>;
}

interface PickerOptions {
  suggestedName?: string;
  types: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption?: boolean;
}

/** The pickers of the File System Access API, which not every browser has. */
interface FilePickers {
  showOpenFilePicker?(options: PickerOptions): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(options: PickerOptions): Promise<FileSystemFileHandle>;
}

/** The picker's entry for one format, or for every format the editor opens. */
const typesOf = (format?: FileFormat): PickerOptions["types"] =>
  format
    ? [
        {
          description: labelOf(format),
          accept: { [mimeOf(format)]: [...extensionsOf(format)] },
        },
      ]
    : [
        {
          description: "Behavior",
          accept: Object.fromEntries(FILE_FORMATS.map((f) => [f.mime, [...f.extensions]])),
        },
      ];

const ACCEPT = FILE_FORMATS.flatMap((f) => f.extensions).join(",");

/** The format of a file `name` names, which a file of no known extension is refused for. */
export function formatNamed(name: string): FileFormat {
  const format = formatOf(name);
  if (!format) {
    throw new Error(
      `${name} is in no format the editor opens: ${FILE_FORMATS.flatMap((f) => f.extensions).join(", ")}`,
    );
  }
  return format;
}

const pickers = () => window as unknown as FilePickers;

/** Whether `error` is the person dismissing a picker. */
const dismissed = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * Ask for a file to open: its text and the format its name says, or `null`
 * when the person dismissed the picker.
 */
export async function openBehaviorFile(): Promise<(BehaviorFile & { text: string }) | null> {
  const { showOpenFilePicker } = pickers();
  if (showOpenFilePicker) {
    try {
      const [handle] = await showOpenFilePicker.call(window, { types: typesOf() });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, format: formatNamed(file.name), handle, text: await file.text() };
    } catch (error) {
      if (dismissed(error)) return null;
      throw error;
    }
  }
  const file = await chooseFile();
  return file
    ? { name: file.name, format: formatNamed(file.name), handle: null, text: await file.text() }
    : null;
}

/** A handle's permission calls, which the DOM's types do not carry yet. */
interface PermissionedHandle {
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/**
 * Open a file the editor opened or saved before, as `openBehaviorFile` opens
 * one: through its handle, asking the person to let the page read it again
 * where the browser asks; or, without one, from the contents kept with it.
 */
export async function reopenBehaviorFile(recent: {
  name: string;
  format: FileFormat;
  handle: FileSystemFileHandle | null;
  text: string;
}): Promise<BehaviorFile & { text: string }> {
  const { handle } = recent;
  // A path is a host's: a browser opens that file from its contents.
  if (!handle || typeof handle === "string") return { name: recent.name, format: recent.format, handle: null, text: recent.text };
  const permissioned = handle as FileSystemFileHandle & PermissionedHandle;
  const mode = { mode: "read" } as const;
  if (permissioned.queryPermission && (await permissioned.queryPermission(mode)) !== "granted") {
    const answer = await permissioned.requestPermission?.(mode);
    if (answer !== "granted") throw new Error(`${recent.name} was not opened: reading it was not allowed`);
  }
  let file: File;
  try {
    file = await handle.getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      throw new Error(`${recent.name} is no longer where it was saved`);
    }
    throw error;
  }
  return { name: file.name, format: formatNamed(file.name), handle, text: await file.text() };
}

/**
 * Write `text`, in `file`'s format, to `file`'s handle; with no handle, or
 * `saveAs`, ask where first, offering that format only, and refuse a name
 * with another format's extension. Without the API, the text
 * downloads under `file`'s name. `null` when the person dismissed the picker.
 */
export async function saveBehaviorFile(
  text: string,
  file: BehaviorFile,
  saveAs: boolean,
): Promise<BehaviorFile | null> {
  const { showSaveFilePicker } = pickers();
  // A file opens in the format its name says: a name saying none takes the format's extension.
  const name = formatOf(file.name) === null ? withExtension(file.name, file.format) : file.name;
  if (!showSaveFilePicker) {
    download(text, name, mimeOf(file.format));
    return { ...file, name, handle: null };
  }
  let handle = saveAs || typeof file.handle === "string" ? null : file.handle;
  if (!handle) {
    try {
      handle = await showSaveFilePicker.call(window, {
        suggestedName: name,
        types: typesOf(file.format),
        excludeAcceptAllOption: true,
      });
    } catch (error) {
      if (dismissed(error)) return null;
      throw error;
    }
    // A file opens in the format its name says: one named for another is not
    // written, as it would not open as what it holds.
    if (formatOf(handle.name) !== file.format) {
      const extensions = extensionsOf(file.format).join(" or ");
      throw new Error(`${handle.name} is not named as ${labelOf(file.format)}: name it ${extensions}`);
    }
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return { name: handle.name, format: file.format, handle };
}

function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ACCEPT;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function download(text: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** The browser's files: the File System Access API, or a file input and a download. */
export const browserFiles: FileAccess = {
  open: openBehaviorFile,
  reopen: reopenBehaviorFile,
  save: saveBehaviorFile,
};
