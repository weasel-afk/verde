// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
use crate::core::payload::transform::transform_file;
use crate::core::payload::Payload;
use crate::core::project::VerdeProject;
use crate::core::tree::{TreeState, GAME_FILE};
use anyhow::{bail, Context};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, RecommendedCache};
use std::{
  path::{Path, PathBuf},
  sync::{Arc, RwLock},
  time::Duration,
};
use tokio::sync::mpsc;

type VerdeDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

/// The duration for the debounce watcher events.
const DEBOUNCE_DURATION: Duration = Duration::from_millis(250);

/// The Verde watcher.
pub struct VerdeWatcher {
  /// The debouncer watching for file system events.
  _debouncer: VerdeDebouncer,

  /// The verde project currently being watched.
  project: Arc<VerdeProject>,

  /// The canonical project root directory.
  project_root: PathBuf,

  /// The game tree state handling game.json edits.
  tree: Arc<TreeState>,

  /// The debounced event receiver channel.
  watch_rx: mpsc::Receiver<DebouncedEvent>,

  /// The payload.
  pub payload: Arc<RwLock<Payload>>,
}

impl VerdeWatcher {
  /// Create a new Verde watcher for the specified project.
  pub fn new(project: &Arc<VerdeProject>, tree: Arc<TreeState>) -> anyhow::Result<Self> {
    let (watch_tx, watch_rx) = mpsc::channel(1); // watch send/receive queue 1 item

    // Watch the project root (for game.json) alongside the mapped directories.
    let root = project.root.as_ref().context("The project has no root directory")?;
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let mut paths = vec![root.clone()];
    paths.extend(project.tree.get_roots());

    // Create debounce watcher
    let _debouncer = create_watcher(watch_tx, paths)?;

    // Create initial payload
    let payload = Arc::new(RwLock::new(Payload::default()));

    Ok(Self {
      _debouncer,
      project: Arc::clone(project),
      project_root: root,
      tree,
      watch_rx,
      payload,
    })
  }

  /// Starts listening for events.
  pub async fn start(&mut self) -> anyhow::Result<()> {
    loop {
      if let Some(ev) = self.watch_rx.recv().await {
        if let Err(err) = self.transform_event(ev).await {
          eprintln!("Failed to transform file event: {err:#}");
        }
      }
    }
  }

  /// Transforms the debounced event into a payload event.
  async fn transform_event(&mut self, event: DebouncedEvent) -> anyhow::Result<()> {
    // We only want to track file changes.
    if let Some(file_path) = event.paths.first() {
      if !file_path.is_file() {
        return Ok(());
      }

      // Route game.json edits through the tree state differ. A document that
      // fails to parse is logged and ignored until the next save.
      if self.is_game_json(file_path) {
        if let Err(error) = self.tree.handle_game_json_event(&self.payload) {
          eprintln!("Failed to process game.json change: {error:#}");
        }

        return Ok(());
      }

      if let Ok(mut payload) = self.payload.try_write() {
        // A single untransformable file (e.g. an unparsable project mapping)
        // must not stop the watch loop for the remaining files.
        match transform_file(file_path, &event.kind, &self.project) {
          Ok(file) => payload.add_payload(file),
          Err(error) => eprintln!("Failed to transform {}: {error:#}", file_path.display()),
        }
      }
    }

    Ok(())
  }

  /// Determines if a path is the project's game.json document.
  fn is_game_json(&self, path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == GAME_FILE)
      && path.parent().is_some_and(|parent| parent == self.project_root.as_path())
  }
}

/// Creates a new file system watcher piping events to the watch transmitter.
pub fn create_watcher(watch_tx: mpsc::Sender<DebouncedEvent>, paths: Vec<PathBuf>) -> anyhow::Result<VerdeDebouncer> {
  // We shouldnt get any empty paths if project is correct
  if paths.is_empty() {
    bail!("Unable to find any directories to watch. Please check your project file.");
  }

  // Create watcher (in the future we can probably allow specifying polling explicitly for rare cases)
  let mut debouncer = new_debouncer(
    DEBOUNCE_DURATION,
    None,
    move |result: DebounceEventResult| match result {
      Ok(events) => events.into_iter().for_each(|event| {
        watch_tx.blocking_send(event).unwrap();
      }),
      Err(error) => error.iter().for_each(|error| println!("{error:?}")),
    },
  )
  .with_context(|| "Failed to create watcher")?;

  // Setup watcher and cache for each specified root
  // The paths should be canonicalized so we dont need to do any extra processing
  for path in paths {
    debouncer
      .watch(&path, RecursiveMode::Recursive)
      .with_context(|| format!("Failed to watch {path:?} for file changes."))?;
  }

  Ok(debouncer)
}
