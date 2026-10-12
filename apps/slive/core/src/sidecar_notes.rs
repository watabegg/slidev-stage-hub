use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const SCHEMA_VERSION: u32 = 1;

/// Persistent notes keyed by the caller-provided canonical original slide URL.
///
/// The URL is stored verbatim and should include the complete origin, deck, and page. Source
/// revisions are recorded separately so a deck rebuild does not orphan its notes.
pub struct SidecarNotes {
    directory: PathBuf,
}

/// A note and the revision observed when it was read or saved.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarNote {
    pub text: String,
    pub revision: String,
    pub source_changed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotesFile {
    schema_version: u32,
    notes: BTreeMap<String, StoredNote>,
}

impl Default for NotesFile {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            notes: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredNote {
    text: String,
    source_revision: String,
    version: u64,
}

impl SidecarNotes {
    /// Opens the notes store, creating missing directories with private permissions.
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        if directory.as_os_str().is_empty() {
            return Err("notes directory path is empty".into());
        }
        create_private_directories(&directory).map_err(|error| {
            format!(
                "could not create notes directory {}: {error}",
                directory.display()
            )
        })?;
        Ok(Self { directory })
    }

    /// Reads a note by its full canonical slide URL.
    pub fn read(
        &self,
        slide_url: &str,
        current_source_revision: &str,
    ) -> Result<SidecarNote, String> {
        validate_slide_url(slide_url)?;
        let _lock = self.acquire_lock()?;
        let stored = self.read_store()?.notes.get(slide_url).cloned();
        Ok(match stored {
            Some(note) => SidecarNote {
                text: note.text,
                revision: note.version.to_string(),
                source_changed: note.source_revision != current_source_revision,
            },
            None => SidecarNote {
                text: String::new(),
                revision: "0".into(),
                source_changed: false,
            },
        })
    }

    /// Saves a note if the on-disk note version still matches `expected_revision`.
    pub fn save(
        &self,
        slide_url: &str,
        current_source_revision: &str,
        expected_revision: &str,
        text: &str,
    ) -> Result<SidecarNote, String> {
        validate_slide_url(slide_url)?;
        let _lock = self.acquire_lock()?;
        let mut store = self.read_store()?;
        let current = store.notes.get(slide_url);
        let current_version = current.map_or(0, |note| note.version);
        let current_revision = current_version.to_string();
        if expected_revision != current_revision {
            return Err(format!(
                "note revision conflict for {slide_url}: expected {expected_revision}, current {current_revision}"
            ));
        }
        let version = current_version
            .checked_add(1)
            .ok_or("note revision overflow")?;
        store.notes.insert(
            slide_url.to_owned(),
            StoredNote {
                text: text.to_owned(),
                source_revision: current_source_revision.to_owned(),
                version,
            },
        );
        self.write_store(&store)?;
        Ok(SidecarNote {
            text: text.to_owned(),
            revision: version.to_string(),
            source_changed: false,
        })
    }

    fn acquire_lock(&self) -> Result<StoreLock, String> {
        let path = self.directory.join("notes.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|error| format!("could not open notes lock {}: {error}", path.display()))?;
        set_private_file_permissions(&file)
            .map_err(|error| format!("could not protect notes lock {}: {error}", path.display()))?;
        file.lock()
            .map_err(|error| format!("could not lock notes store {}: {error}", path.display()))?;
        Ok(StoreLock(file))
    }

    fn read_store(&self) -> Result<NotesFile, String> {
        let path = self.directory.join("notes.json");
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(NotesFile::default());
            }
            Err(error) => {
                return Err(format!(
                    "could not read notes file {}: {error}",
                    path.display()
                ));
            }
        };
        if !file
            .metadata()
            .map_err(|error| format!("could not inspect notes file {}: {error}", path.display()))?
            .is_file()
        {
            return Err(format!("notes path {} is not a file", path.display()));
        }
        set_private_file_permissions(&file)
            .map_err(|error| format!("could not protect notes file {}: {error}", path.display()))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("could not read notes file {}: {error}", path.display()))?;
        let store: NotesFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("notes file {} is malformed: {error}", path.display()))?;
        if store.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "unsupported notes schema version {} in {}",
                store.schema_version,
                path.display()
            ));
        }
        for (url, note) in &store.notes {
            validate_slide_url(url)?;
            if note.version == 0 {
                return Err(format!(
                    "notes file {} contains a zero version for {url}",
                    path.display()
                ));
            }
        }
        Ok(store)
    }

    fn write_store(&self, store: &NotesFile) -> Result<(), String> {
        let path = self.directory.join("notes.json");
        let mut bytes = serde_json::to_vec_pretty(store)
            .map_err(|error| format!("could not encode notes file: {error}"))?;
        bytes.push(b'\n');
        let mut staged = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|error| format!("could not stage notes file: {error}"))?;
        set_private_file_permissions(staged.as_file())
            .map_err(|error| format!("could not protect staged notes file: {error}"))?;
        staged
            .write_all(&bytes)
            .map_err(|error| format!("could not write staged notes file: {error}"))?;
        staged
            .as_file()
            .sync_all()
            .map_err(|error| format!("could not sync staged notes file: {error}"))?;
        staged
            .persist(&path)
            .map_err(|error| format!("could not replace notes file {}: {error}", path.display()))?;
        Ok(())
    }
}

fn validate_slide_url(slide_url: &str) -> Result<(), String> {
    if slide_url.trim().is_empty() {
        return Err("slide URL must be a full canonical URL".into());
    }
    Ok(())
}

fn create_private_directories(path: &Path) -> std::io::Result<()> {
    match create_private_directory(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if fs::metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "notes directory path is not a directory",
                ))
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            create_private_directories(parent)?;
            create_private_directories(path)
        }
        Err(error) => Err(error),
    }
}

fn create_private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(file: &File) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_file: &File) -> std::io::Result<()> {
    Ok(())
}

struct StoreLock(File);

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://slides.example.test/talks/demo/3";

    fn store(directory: &Path) -> SidecarNotes {
        SidecarNotes::new(directory.to_path_buf()).unwrap()
    }

    #[test]
    fn absent_unicode_create_reopen_and_clear() {
        let directory = tempfile::tempdir().unwrap();
        let notes = store(directory.path());
        assert_eq!(
            notes.read(URL, "source-a").unwrap(),
            SidecarNote {
                text: String::new(),
                revision: "0".into(),
                source_changed: false,
            }
        );

        let saved = notes
            .save(URL, "source-a", "0", "発表メモ 🐈\n二行目")
            .unwrap();
        assert_eq!(saved.text, "発表メモ 🐈\n二行目");
        assert_eq!(saved.revision, "1");
        assert!(!saved.source_changed);

        let reopened = store(directory.path());
        assert_eq!(reopened.read(URL, "source-a").unwrap(), saved);
        let cleared = reopened.save(URL, "source-a", "1", "").unwrap();
        assert_eq!(cleared.text, "");
        assert_eq!(cleared.revision, "2");
        assert_eq!(reopened.read(URL, "source-a").unwrap(), cleared);
    }

    #[test]
    fn origin_deck_and_page_are_independent_keys() {
        let directory = tempfile::tempdir().unwrap();
        let notes = store(directory.path());
        let urls = [
            "https://one.example.test/deck-a/3",
            "https://two.example.test/deck-a/3",
            "https://one.example.test/deck-b/3",
            "https://one.example.test/deck-a/4",
        ];
        for (index, url) in urls.iter().enumerate() {
            notes
                .save(url, "source-a", "0", &format!("note-{index}"))
                .unwrap();
        }
        for (index, url) in urls.iter().enumerate() {
            assert_eq!(
                notes.read(url, "source-a").unwrap().text,
                format!("note-{index}")
            );
        }
    }

    #[test]
    fn source_change_keeps_note_and_warning_clears_after_save() {
        let directory = tempfile::tempdir().unwrap();
        let notes = store(directory.path());
        notes.save(URL, "revision-a", "0", "keep me").unwrap();

        let changed = notes.read(URL, "revision-b").unwrap();
        assert_eq!(changed.text, "keep me");
        assert_eq!(changed.revision, "1");
        assert!(changed.source_changed);

        let saved = notes
            .save(URL, "revision-b", &changed.revision, "updated")
            .unwrap();
        assert_eq!(saved.text, "updated");
        assert!(!saved.source_changed);
        assert!(!notes.read(URL, "revision-b").unwrap().source_changed);
        assert!(notes.read(URL, "revision-a").unwrap().source_changed);
    }

    #[test]
    fn stale_revision_is_rejected_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let notes = store(directory.path());
        notes.save(URL, "source", "0", "first").unwrap();
        assert!(
            notes
                .save(URL, "source", "0", "stale")
                .unwrap_err()
                .contains("conflict")
        );
        assert_eq!(notes.read(URL, "source").unwrap().text, "first");
    }

    #[test]
    fn independent_handles_reread_under_lock_before_save() {
        let directory = tempfile::tempdir().unwrap();
        let first = store(directory.path());
        let second = store(directory.path());
        assert_eq!(first.read(URL, "source").unwrap().revision, "0");
        assert_eq!(second.read(URL, "source").unwrap().revision, "0");

        first.save(URL, "source", "0", "winner").unwrap();
        assert!(
            second
                .save(URL, "source", "0", "loser")
                .unwrap_err()
                .contains("conflict")
        );
        assert_eq!(first.read(URL, "source").unwrap().text, "winner");
    }

    #[test]
    fn malformed_or_unsupported_store_is_not_overwritten() {
        for contents in ["{broken json", r#"{"schemaVersion":2,"notes":{}}"#] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("notes.json");
            fs::write(&path, contents).unwrap();
            let before = fs::read(&path).unwrap();
            let notes = store(directory.path());

            assert!(notes.read(URL, "source").is_err());
            assert!(notes.save(URL, "source", "0", "replace?").is_err());
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }

    #[cfg(unix)]
    #[test]
    fn created_paths_are_private_without_chmodding_existing_parent() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempfile::tempdir().unwrap();
        fs::set_permissions(parent.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let directory_path = parent.path().join("nested").join("notes");
        let notes = store(&directory_path);
        notes.read(URL, "source").unwrap();
        notes.save(URL, "source", "0", "private").unwrap();

        assert_eq!(
            fs::metadata(parent.path()).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(directory_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&directory_path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in ["notes.json", "notes.lock"] {
            assert_eq!(
                fs::metadata(directory_path.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
