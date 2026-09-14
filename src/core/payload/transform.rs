// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use crate::core::payload::PayloadAction;
use crate::core::project::VerdeProject;
use anyhow::bail;
use notify::EventKind;
use std::{fs, path::Path, sync::Arc};

/// Transforms a file event into a payload action.
/// Returns None for files not mapped by the project (e.g. logs or state
/// files in the project root).
pub fn transform_file(
  file_path: &Path,
  kind: &EventKind,
  project: &Arc<VerdeProject>,
) -> anyhow::Result<Option<PayloadAction>> {
  // Resolve the instance path for the file.
  let Some(path) = transform_script_path(file_path, project)? else {
    return Ok(None);
  };

  // Wrap the change in an action based on file event. Removed files are
  // not read; their contents are gone by definition.
  let action = match kind {
    notify::EventKind::Remove(_) => PayloadAction::Delete { path },
    _ => PayloadAction::Change {
      path,
      value: Some(fs::read_to_string(file_path)?),
    },
  };

  Ok(Some(action))
}

/// Resolves the Roblox instance path for a file. Returns None when no
/// project node maps the file.
fn transform_script_path(file_path: &Path, project: &Arc<VerdeProject>) -> anyhow::Result<Option<Vec<String>>> {
  // Get file path
  let root = project.root.as_ref().unwrap().canonicalize()?;
  let mut stripped_path = file_path.strip_prefix(root)?;

  // Find associated node
  let Some(current_node) = project.find_node(stripped_path) else {
    return Ok(None);
  };

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

  Ok(Some(crate::core::tree::normalise_path(roblox_path)))
}
