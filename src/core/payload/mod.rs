// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
pub mod transform;

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// An action to apply to the Roblox instance tree.
/// Re-export of the tree action used on the sync wire.
pub use crate::core::tree::diff::TreeAction as PayloadAction;

/// Payload for a response.
#[derive(Clone, Default, Serialize)]
pub struct Payload {
  /// The ordered instance actions to apply.
  /// Order is significant: creates must be applied parents before children.
  pub events: Vec<PayloadAction>,

  /// The last time the payload was edited.
  last_update: Option<u64>,

  /// The last time the payload was delivered.
  last_read: Option<u64>,

  /// The absolute cursor of the first queued event.
  #[serde(skip)]
  acknowledged_cursor: u64,

  /// The furthest cursor returned by a heartbeat response.
  #[serde(skip)]
  delivered_cursor: u64,
}

impl Payload {
  /// Clones the currently queued actions for delivery and returns the cursor
  /// through which they can be acknowledged.
  pub fn deliver(&mut self) -> (Self, u64) {
    self.delivered_cursor = self.acknowledged_cursor + self.events.len() as u64;
    self.last_read = Some(current_millis());
    (self.clone(), self.delivered_cursor)
  }

  /// Removes actions through a cursor that has previously been delivered.
  /// Returns false for cursors outside the delivered range.
  pub fn acknowledge(&mut self, cursor: u64) -> bool {
    if cursor < self.acknowledged_cursor || cursor > self.delivered_cursor {
      return false;
    }

    let acknowledged = (cursor - self.acknowledged_cursor) as usize;
    self.events.drain(..acknowledged);
    self.acknowledged_cursor = cursor;
    true
  }

  /// Adds a new Roblox instance action.
  pub fn add_payload(&mut self, payload: PayloadAction) {
    self.events.push(payload);
    self.last_update = Some(current_millis());
  }

  /// Adds multiple instance actions, preserving their order.
  pub fn extend_actions(&mut self, actions: Vec<PayloadAction>) {
    if actions.is_empty() {
      return;
    }

    self.events.extend(actions);
    self.last_update = Some(current_millis());
  }
}

/// The current unix time in milliseconds.
fn current_millis() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::core::tree::value::{Complex, PropertyValue};

  #[test]
  fn actions_serialise_to_the_wire_format() {
    let mut payload = Payload::default();
    payload.add_payload(PayloadAction::Create {
      path: vec![String::from("Workspace"), String::from("Baseplate")],
      class_name: Some(String::from("Part")),
      properties: [(
        String::from("Size"),
        PropertyValue::Complex(Complex::Vector3 {
          x: 512.0,
          y: 20.0,
          z: 512.0,
        }),
      )]
      .into(),
    });
    payload.add_payload(PayloadAction::Change {
      path: vec![String::from("ServerScriptService"), String::from("Main")],
      value: Some(String::from("print('hi')")),
    });
    payload.add_payload(PayloadAction::Delete {
      path: vec![String::from("Workspace"), String::from("Old")],
    });

    // Timestamps are nondeterministic; zero them for the golden comparison.
    payload.last_update = None;
    payload.last_read = None;

    assert_eq!(
      serde_json::to_string(&payload).unwrap(),
      concat!(
        r#"{"events":[{"action":"create","path":["Workspace","Baseplate"],"className":"Part","#,
        r#""properties":{"Size":{"type":"Vector3","x":512.0,"y":20.0,"z":512.0}}},"#,
        r#"{"action":"change","path":["ServerScriptService","Main"],"value":"print('hi')"},"#,
        r#"{"action":"delete","path":["Workspace","Old"]}],"last_update":null,"last_read":null}"#
      )
    );
  }

  #[test]
  fn extend_actions_preserves_order() {
    let mut payload = Payload::default();
    payload.extend_actions(vec![
      PayloadAction::Delete {
        path: vec![String::from("A")],
      },
      PayloadAction::Delete {
        path: vec![String::from("B")],
      },
    ]);
    payload.extend_actions(Vec::new());

    assert_eq!(payload.events.len(), 2);
    assert_eq!(
      payload.events[0],
      PayloadAction::Delete {
        path: vec![String::from("A")]
      }
    );
  }

  #[test]
  fn acknowledgement_only_removes_delivered_actions() {
    let mut payload = Payload::default();
    payload.extend_actions(vec![PayloadAction::Delete {
      path: vec![String::from("A")],
    }]);

    let (_, cursor) = payload.deliver();
    payload.extend_actions(vec![PayloadAction::Delete {
      path: vec![String::from("B")],
    }]);

    assert!(payload.acknowledge(cursor));
    assert_eq!(payload.events.len(), 1);
    assert_eq!(
      payload.events[0],
      PayloadAction::Delete {
        path: vec![String::from("B")]
      }
    );
  }

  #[test]
  fn acknowledgement_rejects_an_undelivered_cursor() {
    let mut payload = Payload::default();
    payload.extend_actions(vec![PayloadAction::Delete {
      path: vec![String::from("A")],
    }]);

    assert!(!payload.acknowledge(1));
    assert_eq!(payload.events.len(), 1);
  }
}
