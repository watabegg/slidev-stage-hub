use std::io::Read;
use std::path::Path;
use std::time::Duration;

const MAX_CATALOG: u64 = 4 * 1024 * 1024;

fn read_catalog(reader: impl Read) -> Result<String, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_CATALOG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read catalog")?;
    if bytes.len() as u64 > MAX_CATALOG {
        return Err("catalog exceeds 4 MiB".into());
    }
    String::from_utf8(bytes).map_err(|_| "invalid catalog encoding".into())
}

pub fn load(origin: &str, config_path: &Path, cursor: Option<&str>) -> Result<String, String> {
    if cursor.is_some_and(|value| value.len() > 4096) {
        return Err("invalid catalog cursor".into());
    }
    if origin == "deck://localhost" {
        let loaded = crate::config::load(config_path)?;
        let crate::config::Playback::Local { site_root } = loaded.playback else {
            return Err("local catalog unavailable".into());
        };
        let file = site_root
            .join("catalog.json")
            .canonicalize()
            .map_err(|_| "catalog unavailable")?;
        if !file.starts_with(&site_root) {
            return Err("catalog escaped site root".into());
        }
        return read_catalog(std::fs::File::open(file).map_err(|_| "catalog unavailable")?);
    }
    // The host chooses this origin. Authenticated connections already use its
    // origin-bound proxy, so neither credentials nor arbitrary URLs cross IPC.
    let mut url = reqwest::Url::parse(origin).map_err(|_| "invalid catalog origin")?;
    url.set_path("/catalog.json");
    url.set_query(None);
    if let Some(cursor) = cursor {
        url.query_pairs_mut().append_pair("cursor", cursor);
    }
    let client = reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "catalog client unavailable")?;
    let response = client.get(url).send().map_err(|_| "catalog unavailable")?;
    if !response.status().is_success() {
        return Err("catalog request rejected".into());
    }
    read_catalog(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_catalog_reads() {
        assert_eq!(read_catalog("{}".as_bytes()).unwrap(), "{}");
        assert!(read_catalog(vec![b'a'; MAX_CATALOG as usize + 1].as_slice()).is_err());
        assert!(read_catalog([255].as_slice()).is_err());
    }
    #[test]
    fn only_fetches_catalog_with_encoded_cursor() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0; 4096];
            let size = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..size]);
            assert!(request.starts_with("GET /catalog.json?cursor=a%26b HTTP/1.1"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .unwrap();
        });
        assert_eq!(
            load(&origin, Path::new("unused"), Some("a&b")).unwrap(),
            "{}"
        );
        server.join().unwrap();
    }
}
