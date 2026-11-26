/**
 * What the desktop app's Rust side gives its page (app/src-tauri): what the
 * command line asked for, and the person's files, by path, through native
 * dialogs.
 */
import {
  type BehaviorFile,
  type FileAccess,
  FILE_FORMATS,
  type FileFormat,
  formatNamed,
} from "../src";

/** Tauri's IPC, which the app's config puts on the page (`withGlobalTauri`). */
interface Tauri {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
}
const invoke = <T>(command: string, args?: Record<string, unknown>) =>
  (window as unknown as { __TAURI__: Tauri }).__TAURI__.core.invoke<T>(command, args);

/** A file the Rust side read: where it is, its name, and its text. */
interface HostFile {
  path: string;
  name: string;
  text: string;
}

/** What the app was started with. */
export interface Startup {
  /** The file named on the command line, read. */
  file: HostFile | null;
  /** The bridge of the device to connect to as the page loads. */
  device: string | null;
  /** The store keys plotted from the start. */
  plot: string[];
}

export const startup = () => invoke<Startup>("startup");

/** Tell the app whether the file holds changes not saved: closing the window over them asks first. */
export const setUnsaved = (unsaved: boolean) => {
  void invoke("set_unsaved", { unsaved }).catch(() => {});
};

const opened = (file: HostFile): BehaviorFile & { text: string } => ({
  name: file.name,
  format: formatNamed(file.name),
  handle: file.path,
  text: file.text,
});

/** A dialog's filter for `format`, or for every format the editor opens. */
const filters = (format?: FileFormat) =>
  (format ? FILE_FORMATS.filter((f) => f.format === format) : FILE_FORMATS).map((f) => ({
    name: f.label,
    extensions: f.extensions.map((e) => e.replace(/^\./, "")),
  }));

/** The person's files, by path: native dialogs, read and written by the app's Rust side. */
export const hostFiles: FileAccess = {
  open: async () => {
    const file = await invoke<HostFile | null>("open_file", { filters: filters() });
    return file && opened(file);
  },
  reopen: async (recent) => {
    if (typeof recent.handle !== "string") return { ...recent, handle: null };
    return opened(await invoke<HostFile>("read_file", { path: recent.handle }));
  },
  save: async (text, file, saveAs) => {
    const path = saveAs || typeof file.handle !== "string" ? null : file.handle;
    const saved = await invoke<HostFile | null>("save_file", {
      path,
      suggestedName: file.name,
      filters: filters(file.format),
      text,
    });
    if (!saved) return null;
    // A file opens in the format its name says: the Rust side checked the name before writing.
    return { name: saved.name, format: file.format, handle: saved.path };
  },
};
