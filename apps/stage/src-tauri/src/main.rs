mod commands;

use commands::Runtime;
use slidev_native_core::Controller;
use slidev_native_poc::{
    auth_transport,
    config::{self, Playback},
    paths, server,
};
use std::{collections::HashMap, path::PathBuf};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DECK_BRIDGE: &str = include_str!("../../dist/deck-bridge.js");

fn main() {
    let cwd = std::env::current_dir().expect("cannot read process working directory");
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    #[cfg(debug_assertions)]
    let development_config = Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("Stage manifest has no parent")
            .join("artifacts/local-config.json"),
    );
    #[cfg(not(debug_assertions))]
    let development_config: Option<PathBuf> = None;
    let config_path = paths::resolve_config_path(
        &args,
        &cwd,
        development_config.as_deref(),
        cfg!(debug_assertions),
    )
    .expect("could not resolve Stage config path");
    let loaded = config::load(&config_path).expect("invalid Stage config");
    let file_config = loaded.config;
    let controller = Controller::new(file_config.decks.clone()).expect("invalid deck bounds");
    let (site, remote_origin) = match loaded.playback {
        Playback::Local { site_root } => (Some(site_root), None),
        Playback::Remote { origin } => (None, Some(origin)),
    };

    let mut notes = HashMap::new();
    if remote_origin.is_none() {
        for (id, map) in file_config.notes {
            match slidev_native_core::NotesDocument::open(map, &file_config.approved_source_root) {
                Ok(document) => {
                    notes.insert(id, document);
                }
                Err(error) => eprintln!("NOTES unavailable {id}: {error}"),
            }
        }
    }
    let viewer_origin = if let Some(origin) = remote_origin.as_deref() {
        match file_config.auth_headers_file.as_deref() {
            Some(file) => {
                auth_transport::start(origin, file).expect("authenticated transport failed")
            }
            None => origin.to_string(),
        }
    } else if std::env::var("NATIVE_POC_TRANSPORT").as_deref() == Ok("protocol") {
        "deck://localhost".to_string()
    } else {
        server::start_loopback(
            site.clone().expect("local playback needs a site root"),
            file_config.decks.clone(),
            DECK_BRIDGE,
        )
        .expect("loopback asset listener failed")
    };
    println!("TRANSPORT {viewer_origin}");
    let protocol_site = site.clone();
    let decks = file_config.decks.clone();
    tauri::Builder::default()
        .manage(Runtime::new(
            controller,
            viewer_origin,
            config_path,
            notes,
            remote_origin,
        ))
        .register_uri_scheme_protocol("deck", move |_context, request| {
            let result = match protocol_site.as_deref() {
                Some(site) => server::serve(site, request.uri().path(), &decks, DECK_BRIDGE),
                None => Err("deck:// asset serving is disabled for a remote viewer origin".into()),
            };
            match result {
                Ok((body, content_type)) => tauri::http::Response::builder()
                    .header("Content-Type", content_type)
                    .header("Cache-Control", "no-store")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(body)
                    .unwrap(),
                Err(error) => {
                    println!("ASSET_ERROR {} {error}", request.uri());
                    tauri::http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(error.into_bytes())
                        .unwrap()
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::catalog_page,
            commands::transition,
            commands::read_notes,
            commands::save_notes,
            commands::viewer_ready,
            commands::capture,
            commands::swap_windows,
            commands::qa_audience_next,
            commands::qa_reopen_notes,
            commands::qa_control_url,
            commands::displays,
            commands::audience_display
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
                runtime
                    .configure_remote_notes(directory)
                    .map_err(std::io::Error::other)?;
            }
            let presenter = WebviewWindowBuilder::new(
                app,
                "presenter",
                WebviewUrl::App("index.html?role=presenter".into()),
            )
            .title("Stage · 発表者")
            .inner_size(1180., 820.)
            .build()?;
            WebviewWindowBuilder::new(
                app,
                "audience",
                WebviewUrl::App("index.html?role=audience".into()),
            )
            .title("Stage · 投影")
            .focused(false)
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
                serde_json::to_string(&commands::displays(presenter).unwrap_or_default()).unwrap()
            );
            if std::env::var_os("NATIVE_POC_QA").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if let Some(presenter) = handle.get_webview_window("presenter") {
                        let _ = presenter.eval(include_str!("../../dist/qa.js"));
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauri runtime failed");
}
