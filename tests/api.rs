// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use std::{
  path::Path,
  sync::{Arc, RwLock},
};
use verde::api::{self, ApiState};
use verde::core::payload::{Payload, PayloadAction};
use verde::core::project::VerdeProject;
use verde::core::tree::{GameTree, TreeState};

/// Creates a default project rooted in a tempdir.
fn project_in(directory: &Path) -> Arc<VerdeProject> {
  let mut project = VerdeProject {
    root: Some(directory.to_path_buf()),
    ..Default::default()
  };
  project.tree.precalculate();
  Arc::new(project)
}

/// Creates api state for a project rooted in a tempdir.
fn state_in(directory: &Path) -> Arc<ApiState> {
  let project = project_in(directory);
  let payload = Arc::new(RwLock::new(Payload::default()));
  let tree = Arc::new(TreeState::initialise(&project).unwrap());

  Arc::new(ApiState {
    payload,
    tree,
    project: Arc::clone(&project),
  })
}

#[tokio::test]
async fn heartbeat_retains_queued_actions_until_acknowledged() {
  let directory = tempfile::tempdir().unwrap();
  let state = state_in(directory.path());
  let filter = api::get_routes(Arc::clone(&state));

  state.payload.write().unwrap().add_payload(PayloadAction::Create {
    path: vec![String::from("Workspace")],
    class_name: Some(String::from("Workspace")),
    properties: Default::default(),
  });
  state.payload.write().unwrap().add_payload(PayloadAction::Delete {
    path: vec![String::from("Workspace"), String::from("Old")],
  });

  let response = warp::test::request()
    .method("GET")
    .path("/heartbeat")
    .reply(&filter)
    .await;
  assert_eq!(response.status(), 200);
  let body = serde_json::from_slice::<serde_json::Value>(response.body()).unwrap();
  let events = body["events"].as_array().unwrap();
  assert_eq!(events.len(), 2);
  assert_eq!(events[0]["action"], "create");
  assert_eq!(events[1]["action"], "delete");
  let cursor = body["cursor"].as_u64().unwrap();

  // Reading again before acknowledgement returns the same actions.
  let response = warp::test::request()
    .method("GET")
    .path("/heartbeat")
    .reply(&filter)
    .await;
  let body = serde_json::from_slice::<serde_json::Value>(response.body()).unwrap();
  assert_eq!(body["events"].as_array().unwrap().len(), 2);
  assert_eq!(body["cursor"], cursor);

  // An explicit acknowledgement removes only the delivered actions.
  let response = warp::test::request()
    .method("POST")
    .path("/heartbeat")
    .json(&serde_json::json!({ "cursor": cursor }))
    .reply(&filter)
    .await;
  assert_eq!(response.status(), 200);

  let response = warp::test::request()
    .method("GET")
    .path("/heartbeat")
    .reply(&filter)
    .await;
  assert_eq!(
    serde_json::from_slice::<serde_json::Value>(response.body()).unwrap()["events"]
      .as_array()
      .unwrap()
      .len(),
    0
  );
}

#[tokio::test]
async fn connect_returns_project_metadata() {
  let directory = tempfile::tempdir().unwrap();
  let filter = api::get_routes(state_in(directory.path()));

  let response = warp::test::request()
    .method("POST")
    .path("/connect")
    .json(&serde_json::json!({ "pluginVersion": "0.1.0" }))
    .reply(&filter)
    .await;

  assert_eq!(response.status(), 200);
  let body = serde_json::from_slice::<serde_json::Value>(response.body()).unwrap();
  assert_eq!(body["status"], "ok");
  assert_eq!(body["name"], "A Verde Project");
  let services = body["services"].as_array().unwrap();
  assert!(services.iter().any(|service| service == "ServerScriptService"));
  assert!(services.iter().any(|service| service == "ReplicatedStorage"));
}

#[tokio::test]
async fn disconnect_acknowledges() {
  let directory = tempfile::tempdir().unwrap();
  let filter = api::get_routes(state_in(directory.path()));

  let response = warp::test::request()
    .method("POST")
    .path("/disconnect")
    .reply(&filter)
    .await;
  assert_eq!(response.status(), 200);
  assert_eq!(
    serde_json::from_slice::<serde_json::Value>(response.body()).unwrap()["status"],
    "ok"
  );
}

#[tokio::test]
async fn tree_ingest_merges_pending_edits_and_refreshes_game_json() {
  let directory = tempfile::tempdir().unwrap();
  let state = state_in(directory.path());
  let filter = api::get_routes(Arc::clone(&state));

  // The AI edits game.json while the plugin exports a tree without the edit.
  let game_json_path = directory.path().join("game.json");
  let mut document = GameTree::load(&game_json_path).unwrap();
  document
    .root
    .children
    .insert(String::from("Workspace"), Default::default());
  document.save_pretty(&game_json_path).unwrap();

  let export = serde_json::json!({
    "formatVersion": 1,
    "className": "DataModel",
    "children": { "Lighting": {} }
  });

  let response = warp::test::request()
    .method("POST")
    .path("/tree")
    .json(&export)
    .reply(&filter)
    .await;

  assert_eq!(response.status(), 200);
  let body = serde_json::from_slice::<serde_json::Value>(response.body()).unwrap();
  assert_eq!(body["status"], "ok");
  assert_eq!(body["pending"], 1);

  // The pending edit was queued for the plugin.
  let events = state.payload.read().unwrap().events.clone();
  assert_eq!(events.len(), 1);

  // game.json was refreshed with the export plus the pending edit.
  let merged = GameTree::load(&game_json_path).unwrap();
  assert!(merged.root.children.contains_key("Lighting"));
  assert!(merged.root.children.contains_key("Workspace"));
}

#[tokio::test]
async fn tree_ingest_rejects_unsupported_format_versions() {
  let directory = tempfile::tempdir().unwrap();
  let filter = api::get_routes(state_in(directory.path()));

  let export = serde_json::json!({
    "formatVersion": 99,
    "className": "DataModel",
    "children": {}
  });

  let response = warp::test::request()
    .method("POST")
    .path("/tree")
    .json(&export)
    .reply(&filter)
    .await;

  assert_eq!(response.status(), 400);
  assert_eq!(
    serde_json::from_slice::<serde_json::Value>(response.body()).unwrap()["status"],
    "error"
  );
}

#[tokio::test]
async fn tree_ingest_rejects_invalid_game_json_without_changing_state_files() {
  let directory = tempfile::tempdir().unwrap();
  let state = state_in(directory.path());
  let filter = api::get_routes(Arc::clone(&state));
  let game_json_path = directory.path().join("game.json");
  let snapshot_path = directory.path().join(".verde").join("snapshot.json");

  std::fs::write(&game_json_path, "not json").unwrap();
  let game_before = std::fs::read(&game_json_path).unwrap();
  let snapshot_before = std::fs::read(&snapshot_path).unwrap();

  let response = warp::test::request()
    .method("POST")
    .path("/tree")
    .json(&serde_json::json!({
      "formatVersion": 1,
      "className": "DataModel",
      "children": { "Workspace": {} }
    }))
    .reply(&filter)
    .await;

  assert_eq!(response.status(), 500);
  assert_eq!(std::fs::read(&game_json_path).unwrap(), game_before);
  assert_eq!(std::fs::read(&snapshot_path).unwrap(), snapshot_before);
  assert!(state.payload.read().unwrap().events.is_empty());
}
