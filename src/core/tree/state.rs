// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use super::{
  diff::{apply_actions, diff_trees},
  GameNode, GameTree, GAME_FILE,
};
use crate::core::payload::Payload;
use crate::core::project::VerdeProject;
use anyhow::{Context, Result};
use std::{
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, RwLock,
  },
};

/// The directory storing Verde sync state within a project.
const STATE_DIRECTORY: &str = ".verde";

/// The baseline snapshot file name within the state directory.
const SNAPSHOT_FILE: &str = "snapshot.json";

/// Manages the game tree baseline: the last known state of the game that
/// game.json edits are diffed against.
///
/// The baseline persists to `.verde/snapshot.json` so edits made while Verde
/// is not running are still applied on the next start.
pub struct TreeState {
  /// The path of the game.json document.
  game_json_path: PathBuf,

  /// The path of the persistent baseline snapshot.
  snapshot_path: PathBuf,

  /// The baseline the next game.json diff is taken against.
  baseline: RwLock<GameTree>,

  /// Whether the baseline reflects a persisted Studio export.
  baseline_initialised: AtomicBool,

  /// Instance paths covered by project `.path` mappings.
  /// Their script source is owned by the file sync pipeline.
  managed_paths: Vec<Vec<String>>,

  /// The project tied to the state.
  project: Arc<VerdeProject>,
}

impl TreeState {
  /// Initialises the tree state for a project, creating the game.json
  /// document and baseline snapshot when absent.
  pub fn initialise(project: &Arc<VerdeProject>) -> Result<Self> {
    let root = project.root.as_ref().context("The project has no root directory")?;
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());

    let state = Self {
      game_json_path: root.join(GAME_FILE),
      snapshot_path: root.join(STATE_DIRECTORY).join(SNAPSHOT_FILE),
      baseline: RwLock::new(super::skeleton_from_project(project)),
      baseline_initialised: AtomicBool::new(true),
      managed_paths: managed_paths(project),
      project: Arc::clone(project),
    };

    if state.snapshot_path.is_file() {
      // Resume from the persisted baseline.
      *state.baseline.write().unwrap() = GameTree::load(&state.snapshot_path)?;
      if !state.game_json_path.is_file() {
        state.baseline.read().unwrap().save_pretty(&state.game_json_path)?;
      }
    } else if state.game_json_path.is_file() {
      // A document exists without a snapshot, so deletes are unavailable
      // until the plugin exports a tree to establish a baseline.
      eprintln!("Found game.json without a snapshot; deletes are unavailable until the plugin exports a tree.");
      state.baseline_initialised.store(false, Ordering::Release);
    } else {
      let skeleton = state.baseline.read().unwrap().clone();
      skeleton.save_pretty(&state.snapshot_path)?;
      skeleton.save_pretty(&state.game_json_path)?;
    }

    Ok(state)
  }

  /// Handles a game.json change: diffs the document against the baseline,
  /// queues the resulting actions for the plugin, and advances the baseline.
  pub fn handle_game_json_event(&self, payload: &Arc<RwLock<Payload>>) -> Result<()> {
    // Without a Studio-derived baseline, the existing document cannot safely
    // be interpreted as a set of removals. The first export merges it below.
    if !self.baseline_initialised.load(Ordering::Acquire) {
      return Ok(());
    }

    let target = GameTree::load(&self.game_json_path)?;
    let mut baseline = self.baseline.write().unwrap();
    let actions = diff_trees(&baseline, &target);
    if actions.is_empty() {
      return Ok(());
    }

    queue_actions(payload, actions);
    target.save_pretty(&self.snapshot_path)?;
    *baseline = target;

    Ok(())
  }

  /// Ingests a tree export from the Studio plugin, merging any pending
  /// game.json edits on top of it so Studio converges onto the edited
  /// document, then refreshes both game.json and the snapshot.
  ///
  /// Returns the number of pending actions queued for Studio.
  pub fn ingest_export(&self, export: &GameTree, payload: &Arc<RwLock<Payload>>) -> Result<usize> {
    let target = GameTree::load(&self.game_json_path).with_context(|| {
      format!(
        "Failed to read {} while merging a tree export",
        self.game_json_path.display()
      )
    })?;
    let mut baseline = self.baseline.write().unwrap();
    let initialised = self.baseline_initialised.load(Ordering::Acquire);

    // Pending edits made against the previous baseline.
    let mut pending = diff_trees(if initialised { &baseline } else { export }, &target);
    if !initialised {
      pending.retain(|action| !matches!(action, super::diff::TreeAction::Delete { .. }));
    }

    // The export becomes the new baseline, with pending edits layered on top.
    // Actions for paths absent from the export are tolerated as no-ops.
    let mut merged = export.clone();
    apply_actions(&mut merged.root, &pending)?;
    strip_managed_sources(&mut merged, &self.managed_paths);

    if !pending.is_empty() {
      queue_actions(payload, pending.clone());
    }

    merged.save_pretty(&self.game_json_path)?;
    merged.save_pretty(&self.snapshot_path)?;
    *baseline = merged;
    self.baseline_initialised.store(true, Ordering::Release);

    Ok(pending.len())
  }

  /// The top level service names defined by the project tree.
  pub fn project_services(&self) -> Vec<String> {
    self
      .project
      .tree
      .contents
      .as_ref()
      .map(|contents| contents.keys().cloned().collect())
      .unwrap_or_default()
  }
}

/// Queues actions into the sync payload, waiting for any in-progress delivery.
fn queue_actions(payload: &Arc<RwLock<Payload>>, actions: Vec<super::diff::TreeAction>) {
  payload.write().unwrap().extend_actions(actions);
}

/// Collects the instance paths covered by project `.path` mappings,
/// normalised to game tree addressing.
fn managed_paths(project: &VerdeProject) -> Vec<Vec<String>> {
  (&project.tree)
    .into_iter()
    .filter(|node| node.path.is_some())
    .filter_map(|node| node.roblox_path.clone())
    .map(super::normalise_path)
    .collect()
}

/// Removes the Source property from nodes covered by project `.path` mappings.
fn strip_managed_sources(tree: &mut GameTree, managed: &[Vec<String>]) {
  if managed.is_empty() {
    return;
  }

  strip_node(&mut tree.root, &[], managed);
}

/// Strips the Source property from a single node and its descendants.
fn strip_node(node: &mut GameNode, path: &[String], managed: &[Vec<String>]) {
  if is_managed(path, managed) {
    node.properties.remove("Source");
  }

  for (name, child) in &mut node.children {
    let mut child_path = path.to_vec();
    child_path.push(name.clone());
    strip_node(child, &child_path, managed);
  }
}

/// Determines if an instance path is covered by a managed path.
fn is_managed(path: &[String], managed: &[Vec<String>]) -> bool {
  managed
    .iter()
    .any(|managed_path| path.len() >= managed_path.len() && path[..managed_path.len()] == managed_path[..])
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::core::tree::diff::TreeAction;
  use std::path::Path;

  /// Creates a default project rooted in a tempdir.
  fn project_in(directory: &Path) -> Arc<VerdeProject> {
    let mut project = VerdeProject {
      root: Some(directory.to_path_buf()),
      ..Default::default()
    };
    project.tree.precalculate();
    Arc::new(project)
  }

  #[test]
  fn initialise_creates_skeleton_documents() {
    let directory = tempfile::tempdir().unwrap();
    let state = TreeState::initialise(&project_in(directory.path())).unwrap();

    let document = GameTree::load(&state.game_json_path).unwrap();
    assert!(document.root.children.contains_key("ServerScriptService"));
    assert!(document.root.children.contains_key("ReplicatedStorage"));
    assert_eq!(GameTree::load(&state.snapshot_path).unwrap(), document);
  }

  #[test]
  fn initialise_resumes_from_the_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let project = project_in(directory.path());
    TreeState::initialise(&project).unwrap();

    // A deleted game.json is rewritten from the persisted snapshot.
    let state = TreeState::initialise(&project).unwrap();
    std::fs::remove_file(&state.game_json_path).unwrap();
    TreeState::initialise(&project).unwrap();
    assert!(state.game_json_path.is_file());
  }

  #[test]
  fn game_json_edits_queue_actions_and_advance_the_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let state = TreeState::initialise(&project_in(directory.path())).unwrap();
    let payload = Arc::new(RwLock::new(Payload::default()));

    // Add a Workspace service to the document.
    let mut document = GameTree::load(&state.game_json_path).unwrap();
    document.root.children.insert(
      String::from("Workspace"),
      GameNode {
        class_name: Some(String::from("Workspace")),
        children: [(
          String::from("Baseplate"),
          GameNode {
            class_name: Some(String::from("Part")),
            ..Default::default()
          },
        )]
        .into(),
        ..Default::default()
      },
    );
    document.save_pretty(&state.game_json_path).unwrap();

    state.handle_game_json_event(&payload).unwrap();

    let events = payload.read().unwrap().events.clone();
    assert_eq!(events.len(), 2);
    assert!(matches!(&events[0], TreeAction::Create { path, .. } if path == &vec![String::from("Workspace")]));
    assert!(matches!(
      &events[1],
      TreeAction::Create { path, .. } if path == &vec![String::from("Workspace"), String::from("Baseplate")]
    ));

    // Reprocessing the same content queues nothing more.
    state.handle_game_json_event(&payload).unwrap();
    assert_eq!(payload.read().unwrap().events.len(), 2);

    // The snapshot advanced to the new baseline.
    assert!(GameTree::load(&state.snapshot_path)
      .unwrap()
      .root
      .children
      .contains_key("Workspace"));
  }

  #[test]
  fn invalid_game_json_leaves_the_baseline_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let state = TreeState::initialise(&project_in(directory.path())).unwrap();
    let payload = Arc::new(RwLock::new(Payload::default()));

    std::fs::write(&state.game_json_path, "not json").unwrap();
    assert!(state.handle_game_json_event(&payload).is_err());
    assert!(payload.read().unwrap().events.is_empty());
    assert!(!GameTree::load(&state.snapshot_path)
      .unwrap()
      .root
      .children
      .contains_key("Workspace"));
  }

  #[test]
  fn existing_document_without_snapshot_waits_for_export_and_suppresses_deletes() {
    let directory = tempfile::tempdir().unwrap();
    let game_json_path = directory.path().join(GAME_FILE);
    let target: GameTree = serde_json::from_str(
      r#"{"formatVersion":1,"className":"DataModel","children":{"Workspace":{"children":{"Wanted":{}}}}}"#,
    )
    .unwrap();
    target.save_pretty(&game_json_path).unwrap();

    let state = TreeState::initialise(&project_in(directory.path())).unwrap();
    let payload = Arc::new(RwLock::new(Payload::default()));
    assert!(!state.baseline_initialised.load(Ordering::Acquire));
    assert!(!state.snapshot_path.exists());

    state.handle_game_json_event(&payload).unwrap();
    assert!(payload.read().unwrap().events.is_empty());
    assert!(!state.snapshot_path.exists());

    let export: GameTree = serde_json::from_str(
      r#"{"formatVersion":1,"className":"DataModel","children":{"Workspace":{"children":{"Existing":{}}}}}"#,
    )
    .unwrap();
    state.ingest_export(&export, &payload).unwrap();

    let events = payload.read().unwrap().events.clone();
    assert_eq!(events.len(), 1);
    assert!(matches!(
      &events[0],
      TreeAction::Create { path, .. }
        if path == &vec![String::from("Workspace"), String::from("Wanted")]
    ));
    let merged = GameTree::load(&game_json_path).unwrap();
    let workspace = merged.root.children.get("Workspace").unwrap();
    assert!(workspace.children.contains_key("Existing"));
    assert!(workspace.children.contains_key("Wanted"));
    assert!(state.baseline_initialised.load(Ordering::Acquire));

    // Once the export establishes the baseline, normal deletes resume.
    let mut document = merged;
    document
      .root
      .children
      .get_mut("Workspace")
      .unwrap()
      .children
      .remove("Existing");
    document.save_pretty(&game_json_path).unwrap();
    state.handle_game_json_event(&payload).unwrap();
    assert!(payload.read().unwrap().events.iter().any(|action| matches!(
      action,
      TreeAction::Delete { path }
        if path == &vec![String::from("Workspace"), String::from("Existing")]
    )));
  }

  #[test]
  fn ingest_merges_pending_edits_into_the_export() {
    let directory = tempfile::tempdir().unwrap();
    let state = TreeState::initialise(&project_in(directory.path())).unwrap();
    let payload = Arc::new(RwLock::new(Payload::default()));

    // The AI adds a Workspace while the plugin exports a tree without one.
    let mut document = GameTree::load(&state.game_json_path).unwrap();
    document
      .root
      .children
      .insert(String::from("Workspace"), GameNode::default());
    document.save_pretty(&state.game_json_path).unwrap();

    let export: GameTree =
      serde_json::from_str(r#"{"formatVersion":1,"className":"DataModel","children":{"Lighting":{}}}"#).unwrap();

    let pending = state.ingest_export(&export, &payload).unwrap();
    assert_eq!(pending, 1);
    assert_eq!(payload.read().unwrap().events.len(), 1);

    // The refreshed document carries the export plus the pending edit.
    let merged = GameTree::load(&state.game_json_path).unwrap();
    assert!(merged.root.children.contains_key("Lighting"));
    assert!(merged.root.children.contains_key("Workspace"));
    assert_eq!(GameTree::load(&state.snapshot_path).unwrap(), merged);
  }

  #[test]
  fn ingest_strips_managed_script_sources() {
    let directory = tempfile::tempdir().unwrap();
    let state = TreeState::initialise(&project_in(directory.path())).unwrap();
    let payload = Arc::new(RwLock::new(Payload::default()));

    // ServerScriptService is covered by the default project's src/server mapping.
    let export: GameTree = serde_json::from_str(
      r#"{
        "formatVersion": 1,
        "className": "DataModel",
        "children": {
          "ServerScriptService": {
            "children": {
              "Main": {
                "className": "Script",
                "properties": { "Source": "print('managed')", "Disabled": false }
              }
            }
          },
          "StarterGui": {
            "children": {
              "Label": {
                "className": "Script",
                "properties": { "Source": "print('unmanaged')" }
              }
            }
          }
        }
      }"#,
    )
    .unwrap();

    state.ingest_export(&export, &payload).unwrap();

    let merged = GameTree::load(&state.game_json_path).unwrap();
    let managed = merged
      .root
      .children
      .get("ServerScriptService")
      .unwrap()
      .children
      .get("Main")
      .unwrap();
    assert!(!managed.properties.contains_key("Source"));
    assert!(managed.properties.contains_key("Disabled"));

    let unmanaged = merged
      .root
      .children
      .get("StarterGui")
      .unwrap()
      .children
      .get("Label")
      .unwrap();
    assert!(unmanaged.properties.contains_key("Source"));
  }
}
