use serde::Serialize;
use slidev_native_core::{Controller, Deck, Input, NotesDocument, Session, SidecarNotes};
use slidev_native_poc::config::ConfigWriteLock;
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, WebviewWindow};

pub(crate) struct Runtime {
    controller: Mutex<Controller>,
    viewer_origin: String,
    pub(crate) config_path: PathBuf,
    notes: Mutex<HashMap<String, NotesDocument>>,
    pub(crate) remote_origin: Option<String>,
    remote_notes: Mutex<Option<RemoteNotes>>,
    notes_evidence_recorded: std::sync::atomic::AtomicBool,
}
struct RemoteNotes {
    store: SidecarNotes,
    directory: PathBuf,
}

impl Runtime {
    pub(crate) fn new(
        controller: Controller,
        viewer_origin: String,
        config_path: PathBuf,
        notes: HashMap<String, NotesDocument>,
        remote_origin: Option<String>,
    ) -> Self {
        Self {
            controller: Mutex::new(controller),
            viewer_origin,
            config_path,
            notes: Mutex::new(notes),
            remote_origin,
            remote_notes: Mutex::new(None),
            notes_evidence_recorded: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub(crate) fn configure_remote_notes(&self, directory: PathBuf) -> Result<(), String> {
        let store = SidecarNotes::new(directory.clone())?;
        *self
            .remote_notes
            .lock()
            .map_err(|error| error.to_string())? = Some(RemoteNotes { store, directory });
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    session: Session,
    decks: Vec<Deck>,
    viewer_origin: String,
    notes_available: bool,
    notes_mode: &'static str,
    source_origin: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteView {
    text: String,
    revision: String,
    page: usize,
    deck_id: String,
    source_changed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    index: usize,
    name: Option<String>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale: f64,
}
fn require_window(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "presenter" | "audience") {
        Ok(())
    } else {
        Err("command is restricted to native viewer windows".into())
    }
}
fn require_presenter(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "presenter" {
        Ok(())
    } else {
        Err("presenter command".into())
    }
}
#[tauri::command]
pub(crate) fn snapshot(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<Snapshot, String> {
    require_window(&window)?;
    let c = state.controller.lock().map_err(|e| e.to_string())?;
    let notes_available = !state.notes.lock().map_err(|e| e.to_string())?.is_empty()
        || state
            .remote_notes
            .lock()
            .map_err(|e| e.to_string())?
            .is_some();
    Ok(Snapshot {
        session: c.session.clone(),
        decks: c.decks.clone(),
        viewer_origin: state.viewer_origin.clone(),
        notes_available,
        notes_mode: if state.remote_origin.is_some() {
            "sidecar"
        } else {
            "markdown"
        },
        source_origin: state.remote_origin.clone(),
    })
}
fn remote_note_identity(
    state: &Runtime,
    deck_id: &str,
    page: usize,
) -> Result<(String, String), String> {
    let origin = state.remote_origin.as_ref().ok_or("not a remote session")?;
    let controller = state.controller.lock().map_err(|e| e.to_string())?;
    let deck = controller
        .decks
        .iter()
        .find(|deck| deck.id == deck_id)
        .ok_or("unknown deck")?;
    if page == 0 || page > deck.click_totals.len() {
        return Err("page outside deck".into());
    }
    Ok((format!("{origin}/{deck_id}/{page}"), deck.revision.clone()))
}
#[tauri::command]
pub(crate) fn transition(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Runtime>,
    mut input: Input,
) -> Result<Session, String> {
    require_window(&window)?;
    input.source = window.label().to_string(); // The client cannot impersonate another window.
    let mut c = state.controller.lock().map_err(|e| e.to_string())?;
    let changed = c.apply(input)?;
    if changed {
        app.emit("session", &c.session).map_err(|e| e.to_string())?;
        println!("SESSION {}", serde_json::to_string(&c.session).unwrap());
    }
    Ok(c.session.clone())
}
#[tauri::command]
pub(crate) fn read_notes(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    deck_id: String,
    page: usize,
) -> Result<NoteView, String> {
    require_presenter(&window)?;
    if state.remote_origin.is_some() {
        let (url, source_revision) = remote_note_identity(&state, &deck_id, page)?;
        let store = state.remote_notes.lock().map_err(|e| e.to_string())?;
        let note = store
            .as_ref()
            .ok_or("local note store unavailable")?
            .store
            .read(&url, &source_revision)?;
        return Ok(NoteView {
            text: note.text,
            revision: note.revision,
            page,
            deck_id,
            source_changed: note.source_changed,
        });
    }
    let notes = state.notes.lock().map_err(|e| e.to_string())?;
    let d = notes
        .get(&deck_id)
        .ok_or("deck has no local source mapping")?;
    Ok(NoteView {
        text: d.read(page)?,
        revision: d.revision().to_owned(),
        page,
        deck_id,
        source_changed: false,
    })
}
#[tauri::command]
pub(crate) fn save_notes(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    deck_id: String,
    page: usize,
    expected_revision: String,
    text: String,
) -> Result<String, String> {
    require_presenter(&window)?;
    if state.remote_origin.is_some() {
        let (url, source_revision) = remote_note_identity(&state, &deck_id, page)?;
        let store = state.remote_notes.lock().map_err(|e| e.to_string())?;
        let note = store
            .as_ref()
            .ok_or("local note store unavailable")?
            .store
            .save(&url, &source_revision, &expected_revision, &text)?;
        return Ok(note.revision);
    }
    let _config_lock = ConfigWriteLock::acquire(&state.config_path)?;
    let mut notes = state.notes.lock().map_err(|e| e.to_string())?;
    let document = notes
        .get_mut(&deck_id)
        .ok_or("deck has no local source mapping")?;
    let record = std::env::var_os("NATIVE_POC_QA").is_some()
        && !state
            .notes_evidence_recorded
            .swap(true, std::sync::atomic::Ordering::SeqCst);
    let evidence = state
        .config_path
        .parent()
        .ok_or("config path has no parent directory")?;
    if record {
        fs::write(evidence.join("notes-before.md"), document.source_bytes())
            .map_err(|e| e.to_string())?;
    }
    let mut config = slidev_native_poc::config::load(&state.config_path)?.config;
    if config
        .notes
        .get(&deck_id)
        .is_none_or(|map| map.revision != document.revision())
    {
        return Err("private mapping changed outside the session; reload".into());
    }
    let revision = document.save(page, &expected_revision, &text)?;
    config.notes.insert(deck_id, document.mapping());
    use std::io::Write;
    let mut staged = tempfile::NamedTempFile::new_in(state.config_path.parent().unwrap())
        .map_err(|e| format!("notes saved but metadata staging failed: {e}"))?;
    staged
        .write_all(&serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist(&state.config_path)
        .map_err(|e| format!("notes saved but metadata replace failed: {e}"))?;
    if record {
        fs::write(evidence.join("notes-after.md"), document.source_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(revision)
}
#[tauri::command]
pub(crate) fn qa_reopen_notes(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    deck_id: String,
    page: usize,
) -> Result<NoteView, String> {
    require_presenter(&window)?;
    if std::env::var_os("NATIVE_POC_QA").is_none() {
        return Err("QA is not enabled".into());
    }
    if state.remote_origin.is_some() {
        let (url, source_revision) = remote_note_identity(&state, &deck_id, page)?;
        let directory = state
            .remote_notes
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .ok_or("local note store unavailable")?
            .directory
            .clone();
        let note = SidecarNotes::new(directory)?.read(&url, &source_revision)?;
        return Ok(NoteView {
            text: note.text,
            revision: note.revision,
            page,
            deck_id,
            source_changed: note.source_changed,
        });
    }
    let config = slidev_native_poc::config::load(&state.config_path)?.config;
    let document = NotesDocument::open(
        config.notes.get(&deck_id).ok_or("mapping missing")?.clone(),
        &config.approved_source_root,
    )?;
    Ok(NoteView {
        text: document.read(page)?,
        revision: document.revision().to_string(),
        deck_id,
        page,
        source_changed: false,
    })
}
#[cfg(target_os = "linux")]
#[tauri::command]
pub(crate) async fn capture(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, Runtime>,
    label: String,
    name: String,
) -> Result<String, String> {
    require_presenter(&window)?;
    if !matches!(label.as_str(), "audience" | "presenter")
        || name.is_empty()
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("invalid fixed capture target".into());
    }
    let target = app.get_webview_window(&label).ok_or("viewer missing")?;
    let output = state
        .config_path
        .parent()
        .ok_or("config path has no parent directory")?
        .join(format!("{name}-{label}.png"));
    target.show().map_err(|e| e.to_string())?;
    target.set_focus().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(500))
    })
    .await
    .map_err(|e| e.to_string())?;
    let (send, mut receive) = tauri::async_runtime::channel(1);
    target
        .with_webview(move |webview| {
            use webkit2gtk::WebViewExt;
            webview.inner().snapshot(
                webkit2gtk::SnapshotRegion::Visible,
                webkit2gtk::SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let saved = result.map_err(|e| e.to_string()).and_then(|surface| {
                        fs::File::create(&output)
                            .map_err(|e| e.to_string())
                            .and_then(|mut file| {
                                surface.write_to_png(&mut file).map_err(|e| e.to_string())
                            })
                    });
                    println!("CAPTURE {} {:?}", output.display(), saved);
                    let _ = send.try_send(saved.map(|_| output.display().to_string()));
                },
            );
        })
        .map_err(|e| e.to_string())?;
    receive.recv().await.ok_or("capture callback disappeared")?
}
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub(crate) fn capture(_window: WebviewWindow, _label: String, _name: String) -> Result<(), String> {
    Err("capture is Linux PoC only".into())
}
#[tauri::command]
pub(crate) fn qa_audience_next(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    require_presenter(&window)?;
    if std::env::var_os("NATIVE_POC_QA").is_none() {
        return Err("QA is not enabled".into());
    }
    app.get_webview_window("audience")
        .ok_or("audience missing")?
        .eval("window.__nativePoc.action('next')")
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn qa_control_url(window: WebviewWindow) -> Result<String, String> {
    require_presenter(&window)?;
    if std::env::var_os("NATIVE_POC_QA").is_none() {
        return Err("QA is not enabled".into());
    }
    let value = std::env::var("NATIVE_POC_QA_CONTROL_URL")
        .map_err(|_| "QA control server is unavailable".to_owned())?;
    let url = reqwest::Url::parse(&value).map_err(|_| "QA control URL is invalid".to_owned())?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("QA control URL must be an HTTP loopback origin".into());
    }
    Ok(url.origin().ascii_serialization())
}
#[tauri::command]
pub(crate) fn swap_windows(window: WebviewWindow, app: tauri::AppHandle) -> Result<String, String> {
    require_presenter(&window)?;
    let audience = app
        .get_webview_window("audience")
        .ok_or("audience missing")?;
    let p = window.outer_position().map_err(|e| e.to_string())?;
    let a = audience.outer_position().map_err(|e| e.to_string())?;
    window.set_position(a).map_err(|e| e.to_string())?;
    audience.set_position(p).map_err(|e| e.to_string())?;
    Ok(format!(
        "swap placement requested; presenter={:?}; audience={:?}",
        window.outer_position(),
        audience.outer_position()
    ))
}
#[tauri::command]
pub(crate) fn viewer_ready(window: WebviewWindow, report: serde_json::Value) -> Result<(), String> {
    require_window(&window)?;
    println!("VIEWER_READY {} {}", window.label(), report);
    Ok(())
}
#[tauri::command]
pub(crate) fn displays(window: WebviewWindow) -> Result<Vec<Display>, String> {
    require_presenter(&window)?;
    Ok(window
        .available_monitors()
        .map_err(|e| e.to_string())?
        .iter()
        .enumerate()
        .map(|(index, m)| Display {
            index,
            name: m.name().cloned(),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale: m.scale_factor(),
        })
        .collect())
}
#[tauri::command]
pub(crate) fn audience_display(
    window: WebviewWindow,
    app: tauri::AppHandle,
    index: Option<usize>,
    fullscreen: bool,
) -> Result<String, String> {
    require_presenter(&window)?;
    let audience = app
        .get_webview_window("audience")
        .ok_or("audience window missing")?;
    audience.set_fullscreen(false).map_err(|e| e.to_string())?;
    let move_result = if let Some(index) = index {
        let monitors = window.available_monitors().map_err(|e| e.to_string())?;
        let monitor = monitors
            .get(index)
            .ok_or("display disappeared or index is invalid")?;
        audience
            .set_position(*monitor.position())
            .map(|_| "position request accepted".to_string())
            .map_err(|e| e.to_string())
    } else {
        Ok("no position request".to_string())
    };
    // Wayland can reject placement. Fullscreen is still a useful independent request.
    audience
        .set_fullscreen(fullscreen)
        .map_err(|e| e.to_string())?;
    audience.show().map_err(|e| e.to_string())?;
    let observed = audience
        .outer_position()
        .map(|p| format!("{},{}", p.x, p.y))
        .unwrap_or_else(|e| format!("unavailable: {e}"));
    Ok(format!(
        "{}; fullscreen requested={fullscreen}; observed position={observed}",
        move_result.unwrap_or_else(|e| format!("position rejected: {e}"))
    ))
}
