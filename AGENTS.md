# Verde `game.json` — Agent Guide

This project uses **Verde** to sync a JSON representation of the Roblox game tree with a **live Roblox Studio session**. You can create instances, change properties, and delete instances **by editing `game.json`** — no Roblox Studio access required. Changes apply within ~0.5 seconds of saving.

## How it works

```
game.json edit → verde serve diffs it against .verde/snapshot.json
              → ordered actions queued → Studio plugin applies them live
```

- `verde serve` (port 34872) must be running and the **Verde Fork** plugin connected in Studio. Edits made while disconnected are queued and applied when it reconnects.
- **`game.json` is the source of truth.** Removing a node destroys that instance in Studio.

## Before you edit

1. Read `game.json` to see the current tree. If it's a skeleton (services only, no children), the plugin hasn't exported yet — ask the user to connect it in Studio.
2. Never call `GET /heartbeat` yourself — it is part of the plugin's delivery and acknowledgement protocol.
3. To confirm your edit was processed: after saving, wait a moment and check that `.verde/snapshot.json` now matches your edit (the snapshot is the applied baseline). If it doesn't advance, the plugin isn't connected.

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
- `children` are **keyed by instance name** — duplicate sibling names cannot be represented. `className` falls back to the key name (services don't need it).
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

**Add an instance** — insert a node under its parent's `children` (create parent nodes first if missing; verde orders creates automatically):

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

**Script source** — `"Source": "print('hello')"` inside `properties` (plain string). Note: scripts under folders mapped in `verde.yaml` (`src/` etc.) are owned by file sync and their `Source` is intentionally absent from the export — edit those `.luau` files on disk instead.

## Rules & gotchas

- **Invalid JSON is ignored** (warned in `verde serve` output) until the next valid save — nothing breaks, but nothing applies either.
- Removing a property key leaves the property **unmanaged**, it does not reset it.
- Key order doesn't matter; verde writes sorted keys.
- Edits apply in Studio, but manual changes made *in Studio* only flow back into `game.json` when the plugin reconnects (press Disconnect → Connect).
- Script `RunContext`, attributes, and collections are not yet supported.

## Verify your work

1. Save `game.json` (valid JSON).
2. Wait ~1 second.
3. `.verde/snapshot.json` should now contain your change (that's proof it was applied and queued to Studio).
4. If it didn't advance: `verde serve` isn't running or the plugin isn't connected — tell the user rather than retrying edits.
