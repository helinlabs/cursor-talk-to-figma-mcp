# Design-System Usage Analysis

Three MCP tools expose the *provenance* of rendered values — which library
component / variable token / style a node references — so an analysis session
can measure design-system reuse between a **Foundation** (library) file and a
**Product** (consumer) file.

## Matching principle

A library-linked asset shares the **same `key`** in the source and consuming
files. So the workflow is: build a key catalog from Foundation, then check
which keys the Product's nodes reference.

- Copy-pasted assets get a *different* key → automatically counted as "not reused".
- `remote: true` on a reference means it resolves to an external/published
  library (i.e. Foundation); `remote: false` means a local asset in the same file.
- A node with **no** `component` / `styles` / `boundVariables` is using a raw,
  untokenized value there.

All getters are async (`getMainComponentAsync`, `getVariableByIdAsync`,
`getStyleByIdAsync`, `getLocalVariablesAsync`, …) and dynamic-page safe;
missing/failed lookups are returned as `null`/omitted, never thrown.

---

## Tool: `get_design_system_info`  (run on the Foundation file)

The library catalog, including **Variables** (which `get_styles` omits).

**Input**
| field | type | default | meaning |
|---|---|---|---|
| `includeVariableValues` | bool | true | include each variable's value per mode |
| `resolveNames` | bool | true | include human-readable names |

**Output**
```jsonc
{
  "components": { "count": 793, "items": [
    { "id", "key", "name", "type": "COMPONENT|COMPONENT_SET", "remote",
      "componentSetId?", "componentSetKey?" }   // set keys for variants
  ]},
  "styles": {
    "paint": [{ "id", "key", "name", "remote" }],
    "text":  [ ... ], "effect": [ ... ], "grid": [ ... ]
  },
  "variableCollections": [
    { "id", "key", "name", "defaultModeId", "modes": [{ "modeId", "name" }], "variableCount" }
  ],
  "variables": { "count": N, "items": [
    { "id", "key", "name", "resolvedType": "COLOR|FLOAT|STRING|BOOLEAN",
      "collectionId", "collectionName",
      "valuesByMode": { "<modeName>": <value> } }   // see value shapes below
  ]}
}
```

**Variable value shapes** (`valuesByMode[mode]`):
- color → `{ "type": "color", "hex": "#RRGGBB", "rgba": { r,g,b,a } }`
- alias to another variable → `{ "type": "alias", "id": "VariableID:..." }`
- other → `{ "type": "float|string|boolean", "value": ... }`

> **The catalog you match against** = the set of `key`s under `components.items`,
> `styles.*`, and `variables.items`.

---

## Tool: `get_nodes_design_info`  (targeted, on the Product file)

Per-node bindings for an explicit list of node IDs. Null sections are omitted.

**Input**: `nodeIds: string[]`, `resolveNames?: bool (true)`

**Output**
```jsonc
{ "count": N, "nodes": [
  {
    "id", "name", "type",
    // only for INSTANCE nodes; null if detached:
    "component": { "id", "key", "remote", "name?",
                   "componentSetId?", "componentSetKey?", "componentSetName?" },
    // present only if the node references styles:
    "styles": {
      "fill?":   { "id", "key", "remote", "styleType", "name?" },
      "stroke?": { ... }, "text?": { ... }, "effect?": { ... }, "grid?": { ... }
    },
    // present only if the node has variable bindings; keyed by bound property:
    "boundVariables": {
      "<property>": [ { "id", "key", "resolvedType", "name?" } ]
      // e.g. "fills", "strokes", "cornerRadius", "width", "characters", ...
    }
  }
]}
```

`component.key` → match Product instance to a Foundation component.
`styles.*.key` → match to a Foundation style.
`boundVariables.<prop>[].key` → match the bound token to a Foundation variable.

---

## Tool: `scan_design_usage`  (bulk, on the Product file)

Walks a subtree and returns an **aggregated** summary (counts + sample node IDs
per key), built for large trees (~1000s of nodes). Set `includeNodes: true` to
also get the per-node records (same shape as `get_nodes_design_info`).

**Input**
| field | type | default | meaning |
|---|---|---|---|
| `nodeId` | string | — | root of the subtree (page or top frame) |
| `chunkSize` | number | 200 | nodes per processing chunk |
| `includeNodes` | bool | false | also return per-node list (can be large) |
| `resolveNames` | bool | true | include human-readable names |

**Output**
```jsonc
{
  "scannedNodes": 1391,
  "summary": {
    "instances": {
      "total", "remote", "local", "detached",
      "byComponentKey": { "<key>": { "count", "samples": [nodeId...], "remote", "name?", "componentSetKey?" } }
    },
    "styles": {
      "fill":   { "<styleKey>": { "count", "samples", "remote", "name?" } },
      "text": { ... }, "effect": { ... }, "stroke": { ... }, "grid": { ... }
    },
    "variables": {
      "totalBoundProps",
      "byVariableKey": { "<varKey>": { "count", "samples", "resolvedType", "name?" } }
    },
    "fills": { "tokenizedOrStyled", "rawSolid" }   // color-token coverage signal
  },
  "nodes": [ ... ]   // only when includeNodes: true
}
```

- `instances.remote` = instances whose main component is a library component
  (matchable to Foundation by key). `detached` = no main component.
- `fills.tokenizedOrStyled` vs `fills.rawSolid` = a quick color-token coverage
  ratio (solid fills that are NOT bound to a variable or a fill style are "raw").
- The `"(no-key)"` bucket collects references whose `key` is empty (e.g. an
  unpublished local asset).

---

## Recommended analysis flow

1. **Foundation**: `join_channel` → `get_design_system_info`. Build sets of
   component keys, style keys, variable keys (and name lookups).
2. **Product**: `join_channel` → `scan_design_usage` on the target page/frame.
3. Reuse rate = (references whose key ∈ Foundation catalog) / (total references).
   - Components: `instances.byComponentKey` keys ∩ Foundation component keys.
   - Color tokens: `variables.byVariableKey` keys ∩ Foundation variable keys;
     untokenized = `fills.rawSolid`.
   - Type/effect/fill styles: `styles.*` keys ∩ Foundation style keys.
4. Drill into specific offenders with `get_nodes_design_info` using the
   `samples` node IDs.

## Build / reload

- **MCP server** runs from source (`bun .../server.ts`) — no build step; the new
  tools appear on the next Claude session / MCP reconnect. (`bun run build` only
  needed if you publish `dist/`.)
- **Plugin** (`code.js`): in Figma, re-run the plugin
  (Plugins → Development → Cursor MCP Plugin) so the new command handlers load.
- The **WebSocket relay** (`bun socket`) must be running.
