use serde_json::{Value, json};
use slidev_native_core::{Controller, Deck};
use std::{fs, path::PathBuf};

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/native-player")
}

fn accepted_deck_fields(document: &Value) -> Vec<Value> {
    document["decks"]
        .as_array()
        .expect("fixture decks must be an array")
        .iter()
        .map(|deck| {
            let mut fields = json!({
                "id": deck["id"],
                "revision": deck["revision"],
                "entry": deck["entry"],
                "clickTotals": deck["clickTotals"],
            });
            if document["schemaVersion"] == 2 {
                fields["playback"] = json!({
                    "kind": deck["playback"]["kind"],
                    "parameter": deck["playback"]["parameter"],
                });
            }
            fields
        })
        .collect()
}

#[test]
fn shared_v1_and_v2_deck_fixtures_match_serde_and_controller_bounds() {
    let mut paths = Vec::new();
    for version in ["v1", "v2"] {
        paths.extend(
            fs::read_dir(fixtures_root().join(version))
                .expect("shared native-player fixtures must be present")
                .map(|entry| entry.expect("fixture directory entry").path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                }),
        );
    }
    paths.sort();
    assert!(!paths.is_empty(), "expected shared native-player fixtures");

    for path in paths {
        let fixture: Value = serde_json::from_slice(
            &fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display())),
        )
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()));
        let name = fixture["name"].as_str().expect("fixture name");
        let accepted = fixture["accepted"]
            .as_bool()
            .expect("fixture accepted flag");
        let document = &fixture["document"];

        // Rust checks the persisted deck representation and bounds. Node owns
        // the full discovery document contract, including unsupported decks.
        assert!(
            document["schemaVersion"]
                .as_u64()
                .is_some_and(|version| matches!(version, 1 | 2)),
            "{name}"
        );
        assert_eq!(document["protocolVersion"], 1, "{name}");
        assert_eq!(document["unsupportedDecks"], json!([]), "{name}");

        let v2_has_playback_for_every_deck = document["schemaVersion"] != 2
            || document["decks"]
                .as_array()
                .is_some_and(|decks| decks.iter().all(|deck| deck.get("playback").is_some()));
        let result = if !v2_has_playback_for_every_deck {
            Err("v2 requires playback for every supported deck".to_owned())
        } else {
            serde_json::from_value::<Vec<Deck>>(document["decks"].clone())
                .map_err(|error| error.to_string())
                .and_then(|decks| {
                    Controller::new(decks.clone())
                        .map(|_| decks)
                        .map_err(|error| error.to_string())
                })
        };

        assert_eq!(result.is_ok(), accepted, "fixture {name}: {result:?}");
        if let Ok(decks) = result {
            let serialized = serde_json::to_value(decks).expect("serialize accepted decks");
            assert_eq!(serialized, json!(accepted_deck_fields(document)), "{name}");
        }
    }
}
