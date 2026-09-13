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

  /// The last time the payload was read + cleared.
  last_read: Option<u64>,
}

impl Payload {
  /// Clears all the values in the payload.
  pub fn clear(&mut self) {
    self.events.clear();
    self.last_read = Some(current_millis());
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
  SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0)
}
