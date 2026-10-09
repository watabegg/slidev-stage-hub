//! Read-only, origin-bound authentication transport. Secrets stay in this process.

use reqwest::{
    Method, Url,
    blocking::Client,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use serde::{Deserialize, de};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    sync::Arc,
    time::Duration,
};

const MAX_FILE: u64 = 64 * 1024;
const MAX_REQUEST: usize = 16 * 1024;
const MAX_ASSET: u64 = 64 * 1024 * 1024;

// Deliberately no Debug implementation: HeaderMap's debug output is not a secret API.
pub struct AuthHeaders {
    origin: Url,
    headers: HeaderMap,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthFile {
    origin: String,
    headers: HeaderEntries,
}

struct HeaderEntries(Vec<(String, String)>);

impl<'de> Deserialize<'de> for HeaderEntries {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor;
        impl<'de> de::Visitor<'de> for EntriesVisitor {
            type Value = HeaderEntries;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an object of header names and string values")
            }
            fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, String>()? {
                    if entries.len() >= 64 {
                        return Err(de::Error::custom("too many headers"));
                    }
                    entries.push(entry);
                }
                Ok(HeaderEntries(entries))
            }
        }
        deserializer.deserialize_map(EntriesVisitor)
    }
}

fn canonical_origin(origin: &str) -> Result<Url, String> {
    let invalid =
        || "authentication origin must be an HTTPS root or exact HTTP loopback root".to_owned();
    if origin.bytes().any(|b| b <= 0x20 || b >= 0x7f || b == b'\\') || origin.contains('@') {
        return Err(invalid());
    }
    let (_, authority_and_path) = origin.split_once("://").ok_or_else(invalid)?;
    if authority_and_path
        .find('/')
        .is_some_and(|index| &authority_and_path[index..] != "/")
    {
        return Err(invalid());
    }
    let url = Url::parse(origin).map_err(|_| invalid())?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    match url.scheme() {
        "https" => {}
        "http" => {
            // WHATWG URL parsing normalizes forms such as 127.1 into 127.0.0.1.
            // Only the explicitly allowed spelling is eligible for plain HTTP.
            let authority = authority_and_path.split('/').next().ok_or_else(invalid)?;
            let host = if authority.starts_with('[') {
                let end = authority.find(']').ok_or_else(invalid)?;
                &authority[..=end]
            } else {
                authority.split(':').next().ok_or_else(invalid)?
            };
            if !matches!(
                host.to_ascii_lowercase().as_str(),
                "localhost" | "127.0.0.1" | "[::1]"
            ) {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| invalid())
}

fn open_private_file(path: &Path) -> Result<File, String> {
    // Reject non-regular files before opening (e.g. FIFOs), then check the actual
    // descriptor again so the permissions checked belong to the bytes read.
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| "cannot read authentication headers file".to_owned())?;
    if !metadata.is_file() {
        return Err("authentication headers file must be a regular file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "cannot read authentication headers file".to_owned())?;
    let metadata = file
        .metadata()
        .map_err(|_| "cannot inspect authentication headers file".to_owned())?;
    if !metadata.is_file() {
        return Err("authentication headers file must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("authentication headers file must have no group or world permissions (use chmod 600)".into());
        }
    }
    if metadata.len() > MAX_FILE {
        return Err("authentication headers file exceeds 64 KiB".into());
    }
    Ok(file)
}

impl AuthHeaders {
    pub fn load(origin: &str, path: &Path) -> Result<Self, String> {
        let origin = canonical_origin(origin)?;
        let mut bytes = Vec::new();
        open_private_file(path)?
            .take(MAX_FILE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "cannot read authentication headers file".to_owned())?;
        if bytes.len() as u64 > MAX_FILE {
            return Err("authentication headers file exceeds 64 KiB".into());
        }
        // Never expose serde's error: malformed input can contain secret values.
        let config: AuthFile = serde_json::from_slice(&bytes).map_err(|_| {
            "invalid authentication headers JSON (expected origin and headers)".to_owned()
        })?;
        if canonical_origin(&config.origin)?.origin() != origin.origin() {
            return Err("authentication headers file origin does not match viewer origin".into());
        }
        if config.headers.0.is_empty() {
            return Err("authentication headers must contain at least one header".into());
        }
        let mut headers = HeaderMap::new();
        let mut seen = HashSet::new();
        for (name, value) in config.headers.0 {
            let lower = name.to_ascii_lowercase();
            let token = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b);
            if name.is_empty() || !name.bytes().all(token) {
                return Err("authentication header name must be an HTTP token".into());
            }
            if !seen.insert(lower.clone()) {
                return Err("authentication headers contain a case-insensitive duplicate".into());
            }
            if matches!(
                lower.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "accept-encoding"
                    | "origin"
                    | "referer"
                    | "trailer"
                    | "te"
            ) || lower.starts_with("proxy-")
                || lower.starts_with("sec-")
            {
                return Err(
                    "authentication headers contain a forbidden transport or browser header".into(),
                );
            }
            if value.is_empty() || !value.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
                return Err("authentication header values must be nonempty printable ASCII".into());
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "invalid authentication header name".to_owned())?;
            let mut value = HeaderValue::from_bytes(value.as_bytes())
                .map_err(|_| "invalid authentication header value".to_owned())?;
            value.set_sensitive(true);
            headers.insert(name, value);
        }
        Ok(Self { origin, headers })
    }

    fn upstream_url(&self, target: &str) -> Result<Url, ()> {
        if !target.starts_with('/')
            || target.starts_with("//")
            || target
                .bytes()
                .any(|b| b <= 0x20 || b >= 0x7f || b == b'\\' || b == b'#')
        {
            return Err(());
        }
        let path = target.split('?').next().ok_or(())?;
        // Reject dangerous encoded path separators, controls, '%' (nested escapes),
        // and dot segments before URL normalization can hide traversal attempts.
        let mut decoded = Vec::new();
        let raw = path.as_bytes();
        let mut i = 0;
        while i < raw.len() {
            if raw[i] == b'%' {
                if i + 2 >= raw.len() {
                    return Err(());
                }
                let digit = |b: u8| (b as char).to_digit(16).ok_or(()).map(|n| n as u8);
                let b = digit(raw[i + 1])? * 16 + digit(raw[i + 2])?;
                if b <= 0x20 || b == 0x7f || matches!(b, b'/' | b'\\' | b'%') {
                    return Err(());
                }
                decoded.push(b);
                i += 3;
            } else {
                decoded.push(raw[i]);
                i += 1;
            }
        }
        if decoded
            .split(|b| *b == b'/')
            .any(|segment| segment == b"." || segment == b"..")
        {
            return Err(());
        }
        let mut url = self.origin.join(target).map_err(|_| ())?;
        if url.origin() != self.origin.origin() {
            return Err(());
        }
        let query: Vec<_> = url
            .query_pairs()
            .filter(|(name, _)| {
                !matches!(
                    name.as_ref(),
                    "nativeParentOrigin" | "nativeMount" | "nativeProtocol"
                )
            })
            .map(|(name, value)| (name.into_owned(), value.into_owned()))
            .collect();
        url.set_query(None);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }
}

struct LocalResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    length: u64,
}

impl LocalResponse {
    fn error(status: u16, message: &'static str) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
            body: message.as_bytes().to_vec(),
            length: message.len() as u64,
        }
    }
}

fn fetch(client: &Client, auth: &AuthHeaders, method: Method, target: &str) -> LocalResponse {
    let Ok(url) = auth.upstream_url(target) else {
        return LocalResponse::error(400, "Unsupported asset URL");
    };
    let head = method == Method::HEAD;
    let response = client
        .request(method, url)
        .headers(auth.headers.clone())
        .send();
    let Ok(response) = response else {
        return LocalResponse::error(
            502,
            "Authenticated upstream request failed; check the host and its trusted TLS certificate",
        );
    };
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403) {
        return LocalResponse::error(
            status.as_u16(),
            "Upstream denied access; verify the origin-bound authentication headers and reload the connection",
        );
    }
    if !status.is_success() {
        return LocalResponse::error(
            502,
            "Upstream did not return a successful asset; redirects and login pages are not followed",
        );
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_ASSET)
    {
        return LocalResponse::error(502, "Upstream asset exceeds 64 MiB");
    }
    let mut headers = Vec::new();
    for name in ["content-type", "content-security-policy", "x-frame-options"] {
        for value in response.headers().get_all(name) {
            if let Ok(value) = value.to_str() {
                headers.push((name.to_owned(), value.to_owned()));
            }
        }
    }
    let mut body = Vec::new();
    let length = if head {
        response.content_length().unwrap_or(0)
    } else {
        if response.take(MAX_ASSET + 1).read_to_end(&mut body).is_err() {
            return LocalResponse::error(502, "Upstream asset could not be read");
        }
        if body.len() as u64 > MAX_ASSET {
            return LocalResponse::error(502, "Upstream asset exceeds 64 MiB");
        }
        body.len() as u64
    };
    LocalResponse {
        status: status.as_u16(),
        headers,
        body,
        length,
    }
}

fn read_request(stream: &mut TcpStream, expected_host: &str) -> Result<(Method, String), u16> {
    let mut request = Vec::new();
    let mut chunk = [0; 2048];
    loop {
        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            request.truncate(end + 4);
            break;
        }
        if request.len() >= MAX_REQUEST {
            return Err(431);
        }
        let remaining = (MAX_REQUEST - request.len()).min(chunk.len());
        match stream.read(&mut chunk[..remaining]) {
            Ok(0) | Err(_) => return Err(400),
            Ok(n) => request.extend_from_slice(&chunk[..n]),
        }
    }
    let request = std::str::from_utf8(&request).map_err(|_| 400u16)?;
    let mut lines = request.split("\r\n");
    let parts: Vec<_> = lines.next().ok_or(400u16)?.split(' ').collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.1" | "HTTP/1.0") {
        return Err(400);
    }
    let method = match parts[0] {
        "GET" => Method::GET,
        "HEAD" => Method::HEAD,
        _ => return Err(405),
    };
    let mut host = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if line.bytes().any(|b| b < 0x20 && b != b'\t' || b == 0x7f) {
            return Err(400);
        }
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return Err(400);
            }
            host = Some(value.trim());
        }
    }
    if host != Some(expected_host) {
        return Err(400);
    }
    Ok((method, parts[1].to_owned()))
}

fn respond(stream: &mut TcpStream, response: LocalResponse, head: bool) {
    let reason = match response.status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Response",
    };
    let mut header = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n",
        response.status, response.length
    );
    for (name, value) in response.headers {
        header.push_str(&format!("{name}: {value}\r\n"));
    }
    header.push_str("\r\n");
    if stream.write_all(header.as_bytes()).is_ok() && !head {
        let _ = stream.write_all(&response.body);
    }
}

/// Start a process-lifetime, four-worker GET/HEAD server on an ephemeral loopback port.
/// The private binding file is read once, and only its configured headers go upstream.
pub fn start(origin: &str, headers_file: &Path) -> Result<String, String> {
    let auth = Arc::new(AuthHeaders::load(origin, headers_file)?);
    let qa_cert = std::env::var_os("NATIVE_POC_QA_LOCALHOST_CERT").map(std::path::PathBuf::from);
    let client = build_client(
        &auth.origin,
        std::env::var_os("NATIVE_POC_QA").is_some(),
        qa_cert.as_deref(),
    )?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "cannot bind authentication transport to loopback".to_owned())?;
    let host = listener
        .local_addr()
        .map_err(|_| "cannot inspect loopback transport address".to_owned())?
        .to_string();
    // Prepare all descriptors before starting any worker.
    let listeners = (0..4)
        .map(|_| listener.try_clone())
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| "cannot initialize authentication transport workers".to_owned())?;
    for listener in listeners {
        let client = client.clone();
        let auth = Arc::clone(&auth);
        let host = host.clone();
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(mut stream) = connection else {
                    continue;
                };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                let (response, head) = match read_request(&mut stream, &host) {
                    Ok((method, target)) => {
                        let head = method == Method::HEAD;
                        (fetch(&client, &auth, method, &target), head)
                    }
                    Err(status) => (
                        LocalResponse::error(status, "Invalid read-only loopback request"),
                        false,
                    ),
                };
                respond(&mut stream, response, head);
            }
        });
    }
    Ok(format!("http://{host}"))
}

fn build_client(origin: &Url, qa: bool, qa_cert: Option<&Path>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_zstd()
        .no_deflate()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15));
    // Process-local fixture trust: certificate/name validation remains enabled.
    // Production origins cannot be influenced by this localhost-only QA option.
    if qa
        && origin.scheme() == "https"
        && origin.host_str() == Some("localhost")
        && let Some(path) = qa_cert
    {
        let mut pem = Vec::new();
        File::open(path)
            .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut pem))
            .map_err(|_| "cannot read localhost QA TLS certificate".to_owned())?;
        if pem.len() > 1024 * 1024 {
            return Err("localhost QA TLS certificate exceeds 1 MiB".into());
        }
        let certs = reqwest::Certificate::from_pem_bundle(&pem)
            .map_err(|_| "invalid localhost QA TLS certificate".to_owned())?;
        if certs.is_empty() {
            return Err("localhost QA TLS file contains no certificates".into());
        }
        builder = builder.tls_certs_merge(certs);
    }
    builder
        .build()
        .map_err(|_| "cannot initialize authenticated HTTPS transport".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Seek, sync::mpsc, thread};
    use tempfile::NamedTempFile;

    const SECRET: &str = "test-private-bearer-do-not-echo";

    fn binding_text(text: &str) -> NamedTempFile {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(text.as_bytes()).unwrap();
        file
    }

    fn binding(origin: &str) -> NamedTempFile {
        binding_text(
            &serde_json::json!({"origin":origin,"headers":{
                "Authorization":format!("Bearer {SECRET}"),
                "Cookie":"session=configured-private-cookie",
                "CF-Access-Client-Id":"test-id", "CF-Access-Client-Secret":SECRET
            }})
            .to_string(),
        )
    }

    fn load_error(text: &str) -> String {
        let file = binding_text(text);
        match AuthHeaders::load("https://example.test", file.path()) {
            Err(error) => {
                assert!(!error.contains(SECRET));
                error
            }
            Ok(_) => panic!("unsafe binding was accepted"),
        }
    }

    fn read_http(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut chunk = [0; 1024];
        while !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut chunk).unwrap();
            assert_ne!(n, 0);
            bytes.extend_from_slice(&chunk[..n]);
        }
        String::from_utf8(bytes).unwrap()
    }

    fn upstream(
        count: usize,
        response: impl Fn(&str) -> String + Send + 'static,
    ) -> (String, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            for _ in 0..count {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_http(&mut stream);
                let bytes = response(&request);
                tx.send(request).unwrap();
                stream.write_all(bytes.as_bytes()).unwrap();
            }
        });
        (origin, rx, handle)
    }

    fn request(origin: &str, method: &str, target: &str, extra: &str) -> String {
        let host = origin.strip_prefix("http://").unwrap();
        raw_request(
            origin,
            &format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n{extra}\r\n"),
        )
    }

    fn raw_request(origin: &str, request: &str) -> String {
        let mut stream = TcpStream::connect(origin.strip_prefix("http://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn validates_origin_binding_and_all_supported_auth_headers() {
        let file = binding("https://example.test/");
        let auth = AuthHeaders::load("https://example.test", file.path()).unwrap();
        assert_eq!(auth.headers.len(), 4);
        assert!(auth.headers.values().all(HeaderValue::is_sensitive));
        assert!(AuthHeaders::load("https://other.test", file.path()).is_err());
        for origin in [
            "http://example.test",
            "http://127.1",
            "http://2130706433",
            "http://127.0.0.2",
            "http://localhost.",
            "https://example.test/path/..",
            "https://example.test?secret=1",
            "https://user:password@example.test",
            "https://example.test/#fragment",
            "file:///tmp/test",
        ] {
            assert!(canonical_origin(origin).is_err(), "accepted unsafe origin");
        }
        for origin in [
            "http://localhost:4174/",
            "http://127.0.0.1:4174",
            "http://[::1]:4174",
            "https://example.test:8443",
        ] {
            assert!(canonical_origin(origin).is_ok());
        }
    }

    #[test]
    fn normalizes_origin_case_trailing_slash_and_default_port() {
        for (input, expected) in [
            ("HTTP://LOCALHOST:80/", "http://localhost"),
            ("http://LocalHost/", "http://localhost"),
            ("HTTP://127.0.0.1:80/", "http://127.0.0.1"),
            ("HTTP://[::1]:80/", "http://[::1]"),
            ("HTTPS://EXAMPLE.TEST:443/", "https://example.test"),
        ] {
            assert_eq!(
                canonical_origin(input)
                    .unwrap()
                    .origin()
                    .ascii_serialization(),
                expected
            );
            let file = binding(input);
            assert!(AuthHeaders::load(expected, file.path()).is_ok());
        }
    }

    #[test]
    fn rejects_header_injection_duplicates_and_transport_headers_without_echo() {
        for name in [
            "Host",
            "Content-Length",
            "Connection",
            "Transfer-Encoding",
            "Upgrade",
            "Proxy-Authorization",
            "Accept-Encoding",
            "Origin",
            "Referer",
            "Sec-Fetch-Site",
            "TE",
            "Trailer",
            "bad name",
            "",
            "é",
        ] {
            load_error(
                &serde_json::json!({"origin":"https://example.test","headers":{name:SECRET}})
                    .to_string(),
            );
        }
        for value in [
            "",
            "a\r\nInjected: yes",
            "a\nb",
            "a\tb",
            "a\u{7f}",
            "日本語",
        ] {
            load_error(&serde_json::json!({"origin":"https://example.test","headers":{"Authorization":value}}).to_string());
        }
        for entries in [
            format!(r#""Authorization":"{SECRET}","authorization":"{SECRET}""#),
            format!(r#""Authorization":"{SECRET}","Authorization":"{SECRET}""#),
        ] {
            load_error(&format!(
                r#"{{"origin":"https://example.test","headers":{{{entries}}}}}"#
            ));
        }
        load_error(&format!(
            r#"{{"origin":"https://example.test","headers":{{"Authorization":"{SECRET}"}},"extra":"{SECRET}"}}"#
        ));
        load_error(&format!(
            r#"{{"origin":"https://example.test","headers":{{"Authorization":{SECRET}}}}}"#
        ));
        load_error(r#"{"origin":"https://example.test","headers":{}}"#);
    }

    #[test]
    fn rejects_header_count_and_file_size_limits() {
        let headers: serde_json::Map<String, serde_json::Value> = (0..65)
            .map(|n| {
                (
                    format!("X-Auth-{n}"),
                    serde_json::Value::String(SECRET.into()),
                )
            })
            .collect();
        load_error(
            &serde_json::json!({"origin":"https://example.test","headers":headers}).to_string(),
        );
        let file = binding_text(&" ".repeat(MAX_FILE as usize + 1));
        assert!(AuthHeaders::load("https://example.test", file.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn requires_private_regular_file_and_accepts_read_only_mode() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let file = binding("https://example.test");
        for mode in [0o640, 0o604, 0o644, 0o611] {
            std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(AuthHeaders::load("https://example.test", file.path()).is_err());
        }
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(AuthHeaders::load("https://example.test", file.path()).is_ok());
        let directory = tempfile::tempdir().unwrap();
        let link = directory.path().join("link.json");
        symlink(file.path(), &link).unwrap();
        assert!(AuthHeaders::load("https://example.test", &link).is_err());
        assert!(AuthHeaders::load("https://example.test", directory.path()).is_err());
    }

    #[test]
    fn enforces_same_origin_paths_and_strips_only_native_transport_query() {
        let file = binding("https://example.test");
        let auth = AuthHeaders::load("https://example.test", file.path()).unwrap();
        for target in [
            "https://other.test/a",
            "//other.test/a",
            "/\\other.test/a",
            "/a/../b",
            "/%2e%2e/b",
            "/a/%2F/b",
            "/%5cother",
            "/%252fother",
            "/%0a",
            "/%",
            "/a#fragment",
            "/a b",
        ] {
            assert!(
                auth.upstream_url(target).is_err(),
                "accepted unsafe asset URL"
            );
        }
        let url = auth.upstream_url("/deck/2?nativeMount=1&nativeProtocol=2&nativeParentOrigin=tauri%3A%2F%2Flocalhost&nativePreview=1&embedded=1&clicks=2&v=test").unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.test/deck/2?nativePreview=1&embedded=1&clicks=2&v=test"
        );
    }

    #[test]
    fn every_asset_receives_configured_headers_and_browser_headers_are_not_forwarded() {
        let (origin, seen, server) = upstream(5, |request| {
            let body = if request.starts_with("HEAD ") {
                ""
            } else {
                "asset"
            };
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 5\r\nSet-Cookie: leaked=response\r\nX-Echo-Authorization: {SECRET}\r\nContent-Security-Policy: frame-ancestors 'self'\r\nX-Frame-Options: SAMEORIGIN\r\nConnection: close\r\n\r\n{body}"
            )
        });
        let mut file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        // The file is read once per startup; later edits cannot change active secrets.
        file.as_file_mut().set_len(0).unwrap();
        file.rewind().unwrap();
        file.write_all(b"invalid later edits").unwrap();
        for (method, target) in [
            ("GET", "/deck/index.html"),
            ("GET", "/assets/runtime.js"),
            ("GET", "/assets/style.css"),
            ("GET", "/images/cover.svg"),
            ("HEAD", "/fonts/deck.woff2"),
        ] {
            let response = request(
                &proxy,
                method,
                target,
                "Authorization: browser-secret\r\nCookie: browser-cookie\r\nOrigin: https://other.test\r\nReferer: https://other.test/private\r\n",
            );
            assert!(response.starts_with("HTTP/1.1 200"));
            assert!(response.contains("Cache-Control: no-store"));
            assert!(response.contains("X-Content-Type-Options: nosniff"));
            assert!(response.contains("content-security-policy: frame-ancestors 'self'"));
            assert!(response.contains("x-frame-options: SAMEORIGIN"));
            assert!(!response.to_ascii_lowercase().contains("set-cookie"));
            assert!(!response.contains(SECRET));
            if method == "HEAD" {
                assert!(response.ends_with("\r\n\r\n"));
            }
            let received = seen
                .recv_timeout(Duration::from_secs(3))
                .unwrap()
                .to_ascii_lowercase();
            assert!(received.contains(&format!("authorization: bearer {SECRET}")));
            assert!(received.contains("cookie: session=configured-private-cookie"));
            assert!(received.contains("cf-access-client-id: test-id"));
            assert!(received.contains(&format!("cf-access-client-secret: {SECRET}")));
            for forbidden in [
                "browser-secret",
                "browser-cookie",
                "origin:",
                "referer:",
                "accept-encoding:",
            ] {
                assert!(!received.contains(forbidden));
            }
            assert!(received.contains(&format!(
                "host: {}",
                origin.strip_prefix("http://").unwrap()
            )));
        }
        server.join().unwrap();
    }

    #[test]
    fn redirect_cannot_send_credentials_to_second_origin() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/steal", target.local_addr().unwrap());
        let (origin, seen, server) = upstream(1, move |_| {
            format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
        });
        let file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        let response = request(&proxy, "GET", "/deck/index.html", "");
        assert!(response.starts_with("HTTP/1.1 502"));
        assert!(!response.to_ascii_lowercase().contains("location:"));
        assert!(!response.contains(SECRET));
        assert!(
            seen.recv_timeout(Duration::from_secs(3))
                .unwrap()
                .contains(SECRET)
        );
        server.join().unwrap();
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn auth_denial_and_other_errors_do_not_echo_body_or_reflection_headers() {
        let (origin, seen, server) = upstream(3, |request| {
            let status = if request.contains("/unauthorized ") {
                "401 Unauthorized"
            } else if request.contains("/forbidden ") {
                "403 Forbidden"
            } else {
                "500 Internal Server Error"
            };
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nX-Echo: {SECRET}\r\nSet-Cookie: {SECRET}\r\nConnection: close\r\n\r\n{SECRET}",
                SECRET.len()
            )
        });
        let file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        for (path, status) in [
            ("/unauthorized", 401),
            ("/forbidden", 403),
            ("/failure", 502),
        ] {
            let response = request(&proxy, "GET", path, "");
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")));
            assert!(!response.contains(SECRET));
            assert!(!response.to_ascii_lowercase().contains("set-cookie:"));
            seen.recv_timeout(Duration::from_secs(3)).unwrap();
        }
        server.join().unwrap();
    }

    #[test]
    fn refuses_wrong_host_absolute_urls_and_write_methods_before_upstream() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        upstream.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", upstream.local_addr().unwrap());
        let file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        let wrong = raw_request(&proxy, "GET / HTTP/1.1\r\nHost: other.test\r\n\r\n");
        assert!(wrong.starts_with("HTTP/1.1 400"));
        assert!(request(&proxy, "GET", "https://other.test/", "").starts_with("HTTP/1.1 400"));
        assert!(request(&proxy, "GET", "//other.test/", "").starts_with("HTTP/1.1 400"));
        assert!(request(&proxy, "POST", "/", "").starts_with("HTTP/1.1 405"));
        assert!(
            request(&proxy, "GET", "/", "Host: duplicate.test\r\n").starts_with("HTTP/1.1 400")
        );
        assert_eq!(
            upstream.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn upstream_query_omits_parent_origin_but_keeps_rendering_parameters() {
        let (origin, seen, server) = upstream(1, |_| {
            "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()
        });
        let file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        let response = request(
            &proxy,
            "GET",
            "/deck/3?nativeParentOrigin=tauri%3A%2F%2Flocalhost&nativeMount=1&nativeProtocol=2&nativePreview=1&embedded=1&clicks=2",
            "",
        );
        assert!(response.starts_with("HTTP/1.1 200"));
        let received = seen.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(received.starts_with("GET /deck/3?nativePreview=1&embedded=1&clicks=2 HTTP/1.1"));
        assert!(!received.contains("tauri"));
        server.join().unwrap();
    }

    #[test]
    fn qa_certificate_is_used_only_for_explicit_localhost_https_fixture() {
        let invalid_cert = binding_text(SECRET);
        for (origin, qa, path) in [
            ("https://localhost", false, Some(invalid_cert.path())),
            ("https://example.test", true, Some(invalid_cert.path())),
            ("https://127.0.0.1", true, Some(invalid_cert.path())),
            ("http://localhost", true, Some(invalid_cert.path())),
            ("https://localhost", true, None),
        ] {
            assert!(build_client(&canonical_origin(origin).unwrap(), qa, path).is_ok());
        }
        let error = match build_client(
            &canonical_origin("https://localhost").unwrap(),
            true,
            Some(invalid_cert.path()),
        ) {
            Err(error) => error,
            Ok(_) => panic!("invalid explicit fixture certificate was accepted"),
        };
        assert!(!error.contains(SECRET));
    }

    #[test]
    fn rejects_oversized_upstream_asset_before_reading_body() {
        let (origin, seen, server) = upstream(1, |_| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_ASSET + 1
            )
        });
        let file = binding(&origin);
        let proxy = start(&origin, file.path()).unwrap();
        let response = request(&proxy, "GET", "/assets/huge", "");
        assert!(response.starts_with("HTTP/1.1 502"));
        assert!(response.contains("exceeds 64 MiB"));
        assert!(!response.contains(SECRET));
        seen.recv_timeout(Duration::from_secs(3)).unwrap();
        server.join().unwrap();
    }
}
