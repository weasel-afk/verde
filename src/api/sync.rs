// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pub mod filters {
  use super::handlers;
  use crate::api::ApiState;
  use std::{convert::Infallible, sync::Arc};
  use warp::{body, path, Filter};

  /// Entry point for the sync api.
  pub fn sync(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    sync_heartbeat(Arc::clone(&state)).or(sync_acknowledge(state))
  }

  /// Api for acknowledging actions returned by a heartbeat.
  pub fn sync_acknowledge(
    state: Arc<ApiState>,
  ) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    path!("heartbeat")
      .and(warp::post())
      .and(body::content_length_limit(1024))
      .and(body::json())
      .and(with_state(state))
      .and_then(handlers::sync_acknowledge)
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
  use crate::core::payload::Payload;
  use serde::{Deserialize, Serialize};
  use std::{convert::Infallible, sync::Arc};
  use warp::{http::StatusCode, reply::with_status};

  #[derive(Serialize)]
  struct HeartbeatResponse {
    #[serde(flatten)]
    payload: Payload,
    cursor: u64,
  }

  #[derive(Deserialize)]
  pub struct AcknowledgeRequest {
    cursor: u64,
  }

  #[derive(Serialize)]
  struct AcknowledgeResponse {
    status: &'static str,
  }

  pub async fn sync_heartbeat(state: Arc<ApiState>) -> Result<impl warp::Reply, Infallible> {
    let (payload, cursor) = state.payload.write().unwrap().deliver();

    Ok(warp::reply::json(&HeartbeatResponse { payload, cursor }))
  }

  pub async fn sync_acknowledge(
    request: AcknowledgeRequest,
    state: Arc<ApiState>,
  ) -> Result<impl warp::Reply, Infallible> {
    let acknowledged = state.payload.write().unwrap().acknowledge(request.cursor);
    let status = if acknowledged { "ok" } else { "error" };
    let status_code = if acknowledged {
      StatusCode::OK
    } else {
      StatusCode::BAD_REQUEST
    };

    Ok(with_status(
      warp::reply::json(&AcknowledgeResponse { status }),
      status_code,
    ))
  }
}
