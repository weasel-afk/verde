// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
mod sync;
mod tree;

use crate::core::{payload::Payload, project::VerdeProject, tree::TreeState};
use std::sync::{Arc, RwLock};
use warp::Filter;

/// Shared state handed to the api route filters.
pub struct ApiState {
  /// The sync payload queueing actions for the plugin.
  pub payload: Arc<RwLock<Payload>>,

  /// The game tree state.
  pub tree: Arc<TreeState>,

  /// The project tied to the session.
  pub project: Arc<VerdeProject>,
}

pub fn get_routes(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
  sync::filters::sync(Arc::clone(&state)).or(tree::filters::tree(state))
}
