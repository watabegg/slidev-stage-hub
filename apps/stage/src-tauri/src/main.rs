use serde::{Deserialize, Serialize};
use slidev_native_core::{Controller, Deck, Input, NoteMap, NotesDocument, Session, SidecarNotes};
use slidev_native_poc::auth_transport;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

struct Runtime {
    controller: Mutex<Controller>,
    viewer_origin: String,
    config_path: PathBuf,
    notes: Mutex<HashMap<String, NotesDocument>>,
    remote_origin: Option<String>,
    remote_notes: Mutex<Option<RemoteNotes>>,
    notes_evidence_recorded: std::sync::atomic::AtomicBool,
}
struct RemoteNotes {
    store: SidecarNotes,
    directory: PathBuf,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalConfig {
    decks: Vec<Deck>,
    notes: HashMap<String, NoteMap>,
    approved_source_root: PathBuf,
    #[serde(default)]
    viewer_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_headers_file: Option<PathBuf>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    session: Session,
    decks: Vec<Deck>,
    viewer_origin: String,
    notes_available: bool,
    notes_mode: &'static str,
    source_origin: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteView {
    text: String,
    revision: String,
    page: usize,
    deck_id: String,
    source_changed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Display {
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
fn snapshot(window: WebviewWindow, state: tauri::State<Runtime>) -> Result<Snapshot, String> {
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
fn transition(
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
fn read_notes(
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
fn save_notes(
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
    let mut notes = state.notes.lock().map_err(|e| e.to_string())?;
    let document = notes
        .get_mut(&deck_id)
        .ok_or("deck has no local source mapping")?;
    let record = std::env::var_os("NATIVE_POC_QA").is_some()
        && !state
            .notes_evidence_recorded
            .swap(true, std::sync::atomic::Ordering::SeqCst);
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts");
    if record {
        fs::write(evidence.join("notes-before.md"), document.source_bytes())
            .map_err(|e| e.to_string())?;
    }
    let mut config: LocalConfig =
        serde_json::from_slice(&fs::read(&state.config_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
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
fn qa_reopen_notes(
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
    let config: LocalConfig =
        serde_json::from_slice(&fs::read(&state.config_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
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
async fn capture(
    window: WebviewWindow,
    app: tauri::AppHandle,
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
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts")
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
fn capture(_window: WebviewWindow, _label: String, _name: String) -> Result<(), String> {
    Err("capture is Linux PoC only".into())
}
#[tauri::command]
fn qa_audience_next(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
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
fn swap_windows(window: WebviewWindow, app: tauri::AppHandle) -> Result<String, String> {
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
fn viewer_ready(window: WebviewWindow, report: serde_json::Value) -> Result<(), String> {
    require_window(&window)?;
    println!("VIEWER_READY {} {}", window.label(), report);
    Ok(())
}
#[tauri::command]
fn displays(window: WebviewWindow) -> Result<Vec<Display>, String> {
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
fn audience_display(
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
fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|v| v.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}
fn validate_remote_origin(origin: &str) -> Result<String, String> {
    let url =
        tauri::Url::parse(origin).map_err(|e| format!("invalid remote viewer origin: {e}"))?;
    if origin.contains('@') || !url.username().is_empty() || url.password().is_some() {
        return Err("remote viewer origin must not contain credentials".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(
            "remote viewer URL must be a root origin without a path, query, or fragment".into(),
        );
    }
    match url.scheme() {
        "https" => {}
        "http" if matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => {}
        "http" => {
            return Err(
                "HTTP viewer origins are allowed only for localhost, 127.0.0.1, or [::1]".into(),
            );
        }
        _ => return Err("remote viewer origin must use HTTPS or HTTP loopback".into()),
    }
    Ok(url.origin().ascii_serialization())
}
fn serve(root: &Path, path: &str, decks: &[Deck]) -> Result<(Vec<u8>, &'static str), String> {
    if path.contains('%') || path.contains('\\') || path.split('/').any(|s| s == "..") {
        return Err("unsupported asset path".into());
    }
    let relative = path.trim_start_matches('/');
    let mut file = root.join(relative);
    if !file.is_file() {
        let route = decks
            .iter()
            .find(|d| {
                let base = d.entry.rsplit_once('/').unwrap().0;
                path.strip_prefix(&format!("{base}/")).is_some_and(|tail| {
                    tail.parse::<usize>()
                        .is_ok_and(|n| n > 0 && n <= d.click_totals.len())
                })
            })
            .ok_or("route is not in the fixed registry")?;
        file = root
            .join(
                route
                    .entry
                    .trim_start_matches('/')
                    .rsplit_once('/')
                    .unwrap()
                    .0,
            )
            .join("index.html");
        if !file.is_file() {
            file = root.join("index.html");
        }
    }
    let file = file.canonicalize().map_err(|e| e.to_string())?;
    if !file.starts_with(root) {
        return Err("asset escaped site root".into());
    }
    let content_type = mime(&file);
    let mut bytes = fs::read(&file).map_err(|e| e.to_string())?;
    if content_type.starts_with("text/html") {
        let original = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        let bridge = include_str!("../../dist/deck-bridge.js");
        // This script runs before Slidev's module scripts. The isolation applies only
        // to these controlled local frames, and never alters browser-wide settings.
        bytes=original.replacen("<head>",&format!(r#"<head><meta http-equiv="Content-Security-Policy" content="default-src 'self' deck: data: blob:; script-src 'self' deck: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' deck: 'unsafe-inline'; img-src 'self' deck: data: blob:; font-src 'self' deck: data:; connect-src 'self' deck:;"><script>{bridge}</script>"#),1).into_bytes();
    }
    Ok((bytes, content_type))
}
fn start_loopback(site: PathBuf, decks: Vec<Deck>) -> std::io::Result<String> {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let origin = format!("http://{}", listener.local_addr()?);
    // Fixed read-only site, bound only to loopback. No commands, notes or paths
    // outside the prepared site are reachable over HTTP.
    for _ in 0..4 {
        let listener = listener.try_clone()?;
        let site = site.clone();
        let decks = decks.clone();
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(mut stream) = connection else { continue };
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(5)));
                let mut request = Vec::new();
                let mut chunk = [0u8; 2048];
                while request.len() < 16384 && !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let mut parts = text.lines().next().unwrap_or("").split_whitespace();
                let method = parts.next().unwrap_or("");
                let path = parts.next().unwrap_or("").split('?').next().unwrap_or("");
                let result = if matches!(method, "GET" | "HEAD") {
                    serve(&site, path, &decks)
                } else {
                    Err("read-only assets".into())
                };
                let (status, body, mime) = match result {
                    Ok((body, mime)) => ("200 OK", body, mime),
                    Err(e) => {
                        println!("ASSET_ERROR {path} {e}");
                        ("404 Not Found", e.into_bytes(), "text/plain")
                    }
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                if stream.write_all(header.as_bytes()).is_ok() && method != "HEAD" {
                    let _ = stream.write_all(&body);
                }
            }
        });
    }
    Ok(origin)
}

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let config: LocalConfig = serde_json::from_slice(
        &fs::read(root.join("artifacts/local-config.json")).expect("local-config.json missing"),
    )
    .expect("invalid local config");
    let LocalConfig {
        decks,
        notes: note_maps,
        approved_source_root,
        viewer_origin: configured_origin,
        auth_headers_file,
    } = config;
    let remote_origin = configured_origin
        .as_deref()
        .map(validate_remote_origin)
        .transpose()
        .expect("invalid remote viewer origin");
    if auth_headers_file.is_some() && remote_origin.is_none() {
        panic!("auth headers require a remote origin");
    }
    let controller = Controller::new(decks.clone()).expect("invalid deck bounds");
    let mut notes = HashMap::new();
    if configured_origin.is_none() {
        for (id, map) in note_maps {
            match NotesDocument::open(map, &approved_source_root) {
                Ok(d) => {
                    notes.insert(id, d);
                }
                Err(e) => eprintln!("NOTES unavailable {id}: {e}"),
            }
        }
    }
    let site = if configured_origin.is_some() {
        None
    } else {
        Some(
            root.join("artifacts/site")
                .canonicalize()
                .expect("run scripts/prepare.mjs before launch: local site is missing"),
        )
    };
    let viewer_origin = if let Some(origin) = remote_origin.as_deref() {
        match auth_headers_file.as_deref() {
            Some(file) => {
                auth_transport::start(origin, file).expect("authenticated transport failed")
            }
            None => origin.to_string(),
        }
    } else if std::env::var("NATIVE_POC_TRANSPORT").as_deref() == Ok("protocol") {
        "deck://localhost".to_string()
    } else {
        start_loopback(site.clone().unwrap(), decks.clone())
            .expect("loopback asset listener failed")
    };
    println!("TRANSPORT {viewer_origin}");
    let protocol_site = site.clone();
    tauri::Builder::default()
        .manage(Runtime {
            controller: Mutex::new(controller),
            viewer_origin,
            config_path: root.join("artifacts/local-config.json"),
            notes: Mutex::new(notes),
            remote_origin,
            remote_notes: Mutex::new(None),
            notes_evidence_recorded: std::sync::atomic::AtomicBool::new(false),
        })
        .register_uri_scheme_protocol("deck", move |_context, request| {
            let result = match protocol_site.as_deref() {
                Some(site) => serve(site, request.uri().path(), &decks),
                None => Err("deck:// asset serving is disabled for a remote viewer origin".into()),
            };
            match result {
                Ok((body, content_type)) => tauri::http::Response::builder()
                    .header("Content-Type", content_type)
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(body)
                    .unwrap(),
                Err(e) => {
                    println!("ASSET_ERROR {} {e}", request.uri());
                    tauri::http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(e.into_bytes())
                        .unwrap()
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            transition,
            read_notes,
            save_notes,
            viewer_ready,
            capture,
            swap_windows,
            qa_audience_next,
            qa_reopen_notes,
            displays,
            audience_display
        ])
        .setup(|app| {
            let runtime = app.state::<Runtime>();
            if runtime.remote_origin.is_some() {
                let directory = if std::env::var_os("NATIVE_POC_QA").is_some() {
                    std::env::var_os("NATIVE_POC_NOTES_DIR").map(PathBuf::from)
                } else {
                    None
                }
                .unwrap_or(app.path().app_data_dir()?.join("remote-notes"));
                let store = SidecarNotes::new(directory.clone()).map_err(std::io::Error::other)?;
                *runtime
                    .remote_notes
                    .lock()
                    .map_err(|e| std::io::Error::other(e.to_string()))? =
                    Some(RemoteNotes { store, directory });
            }
            let presenter = WebviewWindowBuilder::new(
                app,
                "presenter",
                WebviewUrl::App("index.html?role=presenter".into()),
            )
            .title("Slidev Lab · Presenter")
            .inner_size(1180., 820.)
            .build()?;
            WebviewWindowBuilder::new(
                app,
                "audience",
                WebviewUrl::App("index.html?role=audience".into()),
            )
            .title("Slidev Lab · Audience")
            .inner_size(960., 600.)
            .build()?;
            // Local HTTPS test fixture only: pin one supplied certificate to
            // localhost, without changing OS trust or normal launch TLS policy.
            #[cfg(target_os = "linux")]
            if std::env::var_os("NATIVE_POC_QA").is_some() {
                if let Some(cert) = std::env::var_os("NATIVE_POC_QA_LOCALHOST_CERT") {
                    for window in app.webview_windows().values() {
                        let cert = cert.clone();
                        window.with_webview(move |webview| {
                            use webkit2gtk::{WebContextExt, WebViewExt};
                            let certificate = webkit2gtk::gio::TlsCertificate::from_file(cert)
                                .expect("invalid QA localhost certificate");
                            webview
                                .inner()
                                .context()
                                .expect("WebKit context")
                                .allow_tls_certificate_for_host(&certificate, "localhost");
                        })?;
                    }
                }
            }
            println!(
                "DISPLAYS {}",
                serde_json::to_string(&displays(presenter).unwrap_or_default()).unwrap()
            );
            if std::env::var_os("NATIVE_POC_QA").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if let Some(p) = handle.get_webview_window("presenter") {
                        let _ = p.eval(include_str!("../../dist/qa.js"));
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}
