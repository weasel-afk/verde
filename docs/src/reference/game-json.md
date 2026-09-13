# Game Tree (`game.json`)

The game tree document is a JSON representation of every instance in your game. While `verde serve` is running, any edit to `game.json` is applied live into Roblox Studio through the Studio plugin — making it possible for AI agents (or humans) to create instances, change properties, and delete instances without ever touching Studio.

```
game.json edit → verde diffs against its snapshot → ordered actions → plugin applies in Studio
```

## Format

The document is a recursive tree rooted at the `DataModel`. Each child is keyed by its instance name:

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

### Nodes

| Field | Type | Description |
| --- | --- | --- |
| `className` | `string?` | The class of the instance. Falls back to the node key name when absent (e.g. a `Workspace` key does not need `className: "Workspace"`). |
| `properties` | `object?` | The properties to manage on the instance. |
| `children` | `object?` | Child instances, keyed by name. |

Children are keyed by name, so **duplicate sibling names cannot be represented**.

### Property values

Primitive values are written as raw JSON:

| JSON | Roblox |
| --- | --- |
| `true` / `false` | `boolean` |
| `1.5` | `number` |
| `"rbxassetid://1234"` | `string` |

Complex values are tagged objects:

| Type | Example | Notes |
| --- | --- | --- |
| `Vector2` | `{ "type": "Vector2", "x": 0.5, "y": 0.5 }` | |
| `Vector3` | `{ "type": "Vector3", "x": 4, "y": 1, "z": 2 }` | |
| `Color3` | `{ "type": "Color3", "r": 255, "g": 0, "b": 0 }` | 0-255 components, matching `Color3.fromRGB` |
| `UDim` | `{ "type": "UDim", "scale": 0.5, "offset": 12 }` | |
| `UDim2` | `{ "type": "UDim2", "scaleX": 0, "offsetX": 200, "scaleY": 0, "offsetY": 50 }` | |
| `Enum` | `{ "type": "Enum", "enumType": "Material", "value": "Neon" }` | Referenced by name |
| `CFrame` | `{ "type": "CFrame", "position": { "x": 0, "y": 0, "z": 0 }, "rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1] }` | Row-major 3x3 rotation matrix. Editing parts via `Position`/`Orientation` is usually friendlier. |
| `Rect` | `{ "type": "Rect", "min": { "x": 0, "y": 0 }, "max": { "x": 100, "y": 100 } }` | |
| `Font` | `{ "type": "Font", "family": "rbxasset://fonts/families/SourceSansPro.json", "weight": "SemiBold" }` | `weight`/`style` are enum names and optional |

Unknown `type` tags are rejected when the file is parsed, protecting against typos.

## Editing semantics

When `game.json` changes on disk, Verde diffs it against its last known snapshot (persisted in `.verde/snapshot.json`) and applies the difference:

- **Added node** → the instance (and its subtree) is created in Studio, parents first.
- **Removed node** → the instance is destroyed in Studio. Only instances that existed in the last snapshot can be deleted — an edit cannot destroy something it never saw. Top level services are never deleted.
- **Changed property** → the instance's properties are updated in Studio. The full property map is applied, and properties absent from the document become *unmanaged* (they are left as-is rather than reset).
- **Renamed node** → treated as a delete of the old name and a create of the new one.
- **Changed `className`** → treated as a delete and a re-create of the subtree.

Script `Source` for scripts managed by your project's `.path` mappings is owned by the file sync pipeline and stripped from the document, so the two systems never fight over the same source.

Invalid JSON is never fatal: Verde logs a warning, leaves Studio untouched, and retries on the next save.
