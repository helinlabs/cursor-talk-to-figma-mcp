# Efficient design reads

Addresses [#1](../../issues/1): read calls returned very large, unfiltered
payloads that blew the agent's token budget. These options keep responses small
and let an agent stay on the API instead of saving-to-file.

## Shape what you read

### `get_node_info` / `get_nodes_info` — `fields` + `maxDepth`
- **`fields`**: only return these top-level properties (`id`/`name`/`type` are
  always kept). e.g. `fields: ["fills","characters","style","absoluteBoundingBox","componentProperties"]`.
  Omit `"children"` to get just the node with no subtree.
- **`maxDepth`**: how many child levels to expand. `0` = node only, `1` = direct
  children, etc. Omit for the full subtree.
- When children are dropped (by depth or by leaving `"children"` out of
  `fields`), the node gets a **`childCount`** so you know to drill deeper.

```jsonc
// just the top-level structure of a 900K-char section → a few KB
get_node_info({ nodeId: "24:4354", maxDepth: 1 })
// only the fills + text of a node, no geometry
get_node_info({ nodeId: "…", fields: ["fills","characters","style"] })
```

> The MCP server no longer re-filters the plugin's output (it was a redundant
> second pass that could corrupt already-hex'd colors); the plugin shapes the
> node and the result is returned as-is.

## Bound the size

### `scan_nodes_by_types` — pagination + count + instance enrichment
- **`limit`** / **`offset`**: page through results. The response includes
  `total` and `nextOffset` (null when done).
- **`countOnly`**: get just `{ total }` for an unbounded section.
- **INSTANCE enrichment**: each returned INSTANCE now carries
  `componentProperties` (variant state, e.g. `State=Disabled`) and
  `mainComponent` (`{ id, key, remote, name, componentSetKey }`) — so mapping an
  instance to its component variant no longer needs a second file. Enrichment is
  capped at **300 instances per call** (it costs one async resolve each); when a
  slice has more, `enrichmentTruncated: true` is returned — page with `limit` to
  enrich the rest.
- Response is now a **single structured JSON object** (`{ total, offset, returned,
  nextOffset, matchingNodes, searchedTypes }`), not a mix of status strings and
  a JSON array.

```jsonc
scan_nodes_by_types({ nodeId:"24:4354", types:["INSTANCE"], countOnly:true })   // → { total: 762 }
scan_nodes_by_types({ nodeId:"24:4354", types:["INSTANCE"], limit:50, offset:0 }) // → first 50, nextOffset:50
```

### `get_local_components` — pagination + count
Now returns components **and component sets** with `{ id, name, type, key, remote }`,
and supports `limit` / `offset` / `countOnly` (`{ total, count, offset, nextOffset, components }`).

## Discover & resolve

### `list_pages` / `set_current_page` / `get_document_info(pageId)`  (page navigation)
- **`list_pages`** → `{ currentPageId, pages: [{ id, name, childCount }] }` —
  discover non-open pages (e.g. the foundation `Button` set's page).
- **`set_current_page({ pageId })`** → switches the current page, so every
  current-page-scoped tool (scan, selection, …) can reach it.
- **`get_document_info({ pageId? })`** → inspect a specific page without
  switching; its response also lists all pages for discovery.

### `get_node_by_key` — key → live node
Bridge a catalog **key** (from `get_design_system_info` / `get_local_components`)
to a live node id, so you can go straight to `get_node_info` / `export_node_as_image`:
- looks up a **local** component/set with that key first,
- else **imports** the published component (`importComponentByKeyAsync`) or
  style (`importStyleByKeyAsync`) by key.
- Returns `{ found, id, type, remote, source, key, name? }` (or `{ found:false }`).

## Resilience to unclassifiable nodes

Some files contain a node type this plugin's Figma API can't classify (a widget
or a newer Figma feature node); reading that node's `.children` throws
`Internal Figma error: Unknown node type ... getPublicNodeType`. That node
itself can't be read (the classification is internal to Figma), but a single
such node no longer fails a whole operation:
- tree walks (`scan_nodes_by_types`, `scan_design_usage`) **skip that subtree
  and continue**, listing what they skipped under `skippedContainers`.
- `list_pages` / `get_document_info` report `childrenReadable: false` (and
  `childCount: null`) for the affected page instead of erroring.

So results are partial-but-honest: you can see everything readable plus exactly
what was skipped.

## Build / reload
- **MCP server** runs from source — new params/tools appear on the next session.
- **Plugin** (`code.js`): re-run it in Figma so the new handlers load.
- **WebSocket relay** (`bun socket`) must be running.
