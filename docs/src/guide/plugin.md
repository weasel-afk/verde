# Plugin

The Verde plugin is what allows the bridge between Roblox Studio and your file system to work.
Internally it polls the Verde API for new files and will create/update them in studio.

## Connecting

1. Start the CLI in your project directory: `verde serve`.
2. Open Roblox Studio and the Verde widget (View → Verde if closed).
3. Check the port matches the CLI (default `34872`), then press **Connect**.

The widget shows the connection status below the Connect button. On connect the plugin exports the game's instance tree to `game.json` in your project — from that point, every edit to `game.json` is applied live into Studio (see the [Game Tree reference](/reference/game-json) for the format and semantics). Reconnecting refreshes `game.json` with any manual changes made in Studio.

::: warning HTTP Requests
The plugin talks to the CLI over HTTP. Enable **Game Settings → Security → Allow HTTP Requests** — this Studio setting applies to plugins even outside Play Solo.
:::

## Building from source

The plugin directory is itself a Roblox project. With the toolchain installed ([rokit](https://github.com/rojo-rbx/rokit)):

```sh
cd plugin
rokit install        # installs rojo, StyLua and pesde
pesde install        # installs Luau dependencies
rojo build default.project.json -o Verde.rbxm
```

Copy `Verde.rbxm` into Studio's plugins folder (Studio → Plugins Folder), or use `rojo serve dev.project.json` with the Rojo plugin for live development against `Workspace.Verde`.
