//! The behavior editor as a desktop app:
//!
//! ```text
//! behavior-editor [FILE] [--device URL] [--plot KEYS] [--size WxH]
//! ```
//!
//! The window holds the editor's page (`app/`, embedded in the binary). The
//! page opens and saves the person's files through this side's commands, by
//! path, with native dialogs. `FILE` opens as the app starts, `--device`
//! connects to a device's open local bridge (`ws://127.0.0.1:9000` is a
//! device's default) instead of starting a local Arora, and `--plot` names
//! the store keys plotted from the start, comma-separated. Closing the window
//! over changes not saved asks first: the page says when it holds any
//! (`set_unsaved`).

// No console window beside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, MenuItemKind};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const USAGE: &str = "behavior-editor [FILE] [--device URL] [--plot KEYS] [--size WxH]";

/// The extensions of the formats the editor opens, as its `FILE_FORMATS` lists them.
const EXTENSIONS: [&str; 5] = ["bt", "json", "yaml", "yml", "xml"];

/// A file read: where it is, its name, and its text.
#[derive(Debug, Serialize)]
struct HostFile {
    path: String,
    name: String,
    text: String,
}

/// What the app was started with, for the page.
#[derive(Serialize)]
struct Startup {
    file: Option<HostFile>,
    device: Option<String>,
    plot: Vec<String>,
}

/// One entry of a dialog's file types: its name and its extensions, without the dot.
#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

/// The extension of `path`'s name, lowercase: what follows its last dot, as
/// the page's `formatOf` reads it, so a name that is only an extension
/// (`.bt`) has one too.
fn extension(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy();
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())
}

/// Saves, one at a time: two saves of a file do not interleave.
static SAVING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Write `text` to `path` whole or not at all: into a file of its own beside
/// it, created for this save alone (never one already there, nor a link),
/// which then takes its place, so a write failing midway (a full disk) leaves
/// the file as it was. A link is saved through: its target is written, and
/// the link stays. The file keeps its permission bits, not what else is
/// attached to the file (ACLs, extended attributes, its owner when another
/// user saves it): the file put in its place is a new one.
fn write_whole(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let _one_at_a_time = SAVING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let (temp, mut file) = (0u32..)
        // A short name, whatever the file's: a name at the length limit still saves.
        .map(|n| path.with_file_name(format!(".be-{}-{n}.saving", std::process::id())))
        .find_map(|temp| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            // Readable by its owner alone until it takes the file's permissions.
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            match options.open(&temp) {
                Ok(file) => Some(Ok((temp, file))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
                Err(e) => Some(Err(e)),
            }
        })
        .expect("a free name")?;
    let written = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| match std::fs::metadata(&path) {
            Ok(was) => file.set_permissions(was.permissions()),
            Err(_) => Ok(()),
        })
        .and_then(|()| {
            drop(file);
            std::fs::rename(&temp, &path)
        });
    if written.is_err() {
        // Only the file this save created.
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// `path` as the page keeps it, to name the file again: refused when it is
/// not UTF-8, as a lossy name would lead a later save to another file.
fn handle(path: &Path) -> Result<String, String> {
    path.to_str().map(String::from).ok_or_else(|| {
        format!(
            "{} is not named in UTF-8: the editor cannot name it again",
            path.display()
        )
    })
}

fn read(path: &Path) -> Result<HostFile, String> {
    let handle = handle(path)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("{} names no file", path.display()))?;
    if !extension(path).is_some_and(|e| EXTENSIONS.contains(&e.as_str())) {
        return Err(format!(
            "{name} is in no format the editor opens: .{}",
            EXTENSIONS.join(", .")
        ));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(HostFile {
        path: handle,
        name,
        text,
    })
}

#[tauri::command]
fn startup(start: State<'_, Start>) -> Result<Startup, String> {
    Ok(Startup {
        file: start.file.as_deref().map(read).transpose()?,
        device: start.device.clone(),
        plot: start.plot.clone(),
    })
}

/// Whether the page's file holds changes not saved, as the page last said.
#[derive(Default)]
struct Unsaved(AtomicBool);

/// The page saying whether its file holds changes not saved.
#[tauri::command]
fn set_unsaved(unsaved: bool, state: State<'_, Unsaved>) {
    state.0.store(unsaved, Ordering::Relaxed);
}

/// The id of the menu's Quit, which closes the window as its close button does.
const QUIT: &str = "quit";

/// Tauri's default menu, its Quit (macOS's application menu's last item)
/// replaced by one closing the window, so quitting asks first over changes
/// not saved: the predefined one ends the app without a close request. Only
/// macOS has the menu: Linux and Windows quit by closing the window.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn guarded_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let items = app_menu.items()?.len();
        if items > 0 {
            app_menu.remove_at(items - 1)?;
        }
        app_menu.append(&MenuItem::with_id(
            app,
            QUIT,
            "Quit",
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    Ok(menu)
}

/// Ask for a file to open, and read it; `None` when the person dismissed the dialog.
#[tauri::command]
async fn open_file(
    app: tauri::AppHandle,
    filters: Vec<Filter>,
) -> Result<Option<HostFile>, String> {
    let mut dialog = app.dialog().file().set_title("Open a behavior");
    for filter in &filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    let Some(picked) = dialog.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    read(&path).map(Some)
}

/// Read a file opened before, from its path.
#[tauri::command]
async fn read_file(path: PathBuf) -> Result<HostFile, String> {
    read(&path)
}

/// Write `text` to `path`; with none, ask where first, offering `filters`, and
/// refuse a name with an extension they do not list. `None` when the person
/// dismissed the dialog.
#[tauri::command]
async fn save_file(
    app: tauri::AppHandle,
    path: Option<PathBuf>,
    suggested_name: String,
    filters: Vec<Filter>,
    text: String,
) -> Result<Option<HostFile>, String> {
    let path = match path {
        Some(path) => path,
        None => {
            let mut dialog = app
                .dialog()
                .file()
                .set_title("Save the behavior")
                .set_file_name(&suggested_name);
            for filter in &filters {
                let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
            let Some(picked) = dialog.blocking_save_file() else {
                return Ok(None);
            };
            let path = picked.into_path().map_err(|e| e.to_string())?;
            // A file opens in the format its name says: one named for another
            // is not written, as it would not open as what it holds.
            let fits = extension(&path).is_some_and(|e| {
                filters
                    .iter()
                    .any(|f| f.extensions.iter().any(|x| x.eq_ignore_ascii_case(&e)))
            });
            if !fits {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let format = filters.first().map_or("its format", |f| f.name.as_str());
                let extensions: Vec<String> = filters
                    .iter()
                    .flat_map(|f| f.extensions.iter().map(|e| format!(".{e}")))
                    .collect();
                return Err(format!(
                    "{name} is not named as {format}: name it {}",
                    extensions.join(" or ")
                ));
            }
            path
        }
    };
    let handle = handle(&path)?;
    write_whole(&path, &text).map_err(|e| format!("{}: {e}", path.display()))?;
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    Ok(Some(HostFile {
        path: handle,
        name,
        text: String::new(),
    }))
}

/// The command line.
#[derive(Default)]
struct Start {
    file: Option<PathBuf>,
    device: Option<String>,
    plot: Vec<String>,
    size: Option<(f64, f64)>,
}

fn parse(args: impl IntoIterator<Item = String>) -> Result<Option<Start>, String> {
    let mut start = Start::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| args.next().ok_or_else(|| format!("{flag} takes a value"));
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--device" => start.device = Some(value("--device")?),
            "--plot" => {
                start.plot = value("--plot")?
                    .split(',')
                    .map(str::trim)
                    .filter(|k| !k.is_empty())
                    .map(String::from)
                    .collect()
            }
            "--size" => {
                let size = value("--size")?;
                let parsed = size
                    .split_once('x')
                    .and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))
                    .filter(|&(w, h): &(f64, f64)| {
                        w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0
                    });
                start.size =
                    Some(parsed.ok_or_else(|| format!("--size {size}: WxH, as 1600x1000"))?);
            }
            flag if flag.starts_with('-') => return Err(format!("{flag}: no such option")),
            _ if start.file.is_some() => return Err(format!("{arg}: one file at a time")),
            _ => {
                let path = PathBuf::from(&arg);
                start.file = Some(std::path::absolute(&path).unwrap_or(path));
            }
        }
    }
    Ok(Some(start))
}

fn main() {
    let start = match parse(std::env::args().skip(1)) {
        Ok(Some(start)) => start,
        Ok(None) => {
            println!("{USAGE}");
            return;
        }
        Err(e) => {
            eprintln!("behavior-editor: {e}\n{USAGE}");
            std::process::exit(2);
        }
    };
    // A file named but not readable fails here, not in a window.
    if let Some(Err(e)) = start.file.as_deref().map(read) {
        eprintln!("behavior-editor: {e}");
        std::process::exit(1);
    }
    let (width, height) = start.size.unwrap_or((1600.0, 1000.0));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(start)
        .manage(Unsaved::default())
        .invoke_handler(tauri::generate_handler![
            startup,
            open_file,
            read_file,
            save_file,
            set_unsaved
        ])
        // Closing over changes not saved asks first; the window closes once
        // the person chooses to lose them.
        .on_window_event(|window, event| {
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if !window.state::<Unsaved>().0.load(Ordering::Relaxed) {
                return;
            }
            api.prevent_close();
            let window = window.clone();
            window
                .dialog()
                .message("The file has changes that are not saved. Close without saving them?")
                .title("Unsaved changes")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Close without saving".into(),
                    "Cancel".into(),
                ))
                .show(move |close| {
                    if close {
                        let _ = window.destroy();
                    }
                });
        })
        .on_menu_event(|app, event| {
            if event.id() == QUIT {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_menu(guarded_menu(app.handle())?)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Behavior editor")
                .inner_size(width, height)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("behavior-editor: {e}");
            std::process::exit(1);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_path_not_in_utf8_is_refused_rather_than_named_lossily() {
        use std::os::unix::ffi::OsStrExt;
        let path = Path::new(std::ffi::OsStr::from_bytes(b"/tmp/tree\xff.bt"));
        assert!(handle(path).unwrap_err().contains("UTF-8"));
        assert!(read(path).is_err());
    }

    #[test]
    fn an_extension_is_what_follows_the_last_dot_as_the_page_reads_it() {
        assert_eq!(extension(Path::new("/r/tree.BT")).as_deref(), Some("bt"));
        assert_eq!(extension(Path::new("/r/.bt")).as_deref(), Some("bt"));
        assert_eq!(extension(Path::new("/r/a.b.json")).as_deref(), Some("json"));
        assert_eq!(extension(Path::new("/r/tree")), None);
    }

    #[test]
    fn a_save_replaces_the_file_whole_and_leaves_nothing_beside_it() {
        let dir = std::env::temp_dir().join(format!("behavior-editor-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tree.bt");
        std::fs::write(&path, "fail\n").unwrap();
        write_whole(&path, "succeed\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "succeed\n");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["tree.bt"]);
        // A name at the length limit saves too.
        let long = dir.join(format!("{}.bt", "a".repeat(252)));
        write_whole(&long, "succeed\n").unwrap();
        std::fs::remove_file(&long).unwrap();
        // Saved through a link: the target changes, the link stays.
        #[cfg(unix)]
        {
            let link = dir.join("link.bt");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            write_whole(&link, "running\n").unwrap();
            assert!(std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "running\n");
            std::fs::remove_file(&link).unwrap();
        }
        // A staging name already taken is left alone.
        let taken = dir.join(format!(".be-{}-0.saving", std::process::id()));
        std::fs::write(&taken, "someone's").unwrap();
        write_whole(&path, "succeed\n").unwrap();
        assert_eq!(std::fs::read_to_string(&taken).unwrap(), "someone's");
        std::fs::remove_file(&taken).unwrap();
        // A write that cannot happen leaves the file as it was.
        assert!(write_whole(&dir.join("missing").join("tree.bt"), "x").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "succeed\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_command_line_names_a_file_a_device_keys_and_a_size() {
        let start = parse(args(
            "tree.bt --device ws://robot:9000 --plot a/b,,c --size 800x600",
        ))
        .unwrap()
        .unwrap();
        assert!(start.file.unwrap().ends_with("tree.bt"));
        assert_eq!(start.device.as_deref(), Some("ws://robot:9000"));
        assert_eq!(start.plot, ["a/b", "c"]);
        assert_eq!(start.size, Some((800.0, 600.0)));
        assert!(parse(args("--help")).unwrap().is_none());
    }

    #[test]
    fn what_the_command_line_cannot_mean_is_refused() {
        for line in [
            "--size infx600",
            "--size 800x1e999",
            "--size 800",
            "--size 0x600",
            "--device",
            "--frob",
            "a.bt b.bt",
        ] {
            assert!(parse(args(line)).is_err(), "{line}");
        }
    }

    #[test]
    fn a_file_of_no_format_the_editor_opens_is_refused() {
        let dir = std::env::temp_dir().join(format!("behavior-editor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tree = dir.join("tree.bt");
        std::fs::write(&tree, "succeed\n").unwrap();
        let notes = dir.join("notes.txt");
        std::fs::write(&notes, "").unwrap();
        let file = read(&tree).unwrap();
        assert_eq!(
            (file.name.as_str(), file.text.as_str()),
            ("tree.bt", "succeed\n")
        );
        assert!(read(&notes)
            .unwrap_err()
            .contains("no format the editor opens"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
