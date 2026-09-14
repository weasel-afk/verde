# Verde

![Verde Logo](logo_small.png)

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
- **Play Sounds right from VS Code**: Opening the Properties panel of a Sound instance, there will be a green Play button, just like in studio.
  - If not playing, make sure the `Only Play Audio When Window In Focus` Studio setting is disabled.

![Sample Image](assets/sample.png)

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

## game.json Live Sync

With `verde.gameJsonSync` enabled, Verde maintains a `game.json` file in the workspace describing the game's instance tree:

1. When the Studio plugin connects, it exports the live tree into `game.json` (merging any edits made while it was disconnected).
2. Every save of `game.json` is diffed against the baseline in `.verde/snapshot.json` and applied live into Studio — creating instances, setting properties and deleting removed instances, as one undo step.
3. Deletes are baseline-scoped: only instances present in the last export can be deleted, and top-level services are never deleted.

Use **Verde: Export game.json from Studio** to refresh the file with manual Studio changes at any time. The file is designed as an editing surface for AI agents — see the repository's [AGENTS.md](https://github.com/Dvitash/Verde/blob/main/AGENTS.md) for the agent guide.

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