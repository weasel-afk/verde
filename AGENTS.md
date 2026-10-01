# Verde `game.json` — Agent Guide

This project uses **Verde** (VS Code extension + Roblox Studio plugin) to sync a JSON representation of the Roblox game tree with a **live Roblox Studio session**. You can create instances, change properties, and delete instances **by editing `game.json`** — no Roblox Studio access required. Changes apply within a second of saving.

## How it works

```
game.json edit → the Verde extension diffs it against .verde/snapshot.json
               → ordered actions queued → the Studio plugin applies them live
```

- The **Verde** extension must be running in VS Code with the workspace open, the `verde.gameJsonSync` setting enabled, and the **Verde plugin connected** in Roblox Studio (toolbar button). Edits made while disconnected are queued and applied when it reconnects.
- **`game.json` is the source of truth.** Removing a node destroys that instance in Studio (one undo step per applied save).
- On every plugin (re)connect the plugin exports the live tree into `game.json`, merging your queued edits on top. Manual changes made *in Studio* flow back into `game.json` at that point, or on demand via the **Verde: Export game.json from Studio** command.

## MCP tools (preferred when available)

If the Verde MCP server is connected (check with the `verde_status` tool), prefer it over raw file edits: it confirms delivery synchronously and reports per-action errors, so you don't have to poll `.verde/snapshot.json`.

- `verde_status` — plugin connected? queue length? baseline initialised? Call this first.
- `get_game_tree` — read the tree. With the plugin connected this is **live** (and refreshes `game.json`); without it you get the document with `stale: true`. Use `mode: "summary"` (names/classes/child counts) to orient before full reads, and `path`/`maxDepth` to bound size.
- `apply_tree_actions` — create/update/delete by path, same semantics and rules as editing `game.json` (see below), applied as one undo step. The whole batch is validated before anything is applied; an invalid action returns the offending action and nothing lands.
  - Response statuses: `applied` (with plugin-reported counts and any per-action failures), `queued-offline` (no plugin connected; lands on reconnect), `queued-retry` (delivery failed, retried automatically), `no-change` (e.g. before the first export, the edit only lands in the file).
  - The reported counts describe the **delivered diff**, not an echo of your submitted actions — they can differ in shape while converging to the same result.
- `undo` / `redo` — Studio change-history only; they do **not** rewind `game.json`. Follow with `get_game_tree` to refresh the document.

When MCP is not available, edit `game.json` directly as described below — both surfaces share the same baseline and cannot fight each other.

## Before you edit

1. Read `game.json` to see the current tree. If it's missing or a skeleton (no children anywhere), the plugin hasn't exported yet — ask the user to connect it in Studio.
2. To confirm your edit was processed: after saving, wait a moment and check that `.verde/snapshot.json` now matches your edit (the snapshot is the applied baseline). If it doesn't advance, the plugin isn't connected.

## Format

```json
{
  "formatVersion": 1,
  "className": "DataModel",
  "children": {
    "Workspace": {
      "children": {
        "Baseplate": {
          "className": "Part",
          "properties": {
            "Anchored": true,
            "Size": { "type": "Vector3", "x": 512, "y": 20, "z": 512 },
            "Color": { "type": "Color3", "r": 163, "g": 162, "b": 165 },
            "Material": { "type": "Enum", "enumType": "Material", "value": "Plastic" }
          }
        }
      }
    }
  }
}
```

- Keep `"formatVersion": 1` exactly.
- `children` are **keyed by instance name** — duplicate sibling names cannot be represented (on export, duplicates are skipped with a warning). `className` falls back to the key name (services don't need it).
- `properties` are optional; only properties present in the file are managed.
- Preserve the overall structure and don't drop existing nodes accidentally — anything you remove gets deleted.

### Property values

Raw JSON for primitives:

| JSON | Roblox |
|---|---|
| `true` / `false` | boolean |
| `1.5` | number |
| `"rbxassetid://1234"` | string |

Tagged objects for complex types:

| Type | Example |
|---|---|
| `Vector2` | `{ "type": "Vector2", "x": 0.5, "y": 0.5 }` |
| `Vector3` | `{ "type": "Vector3", "x": 4, "y": 1, "z": 2 }` |
| `Color3` | `{ "type": "Color3", "r": 255, "g": 0, "b": 0 }` — 0–255 components |
| `UDim` | `{ "type": "UDim", "scale": 0.5, "offset": 12 }` |
| `UDim2` | `{ "type": "UDim2", "scaleX": 0, "offsetX": 200, "scaleY": 0, "offsetY": 50 }` |
| `Enum` | `{ "type": "Enum", "enumType": "Material", "value": "Neon" }` — by name |
| `CFrame` | `{ "type": "CFrame", "position": { "x": 0, "y": 5, "z": 0 }, "rotation": [1,0,0,0,1,0,0,0,1] }` |
| `Rect` | `{ "type": "Rect", "min": { "x": 0, "y": 0 }, "max": { "x": 100, "y": 100 } }` |
| `Font` | `{ "type": "Font", "family": "rbxasset://fonts/families/SourceSansPro.json", "weight": "SemiBold" }` |

Parts are usually easier via `Position` + `Orientation` (Vector3s) than CFrame. You may set **any** property the class supports, even ones not present in the export.

## Recipes

**Add an instance** — insert a node under its parent's `children` (create parent nodes first if missing; Verde orders creates automatically):

```json
"SpawnPoint": {
  "className": "SpawnLocation",
  "properties": {
    "Anchored": true,
    "Position": { "type": "Vector3", "x": 0, "y": 5, "z": 0 },
    "Neutral": true
  }
}
```

**Change properties** — edit values on an existing node. The whole `properties` map is re-applied, so keep the other properties in place.

**Delete an instance** — remove its node. Only instances that exist in `.verde/snapshot.json` can be deleted (you can't destroy something you never saw). Top-level services are never deleted.

**Rename / change className** — treated as delete + recreate of that subtree (children under the old name are destroyed; re-add them under the new name).

**Script source** — `"Source": "print('hello')"` inside `properties` (plain string). Script `Source` round-trips fully in this project; editing it here edits the live script in Studio.

## Rules & gotchas

- **Invalid JSON is ignored** (warned in the Verde output channel) until the next valid save — nothing breaks, but nothing applies either.
- Removing a property key leaves the property **unmanaged**, it does not reset it.
- Key order doesn't matter; Verde writes sorted keys.
- Attributes, tags and collections are not part of the v1 format — don't try to encode them.
- Only one Studio instance should be connected at a time; with several, sync behavior is undefined.

## Verify your work

1. Save `game.json` (valid JSON).
2. Wait ~1 second.
3. `.verde/snapshot.json` should now contain your change (that's proof it was applied and queued to Studio).
4. If it didn't advance: the extension or plugin isn't connected — tell the user rather than retrying edits.
