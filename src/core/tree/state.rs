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
  sync::{Arc, RwLock},
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
    let mut baseline = self.baseline.write().unwrap();

    // Pending edits made against the previous baseline.
    let pending = match GameTree::load(&self.game_json_path) {
      Ok(target) => diff_trees(&baseline, &target),
      Err(error) => {
        eprintln!("Failed to read game.json while merging a tree export: {error:#}");
        Vec::new()
      }
    };

    // The export becomes the new baseline, with pending edits layered on top.
    // Actions for paths absent from the export are tolerated as no-ops.
    let mut merged = export.clone();
    strip_managed_sources(&mut merged, &self.managed_paths);
    apply_actions(&mut merged.root, &pending)?;

    if !pending.is_empty() {
      queue_actions(payload, pending.clone());
    }

    merged.save_pretty(&self.game_json_path)?;
    merged.save_pretty(&self.snapshot_path)?;
    *baseline = merged;

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

/// Queues actions into the sync payload, logging when the payload is locked.
fn queue_actions(payload: &Arc<RwLock<Payload>>, actions: Vec<super::diff::TreeAction>) {
  if let Ok(mut events) = payload.try_write() {
    events.extend_actions(actions);
  } else {
    eprintln!("Failed to queue game tree actions; the payload is locked.");
  }
}

/// Collects the instance paths covered by project `.path` mappings.
fn managed_paths(project: &VerdeProject) -> Vec<Vec<String>> {
  (&project.tree)
    .into_iter()
    .filter(|node| node.path.is_some())
    .filter_map(|node| node.roblox_path.clone())
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
  managed.iter().any(|managed_path| {
    path.len() >= managed_path.len() && path[..managed_path.len()] == managed_path[..]
  })
}
