/**
 * Local `.bt` files: through the File System Access API where the browser has
 * it, which keeps a handle so Save writes the file in place; otherwise a file
 * input to open and a download to save.
 */

/** A file the editor opened or saved: its name, and its handle when the browser gives one. */
export interface BehaviorFile {
  name: string;
  handle: FileSystemFileHandle | null;
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

const TYPES: PickerOptions["types"] = [
  { description: "Behavior", accept: { "text/plain": [".bt"] } },
];

const pickers = () => window as unknown as FilePickers;

/** Whether `error` is the person dismissing a picker. */
const dismissed = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/** Ask for a file to open: its text, or `null` when the person dismissed the picker. */
export async function openBehaviorFile(): Promise<(BehaviorFile & { text: string }) | null> {
  const { showOpenFilePicker } = pickers();
  if (showOpenFilePicker) {
    try {
      const [handle] = await showOpenFilePicker.call(window, { types: TYPES });
      if (!handle) return null;
      const file = await handle.getFile();
      return { name: file.name, handle, text: await file.text() };
    } catch (error) {
      if (dismissed(error)) return null;
      throw error;
    }
  }
  const file = await chooseFile();
  return file ? { name: file.name, handle: null, text: await file.text() } : null;
}

/**
 * Write `text` to `file`'s handle; with no handle, or `saveAs`, ask where
 * first. Without the API, the text downloads under `file`'s name. `null` when
 * the person dismissed the picker.
 */
export async function saveBehaviorFile(
  text: string,
  file: BehaviorFile,
  saveAs: boolean,
): Promise<BehaviorFile | null> {
  const { showSaveFilePicker } = pickers();
  if (!showSaveFilePicker) {
    download(text, file.name);
    return { name: file.name, handle: null };
  }
  let handle = saveAs ? null : file.handle;
  if (!handle) {
    try {
      handle = await showSaveFilePicker.call(window, { suggestedName: file.name, types: TYPES });
    } catch (error) {
      if (dismissed(error)) return null;
      throw error;
    }
  }
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return { name: handle.name, handle };
}

function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bt,text/plain";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
