use serde_json::{Value, json};
use slidev_native_core::{Controller, Deck};
use std::{fs, path::PathBuf};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/native-player/v1")
}

fn accepted_deck_fields(document: &Value) -> Vec<Value> {
    document["decks"]
        .as_array()
        .expect("fixture decks must be an array")
        .iter()
        .map(|deck| {
            json!({
                "id": deck["id"],
                "revision": deck["revision"],
                "entry": deck["entry"],
                "clickTotals": deck["clickTotals"],
            })
        })
        .collect()
}

#[test]
fn shared_v1_deck_fixtures_match_serde_and_controller_bounds() {
    let mut paths: Vec<_> = fs::read_dir(fixtures_dir())
        .expect("shared native-player fixtures must be present")
        .map(|entry| entry.expect("fixture directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
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

        // This test covers the Rust deck shape and bounds only. The discovery
        // versions and unsupported-deck list remain Node contract checks.
        assert_eq!(document["schemaVersion"], 1, "{name}");
        assert_eq!(document["protocolVersion"], 1, "{name}");
        assert_eq!(document["unsupportedDecks"], json!([]), "{name}");

        let result = serde_json::from_value::<Vec<Deck>>(document["decks"].clone())
            .map_err(|error| error.to_string())
            .and_then(|decks| {
                Controller::new(decks.clone())
                    .map(|_| decks)
                    .map_err(|error| error.to_string())
            });

        assert_eq!(result.is_ok(), accepted, "fixture {name}: {result:?}");
        if let Ok(decks) = result {
            let serialized = serde_json::to_value(decks).expect("serialize accepted decks");
            assert_eq!(serialized, json!(accepted_deck_fields(document)), "{name}");
        }
    }
}
