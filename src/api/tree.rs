// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pub mod filters {
  use super::handlers;
  use crate::api::ApiState;
  use std::{
    convert::Infallible,
    sync::Arc,
  };
  use warp::{body, path, Filter};

  /// Entry point for the tree api.
  pub fn tree(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    tree_connect(Arc::clone(&state))
      .or(tree_disconnect())
      .or(tree_ingest(state))
  }

  /// Api for connecting a plugin session.
  fn tree_connect(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    path!("connect")
      .and(warp::post())
      .and(body::content_length_limit(1024))
      .and(body::json())
      .and(with_state(state))
      .and_then(handlers::connect)
  }

  /// Api for disconnecting a plugin session.
  fn tree_disconnect() -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    path!("disconnect").and(warp::post()).and_then(handlers::disconnect)
  }

  /// Api for ingesting a game tree export from the plugin.
  fn tree_ingest(state: Arc<ApiState>) -> impl Filter<Extract = (impl warp::Reply,), Error = warp::Rejection> + Clone {
    path!("tree")
      .and(warp::post())
      .and(body::content_length_limit(handlers::MAX_TREE_BYTES))
      .and(body::json())
      .and(with_state(state))
      .and_then(handlers::ingest_tree)
  }

  /// Helper for warp.
  fn with_state(state: Arc<ApiState>) -> impl Filter<Extract = (Arc<ApiState>,), Error = Infallible> + Clone {
    warp::any().map(move || Arc::clone(&state))
  }
}

mod handlers {
  use crate::api::ApiState;
  use crate::core::tree::{GameTree, FORMAT_VERSION};
  use serde::{Deserialize, Serialize};
  use std::{convert::Infallible, sync::Arc};
  use warp::{
    http::StatusCode,
    reply::{json, with_status},
  };

  /// The maximum accepted tree export size (64 MiB). Full exports carrying
  /// script sources can grow large.
  pub const MAX_TREE_BYTES: u64 = 64 * 1024 * 1024;

  /// A connection request sent by the plugin.
  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  pub struct ConnectRequest {
    /// The version of the plugin.
    pub plugin_version: Option<String>,
  }

  /// A connection response describing the session to the plugin.
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct ConnectResponse {
    /// The response status.
    pub status: &'static str,

    /// The project name.
    pub name: String,

    /// The Verde version.
    pub version: &'static str,

    /// The top level services defined by the project tree.
    pub services: Vec<String>,
  }

  /// A simple status response.
  #[derive(Serialize)]
  pub struct StatusResponse {
    /// The response status.
    pub status: &'static str,
  }

  /// A tree ingest response.
  #[derive(Serialize)]
  pub struct IngestResponse {
    /// The response status.
    pub status: &'static str,

    /// The number of pending game.json actions queued for Studio.
    pub pending: usize,
  }

  /// An error response.
  #[derive(Serialize)]
  pub struct ErrorResponse {
    /// The response status.
    pub status: &'static str,

    /// The error message.
    pub message: String,
  }

  pub async fn connect(_request: ConnectRequest, state: Arc<ApiState>) -> Result<impl warp::Reply, Infallible> {
    Ok(json(&ConnectResponse {
      status: "ok",
      name: state.project.name.clone(),
      version: env!("CARGO_PKG_VERSION"),
      services: state.tree.project_services(),
    }))
  }

  pub async fn disconnect() -> Result<impl warp::Reply, Infallible> {
    Ok(json(&StatusResponse { status: "ok" }))
  }

  pub async fn ingest_tree(tree: GameTree, state: Arc<ApiState>) -> Result<impl warp::Reply, Infallible> {
    if tree.format_version != FORMAT_VERSION {
      return Ok(with_status(
        json(&ErrorResponse {
          status: "error",
          message: format!("Unsupported format version {} (expected {})", tree.format_version, FORMAT_VERSION),
        }),
        StatusCode::BAD_REQUEST,
      ));
    }

    match state.tree.ingest_export(&tree, &state.payload) {
      Ok(pending) => Ok(with_status(
        json(&IngestResponse { status: "ok", pending }),
        StatusCode::OK,
      )),
      Err(error) => Ok(with_status(
        json(&ErrorResponse {
          status: "error",
          message: format!("{error:#}"),
        }),
        StatusCode::INTERNAL_SERVER_ERROR,
      )),
    }
  }
}
