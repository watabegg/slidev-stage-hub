use slive_core::Deck;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn mime(path: &Path) -> &'static str {
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
pub fn serve(
    root: &Path,
    path: &str,
    decks: &[Deck],
    bridge: &str,
) -> Result<(Vec<u8>, &'static str), String> {
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
        // This script runs before Slidev's module scripts. The isolation applies only
        // to these controlled local frames, and never alters browser-wide settings.
        bytes=original.replacen("<head>",&format!(r#"<head><meta http-equiv="Content-Security-Policy" content="default-src 'self' deck: data: blob:; script-src 'self' deck: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' deck: 'unsafe-inline'; img-src 'self' deck: data: blob:; font-src 'self' deck: data:; connect-src 'self' deck:;"><script>{bridge}</script>"#),1).into_bytes();
    }
    Ok((bytes, content_type))
}
pub fn start_loopback(
    site: PathBuf,
    decks: Vec<Deck>,
    bridge: &'static str,
) -> std::io::Result<String> {
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
                    serve(&site, path, &decks, bridge)
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

#[cfg(test)]
mod tests {
    use super::serve;
    use slive_core::Deck;
    use std::fs;
    use tempfile::tempdir;

    fn deck() -> Deck {
        Deck {
            id: "deck-one".into(),
            revision: "r1".into(),
            entry: "/deck-one/index.html".into(),
            click_totals: vec![0, 1],
            playback: None,
        }
    }

    #[test]
    fn serves_registered_page_routes_and_injects_the_bridge() {
        let temp = tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("deck-one")).unwrap();
        fs::write(
            root.join("deck-one/index.html"),
            "<html><head></head><body>deck</body></html>",
        )
        .unwrap();
        fs::write(root.join("deck-one/app.js"), "window.ready = true").unwrap();

        let (body, mime) = serve(
            &root,
            "/deck-one/2",
            &[deck()],
            "window.__nativeSlidevBridge = true;",
        )
        .unwrap();
        let html = String::from_utf8(body).unwrap();
        assert_eq!(mime, "text/html; charset=utf-8");
        assert!(html.contains("Content-Security-Policy"));
        assert!(html.contains("window.__nativeSlidevBridge"));
        assert!(
            String::from_utf8(
                serve(&root, "/deck-one/app.js", &[deck()], "bridge")
                    .unwrap()
                    .0,
            )
            .unwrap()
            .contains("window.ready")
        );
        assert!(serve(&root, "/deck-one/3", &[deck()], "bridge").is_err());
    }

    #[test]
    fn rejects_asset_path_traversal() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("site");
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();

        for path in [
            "/../outside.html",
            "/%2e%2e/outside.html",
            "/folder\\escape",
        ] {
            assert!(serve(&root, path, &[deck()], "bridge").is_err(), "{path}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_site_root() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let root = temp.path().join("site");
        let outside = temp.path().join("outside.html");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, root.join("escape.html")).unwrap();
        let root = root.canonicalize().unwrap();
        assert!(serve(&root, "/escape.html", &[deck()], "bridge").is_err());
    }
}
