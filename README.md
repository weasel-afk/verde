# Verde

![Verde Logo](extension/logo_small.png)

A Roblox Studio + Properties Emulator VS Code extension.

Verde allows to view your entire datamodel from within VS Code, with operations like copy, paste, duplicate, rename, and delete for any instance.

Verde also comes with a properties window, allowing you to read and modify any properties of any instance without having to leave your editor.

Verde can be used either with a dedicated sync tool (Like Rojo/Argon/Azul) or with the newly released Script Sync + [Luau-LSP](https://github.com/JohnnyMorganz/luau-lsp) (for sourcemap generation)

## Features

- **Live Instance Tree**: View your Roblox game's instance hierarchy in VS Code.
- **Script Opening**: Double-click scripts from the explorer to open them right in VS Code (works with Rojo/Argon/Azul/Luau-LSP sourcemaps).
- **Instance Operations**: Rename, duplicate, delete, copy, and paste instances.
- **Ctrl+P Quick-Pick Menu**: Quickly see most recently interacted instances, or search for a specific instance to quickly navigate to it.
- **Properties Panel**: View and edit instance properties right from VS Code.
- **game.json Live Sync**: Edit a JSON representation of the whole instance tree (`game.json`) — by hand or with an AI agent — and watch changes apply live in Roblox Studio.
- **MCP Server**: Expose the live tree to AI agents over a loopback MCP server — read the tree, apply changes with synchronous confirmation, undo/redo.
- **Play Sounds right from VS Code**: Opening the Properties panel of a Sound instance, there will be a green Play button, just like in studio.
  - If not playing, make sure the `Only Play Audio When Window In Focus` Studio setting is disabled.

![Sample Image](extension/assets/sample.png)

## Requirements

- Roblox Studio with the Verde plugin installed
- A Rojo/Argon/Azul setup with sourcemap generation (for script opening functionality)

## Extension Installation

### Manually

1. Run `npm run package` in the extension directory to create a `.vsix` file
2. In VS Code, press Ctrl + Shift + P to open the command palette
3. Select "Install from VSIX..." and choose the generated `.vsix` file

### Online
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Dvitash.verde)

[OpenVSX Registry](https://open-vsx.org/extension/Dvitash/verde)

## Setup

1. Install the [Verde plugin](https://create.roblox.com/store/asset/84296161836385) in Roblox Studio
2. Open your VS Code workspace
3. The extension will automatically start a WebSocket server
4. Open Roblox Studio and run your game with the plugin
5. The Roblox Explorer view should appear in VS Code

## Extension Settings

* `verde.sourcemapPath`: Path to sourcemap file (relative to workspace root) - defaults to "sourcemap.json"
* `verde.port`: Port for the WebSocket server - defaults to 9000
* `verde.host`: Host IP address for the WebSocket server - defaults to "localhost"
* `verde.autoStart`: Automatically start the server when the extension activates - defaults to true
* `verde.gameJsonSync`: Live-sync a `game.json` instance tree document with Roblox Studio (writes `game.json` and `.verde/snapshot.json` into the first workspace folder) - defaults to false
* `verde.gameJsonPath`: Workspace-relative path of the game tree document - defaults to "game.json"
* `verde.mcp.enabled`: Run a local MCP server (loopback only) exposing Verde's live Studio tree sync as tools for AI agents - defaults to false
* `verde.mcp.port`: Port for the local MCP HTTP server (bound to 127.0.0.1) - defaults to 9124
* `verde.iconDirectory`: Optional absolute or workspace-relative directory containing `ClassName.png` overrides. You can point either to the icon folder itself or to a parent pack root that contains `RobloxCustom/instance/16x/200`. Missing icons still use Verde's bundled assets.

## game.json Live Sync

With `verde.gameJsonSync` enabled, Verde maintains a `game.json` file in the workspace describing the game's instance tree (format documented in [AGENTS.md](AGENTS.md)):

1. When the Studio plugin connects, it exports the live tree into `game.json` (merging any edits made while it was disconnected).
2. Every save of `game.json` is diffed against the baseline in `.verde/snapshot.json` and applied live into Studio — creating instances, setting properties and deleting removed instances, as one undo step.
3. Deletes are baseline-scoped: only instances present in the last export can be deleted, and top-level services are never deleted.

Use **Verde: Export game.json from Studio** to refresh the file with manual Studio changes at any time. The file is designed as an editing surface for AI agents — see [AGENTS.md](AGENTS.md) for the agent guide.

## MCP Server

With `verde.mcp.enabled`, Verde runs a Model Context Protocol server on `127.0.0.1` (default port 9124, endpoint `/mcp`) so AI agents can drive the live tree directly:

- **`get_game_tree`** — read the tree (live from Studio when the plugin is connected, otherwise the `game.json` document with `stale: true`); supports subtree `path`, a compact `summary` mode and `maxDepth`.
- **`apply_tree_actions`** — create/update/delete by path, validated and applied through the same machinery as a `game.json` edit, with the delivery result returned synchronously.
- **`verde_status`** — connection state, pending queue and endpoint info.
- **`undo` / `redo`** — Studio change-history steps (one `apply_tree_actions` call = one step).

Tree tools require `verde.gameJsonSync` — `game.json` stays the source of truth for both editing surfaces. The server is loopback-only and opt-in; it is not an authentication boundary (any local process can call it, like the plugin WebSocket).

To connect Claude Code:

```
claude mcp add --transport http verde http://127.0.0.1:9124/mcp
```

Run it inside the project for local scope (or add `-s user`), then verify with `/mcp`. **Verde: Show MCP Server Info** prints the endpoint and a copyable connect command.

## Usage

### Opening Scripts

1. Click on any Script, LocalScript, or ModuleScript in the Verde explorer
2. The extension will look up the file path in your sourcemap
3. The corresponding file will open in VS Code

### Instance Operations

- Right-click instances for context menu options
- Use keyboard shortcuts for quick operations:
  - `Enter`: Rename
  - `Delete`: Delete
  - `Ctrl+C`: Copy
  - `Ctrl+V`: Paste
  - `Ctrl+D`: Duplicate
  - `Ctrl+Shift+A`: Open new instance panel
