// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use crate::core::payload::PayloadAction;
use crate::core::project::VerdeProject;
use anyhow::bail;
use notify::EventKind;
use std::{fs, path::Path, sync::Arc};

/// Transforms a file event into a payload action.
pub fn transform_file(
  file_path: &Path,
  kind: &EventKind,
  project: &Arc<VerdeProject>,
) -> anyhow::Result<PayloadAction> {
  // Create the script change
  let (path, value) = transform_script(file_path, project)?;

  // Wrap the change in an action based on file event.
  let action = match kind {
    notify::EventKind::Remove(_) => PayloadAction::Delete { path },
    _ => PayloadAction::Change { path, value },
  };

  Ok(action)
}

/// Transform a file into a Roblox script change.
fn transform_script(file_path: &Path, project: &Arc<VerdeProject>) -> anyhow::Result<(Vec<String>, Option<String>)> {
  // Get file path
  let root = project.root.as_ref().unwrap().canonicalize()?;
  let mut stripped_path = file_path.strip_prefix(root)?;

  // Find associated node
  let Some(current_node) = project.find_node(stripped_path) else {
    bail!("Unable to find associated node with path {:?}", stripped_path);
  };

  // Get file contents
  let contents = fs::read_to_string(file_path)?;

  // Create path from node
  let Some(mut roblox_path) = current_node.roblox_path else {
    bail!("Unable to find associated instance path for node.");
  };

  if let Some(node_path) = current_node.path {
    stripped_path = stripped_path.strip_prefix(node_path)?;
  }
  if let Some(path) = stripped_path.to_str() {
    roblox_path.push(path.to_string());
  }

  Ok((crate::core::tree::normalise_path(roblox_path), Some(contents)))
}
