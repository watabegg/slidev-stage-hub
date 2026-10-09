use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::Write, path::PathBuf};

pub mod sidecar_notes;
pub use sidecar_notes::{SidecarNote, SidecarNotes};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: String,
    pub revision: String,
    pub entry: String,
    pub click_totals: Vec<u32>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub elapsed_ms: u64,
    pub started_at: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub deck_id: String,
    pub revision: String,
    pub page: usize,
    pub click_index: u32,
    pub blackout: bool,
    pub session_revision: u64,
    pub timer: Timer,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum Action {
    Next,
    Previous,
    ToggleBlackout,
    ToggleTimer,
    ResetTimer,
    SelectDeck(String),
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    pub source: String,
    pub sequence: u64,
    pub editing: bool,
    pub action: Action,
}
pub struct Controller {
    pub decks: Vec<Deck>,
    pub session: Session,
    seen: HashMap<String, u64>,
}
impl Controller {
    pub fn new(decks: Vec<Deck>) -> Result<Self, String> {
        if decks.is_empty() || decks.iter().any(|d| d.click_totals.is_empty()) {
            return Err("deck registry needs page/click bounds".into());
        }
        let d = &decks[0];
        Ok(Self {
            session: Session {
                deck_id: d.id.clone(),
                revision: d.revision.clone(),
                page: 1,
                click_index: 0,
                blackout: false,
                session_revision: 0,
                timer: Timer::default(),
            },
            decks,
            seen: HashMap::new(),
        })
    }
    pub fn apply(&mut self, input: Input) -> Result<bool, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis() as u64;
        self.apply_at(input, now)
    }
    pub fn apply_at(&mut self, input: Input, now: u64) -> Result<bool, String> {
        if !matches!(input.source.as_str(), "presenter" | "audience") {
            return Err("unknown input source".into());
        }
        if self
            .seen
            .get(&input.source)
            .is_some_and(|seq| input.sequence <= *seq)
        {
            return Ok(false);
        }
        self.seen.insert(input.source, input.sequence);
        if input.editing {
            return Ok(false);
        }
        let before = self.session.clone();
        let current = self
            .decks
            .iter()
            .find(|d| d.id == self.session.deck_id)
            .unwrap();
        match input.action {
            Action::Next => {
                if self.session.click_index < current.click_totals[self.session.page - 1] {
                    self.session.click_index += 1;
                } else if self.session.page < current.click_totals.len() {
                    self.session.page += 1;
                    self.session.click_index = 0;
                }
            }
            Action::Previous => {
                if self.session.click_index > 0 {
                    self.session.click_index -= 1;
                } else if self.session.page > 1 {
                    self.session.page -= 1;
                    self.session.click_index = current.click_totals[self.session.page - 1];
                }
            }
            Action::ToggleBlackout => self.session.blackout = !self.session.blackout,
            Action::ToggleTimer => {
                if let Some(start) = self.session.timer.started_at.take() {
                    self.session.timer.elapsed_ms += now.saturating_sub(start);
                } else {
                    self.session.timer.started_at = Some(now);
                }
            }
            Action::ResetTimer => self.session.timer = Timer::default(),
            Action::SelectDeck(id) => {
                let deck = self
                    .decks
                    .iter()
                    .find(|d| d.id == id)
                    .ok_or("deck is not in bundled registry")?;
                self.session.deck_id = deck.id.clone();
                self.session.revision = deck.revision.clone();
                self.session.page = 1;
                self.session.click_index = 0;
                self.session.blackout = false;
            }
        }
        if before == self.session {
            return Ok(false);
        }
        self.session.session_revision += 1;
        Ok(true)
    }
}

/// Mapping is generated locally from the same parser used to build the source deck.
/// The public viewer receives neither the source path nor this mapping.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSlot {
    pub start: usize,
    pub end: usize,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMap {
    pub source: PathBuf,
    pub revision: String,
    pub slots: Vec<Option<NoteSlot>>,
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub struct NotesDocument {
    map: NoteMap,
    bytes: Vec<u8>,
}
impl NotesDocument {
    pub fn open(map: NoteMap, approved_root: &std::path::Path) -> Result<Self, String> {
        let source = map.source.canonicalize().map_err(|e| e.to_string())?;
        let root = approved_root.canonicalize().map_err(|e| e.to_string())?;
        if !source.starts_with(root) {
            return Err("source escapes the approved fixture root".into());
        }
        let bytes = fs::read(&source).map_err(|e| e.to_string())?;
        if digest(&bytes) != map.revision {
            return Err("source changed since mapping was prepared".into());
        }
        let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let mut last_end = 0;
        for slot in map.slots.iter().flatten() {
            if slot.start < last_end
                || slot.start > slot.end
                || slot.end > bytes.len()
                || !text.is_char_boundary(slot.start)
                || !text.is_char_boundary(slot.end)
            {
                return Err("invalid notes mapping".into());
            }
            last_end = slot.end;
        }
        Ok(Self {
            map: NoteMap { source, ..map },
            bytes,
        })
    }
    pub fn mapping(&self) -> NoteMap {
        self.map.clone()
    }
    pub fn source_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn revision(&self) -> &str {
        &self.map.revision
    }
    pub fn read(&self, page: usize) -> Result<String, String> {
        let slot = self
            .map
            .slots
            .get(page.checked_sub(1).ok_or("page must be positive")?)
            .ok_or("page outside notes mapping")?
            .as_ref()
            .ok_or("this slide has no existing notes comment")?;
        String::from_utf8(self.bytes[slot.start..slot.end].to_vec()).map_err(|e| e.to_string())
    }
    pub fn save(
        &mut self,
        page: usize,
        expected_revision: &str,
        notes: &str,
    ) -> Result<String, String> {
        if expected_revision != self.map.revision {
            return Err("stale editor revision; reload notes".into());
        }
        if notes.contains("-->") || notes.contains("<!--") {
            return Err("notes cannot contain HTML comment delimiters".into());
        }
        let current = fs::read(&self.map.source).map_err(|e| e.to_string())?;
        if current != self.bytes {
            return Err("external source edit detected; save rejected".into());
        }
        let index = page.checked_sub(1).ok_or("page must be positive")?;
        let slot = self
            .map
            .slots
            .get(index)
            .ok_or("page outside notes mapping")?
            .as_ref()
            .ok_or("this slide has no existing notes comment")?
            .clone();
        let mut next = self.bytes[..slot.start].to_vec();
        next.extend_from_slice(notes.as_bytes());
        next.extend_from_slice(&self.bytes[slot.end..]);
        let parent = self.map.source.parent().ok_or("source has no parent")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        staged
            .as_file()
            .set_permissions(
                fs::metadata(&self.map.source)
                    .map_err(|e| e.to_string())?
                    .permissions(),
            )
            .map_err(|e| e.to_string())?;
        staged.write_all(&next).map_err(|e| e.to_string())?;
        staged.as_file().sync_all().map_err(|e| e.to_string())?;
        // Recheck immediately before the atomic rename. External writers do not share our lock;
        // an external edit racing exactly between this check and rename is a documented PoC limit.
        if fs::read(&self.map.source).map_err(|e| e.to_string())? != self.bytes {
            return Err("external source edit detected before replace".into());
        }
        staged
            .persist(&self.map.source)
            .map_err(|e| e.to_string())?;
        let shift = notes.len() as isize - (slot.end - slot.start) as isize;
        self.map.slots[index].as_mut().unwrap().end = slot.start + notes.len();
        for later in self.map.slots[index + 1..].iter_mut().flatten() {
            later.start = later
                .start
                .checked_add_signed(shift)
                .ok_or("offset overflow")?;
            later.end = later
                .end
                .checked_add_signed(shift)
                .ok_or("offset overflow")?;
        }
        self.bytes = next;
        self.map.revision = digest(&self.bytes);
        Ok(self.map.revision.clone())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ctrl() -> Controller {
        Controller::new(vec![
            Deck {
                id: "aaa/aaa1".into(),
                revision: "a".into(),
                entry: "/aaa/aaa1/1".into(),
                click_totals: vec![0, 2, 0],
            },
            Deck {
                id: "bbb/bbb1".into(),
                revision: "b".into(),
                entry: "/bbb/bbb1/1".into(),
                click_totals: vec![0],
            },
        ])
        .unwrap()
    }
    fn input(seq: u64, action: Action) -> Input {
        Input {
            source: "presenter".into(),
            sequence: seq,
            editing: false,
            action,
        }
    }
    #[test]
    fn one_input_one_transition_and_click_bounds() {
        let mut c = ctrl();
        c.apply(input(1, Action::Next)).unwrap();
        assert_eq!(
            (
                c.session.page,
                c.session.click_index,
                c.session.session_revision
            ),
            (2, 0, 1)
        );
        assert!(!c.apply(input(1, Action::Next)).unwrap());
        assert_eq!(c.session.session_revision, 1);
        c.apply(input(2, Action::Next)).unwrap();
        c.apply(input(3, Action::Next)).unwrap();
        assert_eq!((c.session.page, c.session.click_index), (2, 2));
        c.apply(input(4, Action::Next)).unwrap();
        c.apply(input(5, Action::Previous)).unwrap();
        assert_eq!((c.session.page, c.session.click_index), (2, 2));
    }
    #[test]
    fn editor_and_boundary_suppression_and_switch() {
        let mut c = ctrl();
        assert!(!c.apply(input(1, Action::Previous)).unwrap());
        let mut i = input(2, Action::Next);
        i.editing = true;
        assert!(!c.apply(i).unwrap());
        assert_eq!(c.session.session_revision, 0);
        c.apply(input(3, Action::ToggleBlackout)).unwrap();
        assert!(c.session.blackout);
        c.apply(input(4, Action::SelectDeck("bbb/bbb1".into())))
            .unwrap();
        assert_eq!(c.session.deck_id, "bbb/bbb1");
        assert!(!c.session.blackout);
        assert!(
            c.apply(input(5, Action::SelectDeck("unknown".into())))
                .is_err()
        );
    }
    #[test]
    fn independent_window_sequences_do_not_duplicate_echoes() {
        let mut c = ctrl();
        c.apply(input(1, Action::Next)).unwrap();
        let mut i = input(1, Action::Next);
        i.source = "audience".into();
        c.apply(i.clone()).unwrap();
        assert!(!c.apply(i).unwrap());
        assert_eq!(c.session.session_revision, 2);
    }
    #[test]
    fn notes_unicode_atomic_save_preserves_other_bytes_and_detects_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("deck.md");
        let text = "# page\n<!--日本語-->\n---\n# two\n<!--second-->\n";
        fs::write(&file, text).unwrap();
        let a = text.find("日本語").unwrap();
        let b = text.find("second").unwrap();
        let map = NoteMap {
            source: file.clone(),
            revision: digest(text.as_bytes()),
            slots: vec![
                Some(NoteSlot {
                    start: a,
                    end: a + "日本語".len(),
                }),
                Some(NoteSlot {
                    start: b,
                    end: b + 6,
                }),
            ],
        };
        let mut doc = NotesDocument::open(map, dir.path()).unwrap();
        let rev = doc.revision().to_string();
        let rev = doc.save(1, &rev, "編集済み").unwrap();
        assert_eq!(doc.read(2).unwrap(), "second");
        let mut reopened = NotesDocument::open(doc.mapping(), dir.path()).unwrap();
        assert_eq!(reopened.read(1).unwrap(), "編集済み");
        let reopened_revision = reopened.revision().to_string();
        reopened.save(2, &reopened_revision, "persisted").unwrap();
        assert_eq!(reopened.read(2).unwrap(), "persisted");
        fs::write(&file, text.replace("日本語", "編集済み")).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            text.replace("日本語", "編集済み")
        );
        assert!(doc.save(2, "stale", "x").is_err());
        fs::write(&file, "external edit").unwrap();
        assert!(doc.save(2, &rev, "x").unwrap_err().contains("external"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "external edit");
    }
    #[test]
    fn timer_uses_authority_timestamps_and_deduplicates_inputs() {
        let mut c = ctrl();
        c.apply_at(input(1, Action::ToggleTimer), 1000).unwrap();
        assert_eq!(c.session.timer.started_at, Some(1000));
        assert!(!c.apply_at(input(1, Action::ToggleTimer), 1200).unwrap());
        c.apply_at(input(2, Action::ToggleTimer), 2500).unwrap();
        assert_eq!(c.session.timer.elapsed_ms, 1500);
        assert_eq!(c.session.timer.started_at, None);
        c.apply_at(input(3, Action::ResetTimer), 3000).unwrap();
        assert_eq!(c.session.timer, Timer::default());
    }
    #[test]
    fn notes_source_scope_is_enforced() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let file = b.path().join("secret");
        fs::write(&file, "").unwrap();
        assert!(
            NotesDocument::open(
                NoteMap {
                    source: file,
                    revision: digest(b""),
                    slots: vec![]
                },
                a.path()
            )
            .is_err()
        );
    }
}
