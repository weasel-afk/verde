// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
pub mod value;

pub use value::{Complex, Primitive, PropertyValue};

use crate::core::project::node::Node;
use crate::core::project::VerdeProject;
use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

/// The game tree format version read and written by Verde.
pub const FORMAT_VERSION: u32 = 1;

/// The default file name of the game tree document.
pub const GAME_FILE: &str = "game.json";

/// The game tree document (game.json) describing every instance in the game.
///
/// ```json
/// {
///   "formatVersion": 1,
///   "className": "DataModel",
///   "children": {
///     "Workspace": {
///       "className": "Workspace",
///       "children": {
///         "Baseplate": {
///           "className": "Part",
///           "properties": {
///             "Anchored": true,
///             "Size": { "type": "Vector3", "x": 512, "y": 20, "z": 512 }
///           }
///         }
///       }
///     }
///   }
/// }
/// ```
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct GameTree {
  /// The format version of the document.
  #[serde(rename = "formatVersion")]
  pub format_version: u32,

  /// The root node of the tree (the DataModel).
  #[serde(flatten)]
  pub root: GameNode,
}

/// A node within the game tree describing a single Roblox instance.
///
/// Children are keyed by name, meaning duplicate sibling names cannot be
/// represented. The class name falls back to the node key when absent.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameNode {
  /// The class name of the instance.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub class_name: Option<String>,

  /// The properties of the instance.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub properties: BTreeMap<String, PropertyValue>,

  /// The children of the instance, keyed by name.
  #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
  pub children: BTreeMap<String, GameNode>,
}

impl GameNode {
  /// The class name of the instance, falling back to its key name.
  pub fn effective_class<'a>(&'a self, name: &'a str) -> &'a str {
    self.class_name.as_deref().unwrap_or(name)
  }
}

impl GameTree {
  /// Loads a game tree document from the file system, validating its format version.
  pub fn load(path: &Path) -> anyhow::Result<Self> {
    let buffer = fs::read_to_string(path).with_context(|| format!("Failed to read game tree {}", path.display()))?;
    let tree: Self =
      serde_json::from_str(&buffer).with_context(|| format!("Failed to deserialise game tree {}", path.display()))?;

    if tree.format_version != FORMAT_VERSION {
      bail!(
        "Unsupported game tree format version {} (expected {})",
        tree.format_version,
        FORMAT_VERSION
      );
    }

    Ok(tree)
  }

  /// Writes the document pretty-printed to the file system.
  /// The write is performed atomically (temporary file + rename) so watchers
  /// never observe a partially written document.
  pub fn save_pretty(&self, path: &Path) -> anyhow::Result<()> {
    let mut contents = serde_json::to_string_pretty(self).context("Failed to serialise game tree")?;
    contents.push('\n');

    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).with_context(|| format!("Failed to create {}", parent.display()))?;
    }

    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents).with_context(|| format!("Failed to write {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| format!("Failed to rename {}", path.display()))?;

    Ok(())
  }
}

/// Builds a skeleton game tree from a Verde project's static tree mapping.
/// File system directories mapped via `.path` are not scanned; their scripts
/// remain owned by the file sync pipeline.
pub fn skeleton_from_project(project: &VerdeProject) -> GameTree {
  GameTree {
    format_version: FORMAT_VERSION,
    root: node_from_project(&project.tree, None),
  }
}

/// Converts a project node into a game node, using the key name as fallback class.
fn node_from_project(node: &Node, name: Option<&str>) -> GameNode {
  let mut children = BTreeMap::new();
  if let Some(contents) = &node.contents {
    for (child_name, child) in contents {
      children.insert(child_name.clone(), node_from_project(child, Some(child_name)));
    }
  }

  GameNode {
    class_name: node.class_name.clone().filter(|class| name != Some(class.as_str())),
    properties: BTreeMap::new(),
    children,
  }
}
