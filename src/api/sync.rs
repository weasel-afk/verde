// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pub mod filters {
  use super::handlers;
  use crate::api::ApiState;
  use std::{convert::Infallible, sync::Arc};
  use warp::{path, Filter};

  /// Entry point for the sync api.
  pub fn sync(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    sync_heartbeat(state)
  }

  /// Api for requesting heartbeat status of the sync session.
  pub fn sync_heartbeat(
    state: Arc<ApiState>,
  ) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    path!("heartbeat")
      .and(warp::get())
      .and(with_state(state))
      .and_then(handlers::sync_heartbeat)
  }

  /// Helper for warp.
  fn with_state(state: Arc<ApiState>) -> impl Filter<Extract = (Arc<ApiState>,), Error = Infallible> + Clone {
    warp::any().map(move || Arc::clone(&state))
  }
}

mod handlers {
  use crate::api::ApiState;
  use std::{convert::Infallible, sync::Arc};

  pub async fn sync_heartbeat(state: Arc<ApiState>) -> Result<impl warp::Reply, Infallible> {
    let r = state.payload.read().unwrap().clone();
    if let Ok(mut w) = state.payload.try_write() {
      w.clear();
    }

    Ok(warp::reply::json(&r))
  }
}
