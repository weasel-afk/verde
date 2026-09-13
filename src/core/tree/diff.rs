// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use super::{GameNode, GameTree, PropertyValue};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// An action to apply to the Roblox instance tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum TreeAction {
  /// Creates an instance. Create actions are always ordered parents before children.
  #[serde(rename_all = "camelCase")]
  Create {
    /// The Roblox instance path.
    path: Vec<String>,

    /// The class name of the instance, falling back to the path name.
    #[serde(skip_serializing_if = "Option::is_none")]
    class_name: Option<String>,

    /// The properties to set on the instance.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    properties: BTreeMap<String, PropertyValue>,
  },

  /// Sets the source of an existing script. Emitted by the file sync pipeline.
  #[serde(rename_all = "camelCase")]
  Change {
    /// The Roblox instance path.
    path: Vec<String>,

    /// The script source contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
  },

  /// Updates the properties of an existing instance. The full property map is
  /// sent (not a delta), making re-delivery idempotent.
  #[serde(rename_all = "camelCase")]
  Update {
    /// The Roblox instance path.
    path: Vec<String>,

    /// The properties to set on the instance.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    properties: BTreeMap<String, PropertyValue>,
  },

  /// Deletes an instance and its descendants. Only the shallowest removed
  /// node produces a delete as destroying an instance is recursive.
  Delete {
    /// The Roblox instance path.
    path: Vec<String>,
  },
}

/// Diffs a baseline tree against a target tree, producing the ordered actions
/// required to converge the baseline onto the target.
///
/// Ordering guarantees: creates are emitted parents before children, and a
/// class change emits its delete before its create.
pub fn diff_trees(baseline: &GameTree, target: &GameTree) -> Vec<TreeAction> {
  let mut actions = Vec::new();
  diff_node(&[], &baseline.root, &target.root, &mut actions);
  actions
}

/// Diffs a single node pair, emitting actions into the provided vector.
fn diff_node(path: &[String], baseline: &GameNode, target: &GameNode, actions: &mut Vec<TreeAction>) {
  // The DataModel root is never property-diffed.
  if !path.is_empty() && baseline.properties != target.properties && !target.properties.is_empty() {
    actions.push(TreeAction::Update {
      path: path.to_vec(),
      properties: target.properties.clone(),
    });
  }

  // Union of child names, iterated in sorted order for determinism.
  let names: BTreeSet<&String> = baseline.children.keys().chain(target.children.keys()).collect();
  for name in names {
    let mut child_path = path.to_vec();
    child_path.push(name.clone());

    match (baseline.children.get(name), target.children.get(name)) {
      (Some(child), Some(target_child)) => {
        if child.effective_class(name) != target_child.effective_class(name) {
          // A class change replaces the instance: delete first so the create
          // cannot collide with the stale instance of the same name.
          emit_delete(&child_path, actions);
          emit_create(&child_path, target_child, actions);
          emit_creates(&child_path, target_child, actions);
        } else {
          diff_node(&child_path, child, target_child, actions);
        }
      }
      (None, Some(target_child)) => {
        emit_create(&child_path, target_child, actions);
        emit_creates(&child_path, target_child, actions);
      }
      (Some(_), None) => emit_delete(&child_path, actions),
      (None, None) => unreachable!("union iteration only yields present names"),
    }
  }
}

/// Emits the create action for a single node.
fn emit_create(path: &[String], node: &GameNode, actions: &mut Vec<TreeAction>) {
  actions.push(TreeAction::Create {
    path: path.to_vec(),
    class_name: node.class_name.clone(),
    properties: node.properties.clone(),
  });
}

/// Emits create actions for an entire subtree, parents before children.
fn emit_creates(path: &[String], node: &GameNode, actions: &mut Vec<TreeAction>) {
  for (name, child) in &node.children {
    let mut child_path = path.to_vec();
    child_path.push(name.clone());

    emit_create(&child_path, child, actions);
    emit_creates(&child_path, child, actions);
  }
}

/// Emits a delete action for a path. Top level services are not destroyable.
fn emit_delete(path: &[String], actions: &mut Vec<TreeAction>) {
  if path.len() <= 1 {
    eprintln!(
      "Ignoring delete of top level service {}",
      path.first().cloned().unwrap_or_default()
    );
    return;
  }

  actions.push(TreeAction::Delete { path: path.to_vec() });
}

/// Applies actions to a game tree in memory. Used to merge tree exports with
/// pending game.json edits, and as a test oracle for the diff engine.
///
/// Actions referencing unknown paths are tolerated as no-ops so that deletes
/// of instances also removed manually in Studio do not fail the merge.
pub fn apply_actions(root: &mut GameNode, actions: &[TreeAction]) -> anyhow::Result<()> {
  for action in actions {
    match action {
      TreeAction::Create {
        path,
        class_name,
        properties,
      } => {
        let Some((name, parent_path)) = path.split_last() else {
          continue; // the DataModel root cannot be created
        };
        if let Some(parent) = resolve_mut(parent_path, root) {
          parent.children.insert(
            name.clone(),
            GameNode {
              class_name: class_name.clone(),
              properties: properties.clone(),
              children: BTreeMap::new(),
            },
          );
        }
      }
      TreeAction::Change { .. } => {} // script source is not part of the game tree document
      TreeAction::Update { path, properties } => {
        if let Some((name, parent_path)) = path.split_last() {
          if let Some(parent) = resolve_mut(parent_path, root) {
            if let Some(child) = parent.children.get_mut(name) {
              child.properties = properties.clone();
            }
          }
        }
      }
      TreeAction::Delete { path } => {
        if let Some((name, parent_path)) = path.split_last() {
          if let Some(parent) = resolve_mut(parent_path, root) {
            parent.children.remove(name);
          }
        }
      }
    }
  }

  Ok(())
}

/// Resolves a mutable node reference by walking child names from the root.
fn resolve_mut<'a>(path: &[String], root: &'a mut GameNode) -> Option<&'a mut GameNode> {
  let mut current = root;
  for segment in path {
    current = current.children.get_mut(segment)?;
  }

  Some(current)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Builds a game tree from a children JSON fragment.
  fn tree(children: &str) -> GameTree {
    serde_json::from_str(&format!(
      r#"{{"formatVersion":1,"className":"DataModel","children":{children}}}"#
    ))
    .unwrap()
  }

  /// Diffs two children JSON fragments.
  fn diff(baseline: &str, target: &str) -> Vec<TreeAction> {
    diff_trees(&tree(baseline), &tree(target))
  }

  #[test]
  fn no_change_produces_no_actions() {
    let children = r#"{"Workspace":{"children":{"Baseplate":{"className":"Part","properties":{"Anchored":true}}}}}"#;
    assert!(diff(children, children).is_empty());
  }

  #[test]
  fn property_change_emits_update_with_full_map() {
    let actions = diff(
      r#"{"Lighting":{"properties":{"Brightness":2}}}"#,
      r#"{"Lighting":{"properties":{"Brightness":3,"ShadowSoftness":0.5}}}"#,
    );

    assert_eq!(actions.len(), 1);
    match &actions[0] {
      TreeAction::Update { path, properties } => {
        assert_eq!(path, &vec![String::from("Lighting")]);
        // The full target map is sent, not a delta.
        assert_eq!(properties.len(), 2);
        assert!(properties.contains_key("Brightness"));
        assert!(properties.contains_key("ShadowSoftness"));
      }
      action => panic!("expected update, got {action:?}"),
    }
  }

  #[test]
  fn removed_property_leaves_instance_unmanaged() {
    // Removing a key cannot unset it in v1, so no action is emitted.
    let actions = diff(r#"{"Lighting":{"properties":{"Brightness":2}}}"#, r#"{"Lighting":{}}"#);
    assert!(actions.is_empty());
  }

  #[test]
  fn added_subtree_creates_parents_before_children() {
    let actions = diff(
      r#"{"Workspace":{}}"#,
      r#"{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{"className":"Part","properties":{"Anchored":true}}}}}}}"#,
    );

    assert_eq!(actions.len(), 2);
    let folder_index = actions.iter().position(|action| match action {
      TreeAction::Create { path, .. } => path == &vec![String::from("Workspace"), String::from("Folder")],
      _ => false,
    });
    let part_index = actions.iter().position(|action| match action {
      TreeAction::Create { path, .. } => {
        path == &vec![String::from("Workspace"), String::from("Folder"), String::from("Part")]
      }
      _ => false,
    });

    assert!(folder_index.unwrap() < part_index.unwrap());
    if let TreeAction::Create {
      class_name, properties, ..
    } = &actions[part_index.unwrap()]
    {
      assert_eq!(class_name.as_deref(), Some("Part"));
      assert!(properties.contains_key("Anchored"));
    }
  }

  #[test]
  fn removed_subtree_deletes_shallowest_node_only() {
    let actions = diff(
      r#"{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{"className":"Part"}}}}}}"#,
      r#"{"Workspace":{}}"#,
    );

    assert_eq!(
      actions,
      vec![TreeAction::Delete {
        path: vec![String::from("Workspace"), String::from("Folder")],
      }]
    );
  }

  #[test]
  fn top_level_service_deletes_are_suppressed() {
    let actions = diff(r#"{"Workspace":{},"Lighting":{}}"#, r#"{"Workspace":{}}"#);
    assert!(actions.is_empty());
  }

  #[test]
  fn rename_is_delete_and_create() {
    let actions = diff(
      r#"{"Workspace":{"children":{"Old":{"className":"Part"}}}}"#,
      r#"{"Workspace":{"children":{"New":{"className":"Part"}}}}"#,
    );

    // Independent paths, so create/delete order between them is irrelevant.
    assert!(actions.contains(&TreeAction::Delete {
      path: vec![String::from("Workspace"), String::from("Old")],
    }));
    assert!(actions.iter().any(|action| match action {
      TreeAction::Create { path, .. } => path == &vec![String::from("Workspace"), String::from("New")],
      _ => false,
    }));
  }

  #[test]
  fn class_change_deletes_before_create() {
    let actions = diff(
      r#"{"Workspace":{"children":{"Thing":{"className":"Part","properties":{"Anchored":true}}}}}"#,
      r#"{"Workspace":{"children":{"Thing":{"className":"Folder"}}}}"#,
    );

    assert_eq!(actions.len(), 2);
    assert!(matches!(actions[0], TreeAction::Delete { .. }));
    assert!(matches!(actions[1], TreeAction::Create { .. }));
  }

  #[test]
  fn apply_diff_converges_baseline_onto_target() {
    let cases = [
      // Property changes
      (
        r#"{"Lighting":{"properties":{"Brightness":2}}}"#,
        r#"{"Lighting":{"properties":{"Brightness":3,"ShadowSoftness":0.5}}}"#,
      ),
      // Added subtrees
      (
        r#"{"Workspace":{}}"#,
        r#"{"Workspace":{"children":{"Folder":{"className":"Folder","children":{"Part":{}}}}}}"#,
      ),
      // Removed subtrees
      (
        r#"{"Workspace":{"children":{"Folder":{"children":{"Part":{}}}}}}"#,
        r#"{"Workspace":{}}"#,
      ),
      // Renames
      (
        r#"{"Workspace":{"children":{"Old":{"className":"Part"}}}}"#,
        r#"{"Workspace":{"children":{"New":{}}}}"#,
      ),
      // Class changes
      (
        r#"{"Workspace":{"children":{"Thing":{"className":"Part","properties":{"Anchored":true}}}}}"#,
        r#"{"Workspace":{"children":{"Thing":{"className":"Folder","children":{"Inner":{}}}}}}"#,
      ),
    ];

    for (baseline, target) in cases {
      let (baseline_tree, target_tree) = (tree(baseline), tree(target));
      let mut result = baseline_tree.clone();
      apply_actions(&mut result.root, &diff_trees(&baseline_tree, &target_tree)).unwrap();
      assert_eq!(
        result, target_tree,
        "baseline {baseline} did not converge onto {target}"
      );
    }
  }

  #[test]
  fn apply_tolerates_unknown_paths() {
    let mut game_tree = tree(r#"{"Workspace":{}}"#);
    apply_actions(
      &mut game_tree.root,
      &[
        TreeAction::Delete {
          path: vec![String::from("Workspace"), String::from("Missing")],
        },
        TreeAction::Update {
          path: vec![String::from("Nowhere"), String::from("Missing")],
          properties: BTreeMap::new(),
        },
      ],
    )
    .unwrap();

    assert_eq!(game_tree, tree(r#"{"Workspace":{}}"#));
  }
}
