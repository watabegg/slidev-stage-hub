use reqwest::Url;
use serde::{Deserialize, Serialize};
use slive_core::{Controller, Deck, NoteMap};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

#[derive(Debug)]
pub struct ConfigWriteLock {
    path: PathBuf,
    file: Option<File>,
}

impl ConfigWriteLock {
    pub fn acquire(config_path: &Path) -> Result<Self, String> {
        let path = crate::paths::config_lock_path(config_path)?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "native config is already being updated; reload and retry after it finishes".into()
            } else {
                format!("could not lock native config for update: {error}")
            }
        })?;
        #[cfg(unix)]
        if let Err(error) = {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
        } {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("could not secure native config lock: {error}"));
        }
        Ok(Self {
            path,
            file: Some(file),
        })
    }
}

impl Drop for ConfigWriteLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u64>,
    pub decks: Vec<Deck>,
    pub notes: HashMap<String, NoteMap>,
    pub approved_source_root: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewer_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_headers_file: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Playback {
    Local { site_root: PathBuf },
    Remote { origin: String },
}

#[derive(Debug)]
pub struct LoadedConfig {
    pub config: LocalConfig,
    pub playback: Playback,
}

pub fn load(path: &Path) -> Result<LoadedConfig, String> {
    if !path.is_absolute() {
        return Err("config path must be absolute after argument resolution".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("cannot read config: {error}"))?;
    let document: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid local config JSON: {error}"))?;
    let schema_version = match document.get("schemaVersion") {
        None => None,
        Some(serde_json::Value::Number(number)) => Some(
            number
                .as_u64()
                .ok_or_else(|| "schemaVersion must be the integer 1 when present".to_owned())?,
        ),
        Some(_) => return Err("schemaVersion must be the integer 1 when present".into()),
    };
    if let Some(version) = schema_version {
        if version != 1 {
            return Err(format!(
                "unsupported config schemaVersion {version}; expected 1"
            ));
        }
    }

    let config: LocalConfig = serde_json::from_value(document)
        .map_err(|error| format!("invalid local config: {error}"))?;
    if config.schema_version != schema_version {
        return Err("schemaVersion must be the integer 1 when present".into());
    }
    Controller::new(config.decks.clone())
        .map_err(|error| format!("invalid deck registry: {error}"))?;

    let playback = match (&config.site_root, &config.viewer_origin) {
        (Some(_), Some(_)) => {
            return Err("local siteRoot and remote viewerOrigin cannot both be configured".into());
        }
        (Some(site_root), None) => Playback::Local {
            site_root: require_directory(site_root, "siteRoot")?,
        },
        (None, Some(origin)) => {
            if let Some(path) = config.auth_headers_file.as_deref() {
                require_absolute(path, "authHeadersFile")?;
            }
            Playback::Remote {
                origin: normalize_remote_origin(origin)?,
            }
        }
        (None, None) if schema_version.is_none() => {
            let parent = path
                .parent()
                .ok_or("legacy config path has no parent directory")?;
            Playback::Local {
                site_root: require_directory(&parent.join("site"), "legacy site directory")?,
            }
        }
        (None, None) => {
            return Err(
                "schemaVersion 1 config requires exactly one of siteRoot or viewerOrigin".into(),
            );
        }
    };
    if config.auth_headers_file.is_some() && !matches!(&playback, Playback::Remote { .. }) {
        return Err("authHeadersFile requires a remote viewerOrigin".into());
    }
    match &playback {
        Playback::Local { .. } => {
            require_directory(&config.approved_source_root, "approvedSourceRoot")?;
        }
        Playback::Remote { .. } => {
            require_absolute(&config.approved_source_root, "approvedSourceRoot")?;
        }
    }

    Ok(LoadedConfig { config, playback })
}

fn require_absolute(path: &Path, field: &str) -> Result<(), String> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(format!("{field} must be an absolute path"))
    }
}

fn require_directory(path: &Path, field: &str) -> Result<PathBuf, String> {
    require_absolute(path, field)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("{field} directory is unavailable: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{field} must point to a directory"));
    }
    Ok(canonical)
}

fn normalize_remote_origin(origin: &str) -> Result<String, String> {
    let invalid = || "viewerOrigin must be an HTTPS root or exact HTTP loopback root".to_owned();
    if origin.is_empty()
        || origin
            .bytes()
            .any(|byte| byte <= 0x20 || byte >= 0x7f || byte == b'\\')
        || origin.contains('@')
    {
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
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::{ConfigWriteLock, Playback, load};
    use serde_json::{Value, json};
    use slive_core::{DeckPlayback, RevisionQueryParameter};
    use std::{fs, path::Path};
    use tempfile::tempdir;

    fn write_config(path: &Path, document: Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
    }

    fn base_config() -> Value {
        json!({
            "decks": [{
                "id": "deck-one",
                "revision": "r1",
                "entry": "/deck-one/index.html",
                "clickTotals": [0]
            }],
            "notes": {},
            "approvedSourceRoot": ""
        })
    }

    fn set_path(document: &mut Value, key: &str, path: &Path) {
        document[key] = json!(path.to_string_lossy());
    }

    #[test]
    fn loads_versioned_local_config_with_absolute_site_root() {
        let temp = tempdir().unwrap();
        let site = temp.path().join("versions/v3/site");
        let source = temp.path().join("sources");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&source).unwrap();
        let config_path = temp.path().join("config/local-config.json");
        let mut document = base_config();
        document["schemaVersion"] = json!(1);
        set_path(&mut document, "siteRoot", &site);
        set_path(&mut document, "approvedSourceRoot", &source);
        write_config(&config_path, document);

        let loaded = load(&config_path).unwrap();
        assert_eq!(loaded.config.schema_version, Some(1));
        assert_eq!(
            loaded.playback,
            Playback::Local {
                site_root: site.canonicalize().unwrap()
            }
        );
    }

    #[test]
    fn legacy_local_config_uses_site_next_to_config() {
        let temp = tempdir().unwrap();
        let config_dir = temp.path().join("project");
        let site = config_dir.join("site");
        let source = temp.path().join("sources");
        fs::create_dir_all(&site).unwrap();
        fs::create_dir_all(&source).unwrap();
        let config_path = config_dir.join("local-config.json");
        let mut document = base_config();
        set_path(&mut document, "approvedSourceRoot", &source);
        write_config(&config_path, document);

        let loaded = load(&config_path).unwrap();
        assert_eq!(loaded.config.schema_version, None);
        assert_eq!(
            loaded.playback,
            Playback::Local {
                site_root: site.canonicalize().unwrap()
            }
        );
    }

    #[test]
    fn rejects_unsupported_schema_and_incompatible_playback_fields() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("sources");
        let site = temp.path().join("site");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&site).unwrap();
        let config_path = temp.path().join("local-config.json");
        let mut document = base_config();
        set_path(&mut document, "approvedSourceRoot", &source);
        document["schemaVersion"] = json!(2);
        set_path(&mut document, "siteRoot", &site);
        write_config(&config_path, document.clone());
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("unsupported config schemaVersion 2")
        );

        document["schemaVersion"] = json!(1);
        document["viewerOrigin"] = json!("https://slides.example/");
        write_config(&config_path, document);
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("cannot both be configured")
        );
    }

    #[test]
    fn rejects_missing_invalid_paths_and_controller_invalid_decks() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("sources");
        fs::create_dir_all(&source).unwrap();
        let config_path = temp.path().join("local-config.json");
        let mut document = base_config();
        set_path(&mut document, "approvedSourceRoot", &source);
        document["schemaVersion"] = json!(1);
        write_config(&config_path, document.clone());
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("requires exactly one")
        );

        document["siteRoot"] = json!("relative/site");
        write_config(&config_path, document.clone());
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("siteRoot must be an absolute path")
        );

        document["siteRoot"] = json!(temp.path().join("missing/site").to_string_lossy());
        document["decks"] = json!([]);
        write_config(&config_path, document);
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("deck registry needs page/click bounds")
        );
    }

    #[test]
    fn normalizes_remote_origin_and_requires_absolute_auth_path() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("not-created-remote-source-root");
        let config_path = temp.path().join("local-config.json");
        let mut document = base_config();
        document["schemaVersion"] = json!(1);
        document["viewerOrigin"] = json!("https://EXAMPLE.com/");
        set_path(&mut document, "approvedSourceRoot", &source);
        write_config(&config_path, document.clone());
        let loaded = load(&config_path).unwrap();
        assert_eq!(
            loaded.playback,
            Playback::Remote {
                origin: "https://example.com".into()
            }
        );

        document["authHeadersFile"] = json!("relative/headers.json");
        write_config(&config_path, document);
        assert!(
            load(&config_path)
                .unwrap_err()
                .contains("authHeadersFile must be an absolute path")
        );
    }

    #[test]
    fn loads_and_persists_only_the_supported_revision_query_strategy() {
        let temp = tempdir().unwrap();
        let source = temp.path().join("source-root");
        fs::create_dir_all(&source).unwrap();
        let config_path = temp.path().join("local-config.json");
        let mut document = base_config();
        document["schemaVersion"] = json!(1);
        document["viewerOrigin"] = json!("https://slides.example/");
        document["decks"][0]["playback"] = json!({
            "kind": "revision-query",
            "parameter": "revision"
        });
        set_path(&mut document, "approvedSourceRoot", &source);
        write_config(&config_path, document.clone());

        let loaded = load(&config_path).unwrap();
        assert_eq!(
            loaded.config.decks[0].playback,
            Some(DeckPlayback::RevisionQuery {
                parameter: RevisionQueryParameter::Revision
            })
        );
        assert_eq!(
            serde_json::to_value(&loaded.config.decks[0]).unwrap()["playback"],
            json!({ "kind": "revision-query", "parameter": "revision" })
        );

        for playback in [
            json!({ "kind": "path", "parameter": "revision" }),
            json!({ "kind": "revision-query", "parameter": "build" }),
        ] {
            document["decks"][0]["playback"] = playback;
            write_config(&config_path, document.clone());
            assert!(load(&config_path).is_err(), "invalid strategy was accepted");
        }
    }

    #[test]
    fn config_lock_rejects_contention_and_removes_its_file_on_drop() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join("local-config.json");
        fs::write(&config_path, "{}").unwrap();
        let lock_path = crate::paths::config_lock_path(&config_path).unwrap();
        let lock = ConfigWriteLock::acquire(&config_path).unwrap();
        assert!(lock_path.is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&lock_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let error = ConfigWriteLock::acquire(&config_path).unwrap_err();
        assert!(error.contains("reload and retry"));

        drop(lock);
        assert!(!lock_path.exists());
        let next = ConfigWriteLock::acquire(&config_path).unwrap();
        drop(next);
    }
}
