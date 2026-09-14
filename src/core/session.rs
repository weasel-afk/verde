// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use super::project::VerdeProject;
use crate::{api, core::tree::TreeState, core::watcher::VerdeWatcher};
use std::{
  net::{IpAddr, Ipv4Addr, SocketAddr},
  sync::Arc,
};
use tokio::{
  join,
  runtime::{Builder, Runtime},
};

pub const DEFAULT_HOST: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
pub const DEFAULT_PORT: u16 = 34872;

/// Describes the current state of the session.
pub enum SessionState {
  /// Session is actively watching and synchronising files.
  Active,

  /// Session is not externally accessible and is closed.
  Offline,

  /// Session encountered an error and cannot continue.
  Error,
}

/// Manages the Verde Session and state.
pub struct VerdeSession {
  /// The hostname the session will listen on.
  pub host: IpAddr,

  /// The port the session will listen on.
  pub port: u16,

  /// The current state of the session.
  pub state: SessionState,

  /// The project tied to the session.
  pub project: Arc<VerdeProject>,

  /// The tokio runtime for asynchronous tasks
  runtime: Runtime,
}

impl VerdeSession {
  /// Creates a new VerdeSession with the specified project.
  pub fn new(project: &Arc<VerdeProject>) -> Self {
    VerdeSession {
      project: Arc::clone(project),
      ..Default::default()
    }
  }

  /// Starts the session and begins listening
  pub fn start(&self) -> anyhow::Result<()> {
    println!("Serving on port {}", self.port);

    // Setup game tree state (baseline snapshot + game.json document)
    let tree = Arc::new(TreeState::initialise(&self.project)?);

    // Setup watcher
    let mut watcher = VerdeWatcher::new(&self.project, Arc::clone(&tree))?;

    // Start serve api
    self.runtime.block_on(async {
      // Apply any game.json edits made while Verde was not running.
      let payload = Arc::clone(&watcher.payload);
      if let Err(error) = tree.handle_game_json_event(&payload) {
        eprintln!("Failed to process existing game.json: {error:#}");
      }

      // Create api route
      let api = api::get_routes(Arc::new(api::ApiState {
        payload,
        tree: Arc::clone(&tree),
        project: Arc::clone(&self.project),
      }));

      // Start watching and serving api
      let watch_fut = watcher.start();
      let api_fut = warp::serve(api).run(SocketAddr::new(self.host, self.port));
      let (watcher_res, _) = join!(watch_fut, api_fut);
      match watcher_res {
        Ok(()) => println!("Watcher stopped."),
        Err(err) => println!("Watcher failed {err}"),
      };
    });

    Ok(())
  }
}

impl Default for VerdeSession {
  fn default() -> Self {
    Self {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      state: SessionState::Offline,
      project: Arc::default(),
      runtime: Builder::new_multi_thread().enable_all().build().unwrap(),
    }
  }
}
