// This is the main code file for the Cursor MCP Figma plugin
// It handles Figma API commands

// Plugin state
const state = {
  serverPort: 3055, // Default port
};


// Helper function for progress updates
async function sendProgressUpdate(
  commandId,
  commandType,
  status,
  progress,
  totalItems,
  processedItems,
  message,
  payload = null
) {
  const update = {
    type: "command_progress",
    commandId,
    commandType,
    status,
    progress,
    totalItems,
    processedItems,
    message,
    timestamp: Date.now(),
  };

  // Add optional chunk information if present
  if (payload) {
    if (
      payload.currentChunk !== undefined &&
      payload.totalChunks !== undefined
    ) {
      update.currentChunk = payload.currentChunk;
      update.totalChunks = payload.totalChunks;
      update.chunkSize = payload.chunkSize;
    }
    update.payload = payload;
  }

  // Send to UI
  figma.ui.postMessage(update);
  console.log(`Progress update: ${status} - ${progress}% - ${message}`);

  // Yield so the Figma plugin sandbox flushes postMessage to ui.html
  // before the next iteration begins
  await new Promise((resolve) => setTimeout(resolve, 0));

  return update;
}

// Show UI
figma.showUI(__html__, { width: 350, height: 600 });

// Initialize anonymous analytics client_id (persisted via clientStorage)
(async () => {
  try {
    let clientId = await figma.clientStorage.getAsync("analyticsClientId");
    if (!clientId) {
      clientId =
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10);
      await figma.clientStorage.setAsync("analyticsClientId", clientId);
    }
    figma.ui.postMessage({ type: "analytics-client-id", clientId });
  } catch (e) {
    console.error("analytics init failed:", e);
  }
})();

// Plugin commands from UI
figma.ui.onmessage = async (msg) => {
  switch (msg.type) {
    case "update-settings":
      updateSettings(msg);
      break;
    case "notify":
      figma.notify(msg.message);
      break;
    case "close-plugin":
      figma.closePlugin();
      break;
    case "execute-command":
      // Execute commands received from UI (which gets them from WebSocket)
      try {
        // Emitted from the plugin main thread (not the UI iframe), so the relay
        // can separate time spent waiting for Figma from actual execution time.
        figma.ui.postMessage({
          type: "command-started",
          id: msg.id,
          command: msg.command,
          timestamp: Date.now(),
        });
        const result = await handleCommand(msg.command, msg.params);
        figma.ui.postMessage({
          type: "command-result",
          id: msg.id,
          result,
        });
      } catch (error) {
        figma.ui.postMessage({
          type: "command-error",
          id: msg.id,
          error: error.message || "Error executing command",
        });
      }
      break;
    case "request-doc-meta":
      // UI wants the document identity to announce it to the relay server
      try {
        figma.ui.postMessage({ type: "doc-meta", meta: getDocMeta() });
      } catch (e) {}
      break;
  }
};

// Lightweight document identity so the relay/console can tell channels apart
function getDocMeta() {
  let pageCount = 1;
  try {
    pageCount = figma.root.children.length;
  } catch (e) {}
  // currentPage.children can throw if the page holds a node type this plugin
  // API can't classify — guard it so the document still gets announced (this
  // was silently aborting the announce, leaving the channel doc-less).
  let nodeCount = null;
  try {
    nodeCount = figma.currentPage.children.length;
  } catch (e) {}
  return {
    documentName: figma.root.name,
    fileKey: figma.fileKey || null,
    page: figma.currentPage.name,
    pageId: figma.currentPage.id,
    nodeCount: nodeCount,
    pageCount,
  };
}

// Re-announce when the user switches pages so the console stays accurate
figma.on("currentpagechange", () => {
  try {
    figma.ui.postMessage({ type: "doc-meta", meta: getDocMeta() });
  } catch (e) {}
});

// Listen for plugin commands from menu
figma.on("run", ({ command }) => {
  figma.ui.postMessage({ type: "auto-connect" });
});

// Update plugin settings
function updateSettings(settings) {
  if (settings.serverPort) {
    state.serverPort = settings.serverPort;
  }

  figma.clientStorage.setAsync("settings", {
    serverPort: state.serverPort,
  });
}

// Handle commands from UI
async function handleCommand(command, params) {
  switch (command) {
    case "get_document_info":
      return await getDocumentInfo(params);
    case "get_selection":
      return await getSelection();
    case "list_pages":
      return await listPages();
    case "set_current_page":
      return await setCurrentPage(params);
    case "get_node_by_key":
      return await getNodeByKey(params);
    case "diagnose_pages":
      return await diagnosePages(params);
    case "search_nodes":
      return await searchNodes(params);
    case "get_file_outline":
      return await getFileOutline();
    case "get_node_info":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getNodeInfo(params.nodeId, params.fields, params.maxDepth, params.includeHash);
    case "get_frame_context":
      return await getFrameContext(params);
    case "get_nodes_info":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getNodesInfo(params.nodeIds, params.fields, params.maxDepth, params.includeHash);
    case "read_my_design":
      return await readMyDesign();
    case "create_rectangle":
      return await createRectangle(params);
    case "create_frame":
      return await createFrame(params);
    case "create_text":
      return await createText(params);
    case "set_fill_color":
      return await setFillColor(params);
    case "set_image_fill_from_node":
      return await setImageFillFromNode(params);
    case "get_node_geometry":
      return await getNodeGeometry(params);
    case "set_image_fill_from_bytes":
      return await setImageFillFromBytes(params);
    case "set_stroke_color":
      return await setStrokeColor(params);
    case "move_node":
      return await moveNode(params);
    case "resize_node":
      return await resizeNode(params);
    case "delete_node":
      return await deleteNode(params);
    case "delete_multiple_nodes":
      return await deleteMultipleNodes(params);
    case "get_styles":
      return await getStyles();
    case "get_local_components":
      return await getLocalComponents(params);
    // case "get_team_components":
    //   return await getTeamComponents();
    case "create_component_instance":
      return await createComponentInstance(params);
    case "export_node_as_image":
      return await exportNodeAsImage(params);
    case "set_corner_radius":
      return await setCornerRadius(params);
    case "set_text_content":
      return await setTextContent(params);
    case "clone_node":
      return await cloneNode(params);
    case "scan_text_nodes":
      return await scanTextNodes(params);
    case "set_multiple_text_contents":
      return await setMultipleTextContents(params);
    case "get_annotations":
      return await getAnnotations(params);
    case "set_annotation":
      return await setAnnotation(params);
    case "scan_nodes_by_types":
      return await scanNodesByTypes(params);
    case "set_multiple_annotations":
      return await setMultipleAnnotations(params);
    case "get_instance_overrides":
      // Check if instanceNode parameter is provided
      if (params && params.instanceNodeId) {
        // Get the instance node by ID
        const instanceNode = await figma.getNodeByIdAsync(params.instanceNodeId);
        if (!instanceNode) {
          throw new Error(`Instance node not found with ID: ${params.instanceNodeId}`);
        }
        return await getInstanceOverrides(instanceNode);
      }
      // Call without instance node if not provided
      return await getInstanceOverrides();

    case "set_instance_overrides":
      // Check if instanceNodeIds parameter is provided
      if (params && params.targetNodeIds) {
        // Validate that targetNodeIds is an array
        if (!Array.isArray(params.targetNodeIds)) {
          throw new Error("targetNodeIds must be an array");
        }

        // Get the instance nodes by IDs
        const targetNodes = await getValidTargetInstances(params.targetNodeIds);
        if (!targetNodes.success) {
          figma.notify(targetNodes.message);
          return { success: false, message: targetNodes.message };
        }

        if (params.sourceInstanceId) {

          // get source instance data
          let sourceInstanceData = null;
          sourceInstanceData = await getSourceInstanceData(params.sourceInstanceId);

          if (!sourceInstanceData.success) {
            figma.notify(sourceInstanceData.message);
            return { success: false, message: sourceInstanceData.message };
          }
          return await setInstanceOverrides(targetNodes.targetInstances, sourceInstanceData);
        } else {
          throw new Error("Missing sourceInstanceId parameter");
        }
      }
    case "set_layout_mode":
      return await setLayoutMode(params);
    case "set_padding":
      return await setPadding(params);
    case "set_axis_align":
      return await setAxisAlign(params);
    case "set_layout_sizing":
      return await setLayoutSizing(params);
    case "set_item_spacing":
      return await setItemSpacing(params);
    case "get_reactions":
      if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
        throw new Error("Missing or invalid nodeIds parameter");
      }
      return await getReactions(params.nodeIds, params.maxDepth);
    case "get_motion":
      if (!params || !params.nodeId) {
        throw new Error("Missing nodeId parameter");
      }
      return await getMotion(params.nodeId, params.maxDepth);
    case "set_default_connector":
      return await setDefaultConnector(params);
    case "create_connections":
      return await createConnections(params);
    case "set_node_names":
      return await setNodeNames(params);
    case "copy_image_fill":
      return await copyImageFill(params);
    case "set_node_data":
      return await setNodeData(params);
    case "get_node_data":
      return await getNodeData(params);
    case "delete_node_data":
      return await deleteNodeData(params);
    case "detach_instance":
      return await detachInstance(params);
    case "mirror_horizontal":
      return await mirrorHorizontal(params);
    case "set_text_align":
      return await setTextAlign(params);
    case "get_text_segments":
      return await getTextSegments(params);
    case "set_text_segments":
      return await setTextSegments(params);
    case "create_section":
      return await createSection(params);
    case "create_component_from_node":
      return await createComponentFromNode(params);
    case "set_focus":
      return await setFocus(params);
    case "set_selections":
      return await setSelections(params);
    case "get_design_system_info":
      return await getDesignSystemInfo(params);
    case "get_nodes_design_info":
      return await getNodesDesignInfo(params);
    case "scan_design_usage":
      return await scanDesignUsage(params);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ===========================================================================
// Design-system usage analysis
// ---------------------------------------------------------------------------
// These handlers expose the *provenance* of rendered values — which library
// component / variable token / style a node references — so an analysis
// session can measure design-system reuse by matching shared `key`s between a
// Foundation (library) file and a Product (consumer) file.
//
// Matching principle: a library-linked asset shares the SAME `key` in the
// source and consuming files. Copy-pasted assets get a different key and so
// are correctly counted as "not reused".
// ===========================================================================

// Resolve a Figma color/number/etc. variable value for a single mode.
function formatVariableValue(raw, resolvedType) {
  if (raw === undefined || raw === null) return null;
  // Alias to another variable (e.g. semantic token -> primitive token)
  if (typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
    return { type: "alias", id: raw.id };
  }
  if (resolvedType === "COLOR" && typeof raw === "object" && "r" in raw) {
    return { type: "color", hex: rgbaToHex(raw), rgba: raw };
  }
  return { type: (resolvedType || typeof raw).toLowerCase(), value: raw };
}

// A per-call resolver with caches so shared tokens/styles/components aren't
// looked up repeatedly (critical when scanning ~1000+ nodes).
function makeDsResolver(resolveNames) {
  const varCache = new Map();
  const styleCache = new Map();
  const compCache = new Map();
  return {
    async variable(id) {
      if (!id) return null;
      if (varCache.has(id)) return varCache.get(id);
      let out = null;
      try {
        const v = await figma.variables.getVariableByIdAsync(id);
        if (v) {
          out = { id: v.id, key: v.key, resolvedType: v.resolvedType };
          if (resolveNames) out.name = v.name;
        }
      } catch (e) {}
      varCache.set(id, out);
      return out;
    },
    async style(id) {
      if (!id || typeof id !== "string") return null; // skip figma.mixed (Symbol)
      if (styleCache.has(id)) return styleCache.get(id);
      let out = null;
      try {
        const s = await figma.getStyleByIdAsync(id);
        if (s) {
          out = { id: s.id, key: s.key, remote: !!s.remote, styleType: s.type };
          if (resolveNames) out.name = s.name;
        }
      } catch (e) {}
      styleCache.set(id, out);
      return out;
    },
    async mainComponent(instanceNode) {
      let mc = null;
      try {
        mc = await instanceNode.getMainComponentAsync();
      } catch (e) {
        return null;
      }
      if (!mc) return null; // detached / missing
      if (compCache.has(mc.id)) return compCache.get(mc.id);
      const out = { id: mc.id, key: mc.key || null, remote: !!mc.remote };
      if (resolveNames) out.name = mc.name;
      try {
        const parent = mc.parent;
        if (parent && parent.type === "COMPONENT_SET") {
          out.componentSetId = parent.id;
          out.componentSetKey = parent.key || null;
          if (resolveNames) out.componentSetName = parent.name;
        }
      } catch (e) {}
      compCache.set(mc.id, out);
      return out;
    },
  };
}

// Extract variable bindings (property -> [{id,key,name?,resolvedType}])
async function extractBoundVariables(node, resolver) {
  const bv = node.boundVariables;
  if (!bv || typeof bv !== "object") return null;
  const out = {};
  for (const prop of Object.keys(bv)) {
    const val = bv[prop];
    const aliases = Array.isArray(val) ? val : [val];
    const resolved = [];
    for (const a of aliases) {
      if (a && a.id) {
        const r = await resolver.variable(a.id);
        if (r) resolved.push(r);
      }
    }
    if (resolved.length) out[prop] = resolved;
  }
  return Object.keys(out).length ? out : null;
}

// Extract style references (fill/stroke/text/effect/grid -> {id,key,name?,remote})
async function extractStyleRefs(node, resolver) {
  const out = {};
  const tryStyle = async (key, id) => {
    const r = await resolver.style(id);
    if (r) out[key] = r;
  };
  if ("fillStyleId" in node) await tryStyle("fill", node.fillStyleId);
  if ("strokeStyleId" in node) await tryStyle("stroke", node.strokeStyleId);
  if (node.type === "TEXT" && "textStyleId" in node) await tryStyle("text", node.textStyleId);
  if ("effectStyleId" in node) await tryStyle("effect", node.effectStyleId);
  if ("gridStyleId" in node) await tryStyle("grid", node.gridStyleId);
  return Object.keys(out).length ? out : null;
}

// Does this node have a raw (untokenized, unstyled) SOLID fill? Used to tell
// "uses a color token/style" apart from "hard-coded color".
function hasRawSolidFill(node) {
  try {
    const fills = node.fills;
    if (!Array.isArray(fills)) return false; // figma.mixed or none
    const hasSolid = fills.some((p) => p && p.type === "SOLID" && p.visible !== false);
    if (!hasSolid) return false;
    const styled = "fillStyleId" in node && typeof node.fillStyleId === "string" && node.fillStyleId;
    const bound = node.boundVariables && node.boundVariables.fills;
    return !styled && !bound;
  } catch (e) {
    return false;
  }
}

// Build a design-system record for a single node (null sections omitted).
async function nodeDesignInfo(node, resolver) {
  const rec = { id: node.id, name: node.name, type: node.type };
  if (node.type === "INSTANCE") {
    rec.component = await resolver.mainComponent(node); // {key, remote, ...} or null (detached)
  }
  const styles = await extractStyleRefs(node, resolver);
  if (styles) rec.styles = styles;
  const bvs = await extractBoundVariables(node, resolver);
  if (bvs) rec.boundVariables = bvs;
  return rec;
}

// --- Foundation catalog: components + styles + variables (with keys) -------
async function getDesignSystemInfo(params) {
  const {
    includeVariableValues = true,
    resolveNames = true,
    commandId = generateCommandId(),
  } = params || {};

  await sendProgressUpdate(commandId, "get_design_system_info", "started", 0, 4, 0, "Loading pages...", null);
  await figma.loadAllPagesAsync(); // components can live on any page

  // Components & component sets (with keys for cross-file matching)
  const compNodes = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
  const components = compNodes.map((c) => {
    const entry = { id: c.id, key: "key" in c ? c.key || null : null, name: c.name, type: c.type, remote: !!c.remote };
    if (c.type === "COMPONENT" && c.parent && c.parent.type === "COMPONENT_SET") {
      entry.componentSetId = c.parent.id;
      entry.componentSetKey = c.parent.key || null;
    }
    return entry;
  });
  await sendProgressUpdate(commandId, "get_design_system_info", "in_progress", 35, 4, 1, `Found ${components.length} components/sets`, null);

  // Styles (already key-bearing)
  const mapStyle = (s) => ({ id: s.id, key: s.key, name: s.name, remote: !!s.remote });
  const paintStyles = (await figma.getLocalPaintStylesAsync()).map(mapStyle);
  const textStyles = (await figma.getLocalTextStylesAsync()).map(mapStyle);
  const effectStyles = (await figma.getLocalEffectStylesAsync()).map(mapStyle);
  const gridStyles = (await figma.getLocalGridStylesAsync()).map(mapStyle);
  await sendProgressUpdate(commandId, "get_design_system_info", "in_progress", 60, 4, 2, "Collected styles", null);

  // Variables + collections (the part get_styles is missing)
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collById = {};
  const variableCollections = collections.map((c) => {
    collById[c.id] = c;
    return {
      id: c.id,
      key: c.key,
      name: c.name,
      defaultModeId: c.defaultModeId,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      variableCount: c.variableIds.length,
    };
  });
  const localVars = await figma.variables.getLocalVariablesAsync();
  const variables = localVars.map((v) => {
    const coll = collById[v.variableCollectionId];
    const entry = {
      id: v.id,
      key: v.key,
      name: v.name,
      resolvedType: v.resolvedType,
      collectionId: v.variableCollectionId,
      collectionName: coll ? coll.name : null,
    };
    if (includeVariableValues && coll) {
      entry.valuesByMode = {};
      for (const m of coll.modes) {
        entry.valuesByMode[m.name] = formatVariableValue(v.valuesByMode[m.modeId], v.resolvedType);
      }
    }
    return entry;
  });
  await sendProgressUpdate(commandId, "get_design_system_info", "completed", 100, 4, 4, `Done: ${components.length} components, ${variables.length} variables`, null);

  return {
    components: { count: components.length, items: components },
    styles: {
      paint: paintStyles,
      text: textStyles,
      effect: effectStyles,
      grid: gridStyles,
    },
    variableCollections,
    variables: { count: variables.length, items: variables },
    commandId,
  };
}

// --- Per-node design-system bindings for an explicit set of nodes ----------
async function getNodesDesignInfo(params) {
  const { nodeIds, resolveNames = true } = params || {};
  if (!nodeIds || !Array.isArray(nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter (expected an array)");
  }
  const resolver = makeDsResolver(resolveNames);
  const results = [];
  for (const id of nodeIds) {
    let node = null;
    try {
      node = await figma.getNodeByIdAsync(id);
    } catch (e) {}
    if (!node) {
      results.push({ id, error: "not found" });
      continue;
    }
    results.push(await nodeDesignInfo(node, resolver));
  }
  return { count: results.length, nodes: results };
}

// --- Bulk scan of a subtree: aggregated usage summary (+ optional per-node)-
async function scanDesignUsage(params) {
  const {
    nodeId,
    chunkSize = 200,
    includeNodes = false,
    resolveNames = true,
    commandId = generateCommandId(),
  } = params || {};

  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) {
    await sendProgressUpdate(commandId, "scan_design_usage", "error", 0, 0, 0, `Node ${nodeId} not found`, { error: "not found" });
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Flatten the subtree (sync tree walk; nodes are already loaded in-page).
  // Reading `.children` can throw on a node type this plugin API can't
  // classify; skip that subtree (and record it) rather than failing the scan.
  const all = [];
  const skippedContainers = [];
  (function walk(n) {
    all.push(n);
    if ("children" in n) {
      let kids = null;
      try {
        kids = n.children;
      } catch (e) {
        skippedContainers.push({ id: n.id, name: n.name, type: n.type });
      }
      if (kids) for (const c of kids) walk(c);
    }
  })(root);
  const total = all.length;
  const totalChunks = Math.max(1, Math.ceil(total / chunkSize));

  const resolver = makeDsResolver(resolveNames);

  // Aggregation buckets keyed by the matchable identifier (`key`)
  const summary = {
    instances: { total: 0, remote: 0, local: 0, detached: 0, byComponentKey: {} },
    styles: { fill: {}, text: {}, effect: {}, stroke: {}, grid: {} },
    variables: { totalBoundProps: 0, byVariableKey: {} },
    fills: { tokenizedOrStyled: 0, rawSolid: 0 },
  };
  const nodes = [];
  const SAMPLE_CAP = 8;

  const bump = (bucket, key, meta, nodeId) => {
    if (!key) key = "(no-key)";
    let e = bucket[key];
    if (!e) { e = bucket[key] = Object.assign({ count: 0, samples: [] }, meta); }
    e.count++;
    if (e.samples.length < SAMPLE_CAP) e.samples.push(nodeId);
  };

  let processed = 0;
  await sendProgressUpdate(commandId, "scan_design_usage", "started", 0, total, 0, `Scanning ${total} nodes...`, null);

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = all.slice(i, Math.min(i + chunkSize, total));
    for (const node of chunk) {
      const rec = await nodeDesignInfo(node, resolver);

      if (node.type === "INSTANCE") {
        summary.instances.total++;
        if (rec.component) {
          if (rec.component.remote) summary.instances.remote++; else summary.instances.local++;
          bump(summary.instances.byComponentKey, rec.component.key,
            { remote: rec.component.remote, name: rec.component.name, componentSetKey: rec.component.componentSetKey }, node.id);
        } else {
          summary.instances.detached++;
        }
      }

      if (rec.styles) {
        for (const slot of Object.keys(rec.styles)) {
          const s = rec.styles[slot];
          if (summary.styles[slot]) bump(summary.styles[slot], s.key, { name: s.name, remote: s.remote }, node.id);
        }
      }

      if (rec.boundVariables) {
        for (const prop of Object.keys(rec.boundVariables)) {
          for (const v of rec.boundVariables[prop]) {
            summary.variables.totalBoundProps++;
            bump(summary.variables.byVariableKey, v.key, { name: v.name, resolvedType: v.resolvedType }, node.id);
          }
        }
      }

      // Color-token coverage signal
      const fillStyled = rec.styles && rec.styles.fill;
      const fillBound = rec.boundVariables && rec.boundVariables.fills;
      if (fillStyled || fillBound) summary.fills.tokenizedOrStyled++;
      else if (hasRawSolidFill(node)) summary.fills.rawSolid++;

      if (includeNodes && (rec.component || rec.styles || rec.boundVariables)) nodes.push(rec);
      processed++;
    }

    const pct = Math.round((processed / total) * 100);
    await sendProgressUpdate(commandId, "scan_design_usage", "in_progress", pct, total, processed,
      `Processed ${processed}/${total} nodes (${Math.ceil((i + chunkSize) / chunkSize)}/${totalChunks} chunks)`, null);
    await delay(0); // yield to keep Figma responsive
  }

  await sendProgressUpdate(commandId, "scan_design_usage", "completed", 100, total, processed, `Scan complete: ${total} nodes`, null);

  return {
    scannedNodes: total,
    summary,
    skippedContainers: skippedContainers, // subtrees skipped (unclassifiable node type)
    nodes: includeNodes ? nodes : undefined,
    commandId,
  };
}

// Command implementations

async function getDocumentInfo(params) {
  // Optionally inspect a specific (possibly non-open) page by id.
  let page = figma.currentPage;
  if (params && params.pageId) {
    const requested = await figma.getNodeByIdAsync(params.pageId);
    if (requested && requested.type === "PAGE") {
      page = requested;
    }
  }
  await page.loadAsync();
  // Reading .children can throw ("Unknown node type ... getPublicNodeType") if
  // the page contains a node type this plugin API version can't classify;
  // degrade gracefully instead of failing the whole call.
  let children = [];
  let childCount = null;
  let childrenReadable = true;
  try {
    children = page.children.map((node) => {
      const entry = { id: node.id, name: node.name, type: node.type };
      // Flag reference captures (image-fill rectangles) so a sync workflow can
      // auto-separate them from real design frames.
      if (nodeHasImageFill(node)) entry.hasImageFill = true;
      return entry;
    });
    childCount = children.length;
  } catch (e) {
    childrenReadable = false;
  }
  return {
    name: page.name,
    id: page.id,
    type: page.type,
    children: children,
    childrenReadable: childrenReadable,
    currentPage: {
      id: page.id,
      name: page.name,
      childCount: childCount,
    },
    // All pages in the file (names/ids) so other pages are discoverable.
    pages: figma.root.children.map((p) => ({ id: p.id, name: p.name })),
  };
}

// List all pages in the file (enables discovery of non-open pages).
async function listPages() {
  await figma.loadAllPagesAsync();
  return {
    currentPageId: figma.currentPage.id,
    pages: figma.root.children.map((p) => {
      const entry = { id: p.id, name: p.name };
      // Reading .children can throw ("Unknown node type ... getPublicNodeType")
      // when a page contains a node type this plugin API version can't classify
      // (e.g. a widget / a newer Figma feature node). Surface that explicitly
      // rather than silently reporting an empty page.
      try {
        entry.childCount = p.children.length;
      } catch (e) {
        entry.childCount = null;
        entry.childrenReadable = false;
      }
      return entry;
    }),
  };
}

// Build a "Page > Section > ... > Parent" path string for a node (parents only,
// node itself excluded) so a match can be located without extra round-trips.
function nodePathString(node, page) {
  const parts = [];
  let cur = node.parent;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  parts.unshift(page.name);
  return parts.join(" > ");
}

// Search the whole file (or a single page) for nodes whose name contains the
// query (case-insensitive), in ONE call — instead of walking pages one by one
// with get_document_info / scan_text_nodes.
async function searchNodes(params) {
  const { query, types, pageId, limit } = params || {};
  if (!query || typeof query !== "string") {
    throw new Error("Missing query parameter");
  }
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const q = query.toLowerCase();

  let pages;
  if (pageId) {
    const page = await figma.getNodeByIdAsync(pageId);
    if (!page || page.type !== "PAGE") {
      throw new Error(`Page not found with ID: ${pageId}`);
    }
    await page.loadAsync();
    pages = [page];
  } else {
    // dynamic-page documentAccess: pages must be loaded before findAll.
    await figma.loadAllPagesAsync();
    pages = figma.root.children;
  }

  const prevSkip = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = true; // big speedup on instance-heavy files
  const matches = [];
  const unreadablePages = [];
  let totalMatches = 0;
  let totalScannedPages = 0;
  let truncated = false;
  try {
    for (const page of pages) {
      totalScannedPages++;
      let found;
      try {
        if (Array.isArray(types) && types.length > 0) {
          found = page
            .findAllWithCriteria({ types })
            .filter((n) => n.name.toLowerCase().indexOf(q) !== -1);
        } else {
          found = page.findAll((n) => n.name.toLowerCase().indexOf(q) !== -1);
        }
      } catch (e) {
        // A page containing an unclassifiable node type can throw; skip it
        // (see diagnose_pages) instead of failing the whole search.
        unreadablePages.push({ id: page.id, name: page.name });
        continue;
      }
      totalMatches += found.length;
      for (const node of found) {
        if (matches.length >= max) {
          truncated = true;
          break;
        }
        matches.push({
          id: node.id,
          name: node.name,
          type: node.type,
          pageId: page.id,
          pageName: page.name,
          path: nodePathString(node, page),
        });
      }
      if (truncated) break; // early stop on large files once the limit is hit
    }
  } finally {
    figma.skipInvisibleInstanceChildren = prevSkip;
  }

  const result = {
    query: query,
    totalMatches: totalMatches,
    truncated: truncated,
    totalScannedPages: totalScannedPages,
    totalPages: pages.length,
    matches: matches,
  };
  if (truncated) {
    // totalMatches only covers scanned pages when we stopped early.
    result.note = `Stopped after ${totalScannedPages}/${pages.length} pages once the limit of ${max} matches was reached; totalMatches counts scanned pages only.`;
  }
  if (unreadablePages.length) result.unreadablePages = unreadablePages;
  return result;
}

// One-call outline of the whole file: every page plus its top-level children
// (id/name/type only) — replaces N get_document_info calls (one per page).
async function getFileOutline() {
  await figma.loadAllPagesAsync();
  const MAX_CHILDREN_PER_PAGE = 200;
  return {
    currentPageId: figma.currentPage.id,
    pageCount: figma.root.children.length,
    pages: figma.root.children.map((p) => {
      const entry = { id: p.id, name: p.name };
      try {
        entry.childCount = p.children.length;
        const slice =
          entry.childCount > MAX_CHILDREN_PER_PAGE
            ? p.children.slice(0, MAX_CHILDREN_PER_PAGE)
            : p.children;
        entry.children = slice.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
        }));
        if (entry.childCount > MAX_CHILDREN_PER_PAGE) entry.truncated = true;
      } catch (e) {
        // Page with a node type this plugin API can't classify (see diagnose_pages).
        entry.childCount = null;
        entry.children = [];
        entry.childrenReadable = false;
      }
      return entry;
    }),
  };
}

// Switch the current page so every current-page-scoped tool can reach it.
async function setCurrentPage(params) {
  const { pageId } = params || {};
  if (!pageId) throw new Error("Missing pageId parameter");
  const page = await figma.getNodeByIdAsync(pageId);
  if (!page || page.type !== "PAGE") {
    throw new Error(`Page not found with ID: ${pageId}`);
  }
  await figma.setCurrentPageAsync(page);
  return { success: true, currentPageId: page.id, name: page.name };
}

// Resolve a design-system `key` (from the catalog) to a live node id, so an
// agent can go straight from a catalog key to get_node_info/export.
async function getNodeByKey(params) {
  const { key, resolveNames = true } = params || {};
  if (!key) throw new Error("Missing key parameter");

  // 1) Local component / component-set with this key (same file).
  await figma.loadAllPagesAsync();
  const locals = figma.root.findAllWithCriteria({
    types: ["COMPONENT", "COMPONENT_SET"],
  });
  for (const c of locals) {
    if ("key" in c && c.key === key) {
      return {
        found: true,
        source: "local",
        id: c.id,
        name: resolveNames ? c.name : undefined,
        type: c.type,
        remote: false,
        key: c.key,
      };
    }
  }

  // 2) Published library component imported by key.
  try {
    const comp = await figma.importComponentByKeyAsync(key);
    if (comp) {
      return {
        found: true,
        source: "imported-component",
        id: comp.id,
        name: resolveNames ? comp.name : undefined,
        type: comp.type,
        remote: !!comp.remote,
        key: comp.key,
      };
    }
  } catch (e) {}

  // 3) Published library style imported by key.
  try {
    const style = await figma.importStyleByKeyAsync(key);
    if (style) {
      return {
        found: true,
        source: "imported-style",
        id: style.id,
        name: resolveNames ? style.name : undefined,
        styleType: style.type,
        remote: !!style.remote,
        key: style.key,
      };
    }
  } catch (e) {}

  return { found: false, key: key };
}

// Diagnose, per page, where an unclassifiable node lives. We can't read the
// node's type from the plugin API (Figma refuses a public type for it), but we
// can locate the container whose `.children` throws, and try a REST export of
// that container — which sometimes surfaces the child's type string.
async function diagnosePages(params) {
  // deep=false (default): only check each page's DIRECT children (the observed
  //   failure mode — page.children throwing). Fast, doesn't block on huge files.
  // deep=true: also recurse to find unclassifiable nodes nested deeper (slow).
  const { tryExport = true, deep = false, commandId = generateCommandId() } =
    params || {};

  sendProgressUpdate(commandId, "diagnose_pages", "started", 0, 1, 0, "Loading pages...", null);
  await figma.loadAllPagesAsync();

  const allPages = figma.root.children;
  const totalP = allPages.length;
  const pages = [];

  for (let pi = 0; pi < totalP; pi++) {
    const page = allPages[pi];
    console.log(`[diagnose_pages] ${pi + 1}/${totalP}: "${page.name}"`);
    sendProgressUpdate(
      commandId, "diagnose_pages", "in_progress",
      Math.round((pi / totalP) * 80), totalP, pi,
      `Scanning page "${page.name}" (${pi + 1}/${totalP})`, null
    );

    const entry = {
      id: page.id, name: page.name, readable: true,
      childCount: null, skippedContainers: [],
    };
    try {
      await page.loadAsync();
    } catch (e) {
      entry.loadError = String((e && e.message) || e);
    }

    // Direct children (the level that threw in list_pages)
    let topKids = null;
    try {
      topKids = page.children;
      entry.childCount = topKids.length;
    } catch (e) {
      entry.readable = false;
      entry.skippedContainers.push({ id: page.id, name: page.name, type: page.type, level: "page" });
    }

    // Optional deep walk for nodes nested below readable containers
    if (deep && topKids) {
      (function walk(n) {
        if ("children" in n) {
          let kids = null;
          try {
            kids = n.children;
          } catch (e) {
            entry.readable = false;
            entry.skippedContainers.push({ id: n.id, name: n.name, type: n.type, level: "nested" });
          }
          if (kids) for (const c of kids) walk(c);
        }
      })(page);
    }

    pages.push(entry);
  }

  // Best-effort: identify the offending child node's type via a REST export of
  // each skipped container (a different code path than the live .children
  // getter; may also throw — reported per container).
  if (tryExport) {
    sendProgressUpdate(commandId, "diagnose_pages", "in_progress", 85, totalP, totalP, "Identifying offending nodes via export...", null);
    for (const p of pages) {
      for (const sc of p.skippedContainers) {
        try {
          const node = await figma.getNodeByIdAsync(sc.id);
          if (!node) { sc.exportOk = false; continue; }
          const exp = await node.exportAsync({ format: "JSON_REST_V1" });
          const kids = (exp.document && exp.document.children) || [];
          sc.exportOk = true;
          sc.children = kids.map((k) => ({ id: k.id, name: k.name, type: k.type }));
          sc.childTypes = kids
            .map((k) => k.type)
            .filter((t, i, a) => a.indexOf(t) === i);
          console.log(`[diagnose_pages] export "${sc.name}" childTypes: ${JSON.stringify(sc.childTypes)}`);
        } catch (e) {
          sc.exportOk = false;
          sc.exportError = String((e && e.message) || e);
          console.log(`[diagnose_pages] export "${sc.name}" FAILED: ${sc.exportError}`);
        }
      }
    }
  }

  const unreadablePages = pages.filter((p) => !p.readable).length;
  sendProgressUpdate(commandId, "diagnose_pages", "completed", 100, totalP, totalP, `Done. ${unreadablePages} unreadable page(s).`, null);
  return { pages: pages, unreadablePages: unreadablePages, deep: deep };
}

async function getSelection() {
  return {
    selectionCount: figma.currentPage.selection.length,
    selection: figma.currentPage.selection.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
    })),
  };
}

function rgbaToHex(color) {
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = color.a !== undefined ? Math.round(color.a * 255) : 255;

  if (a === 255) {
    return (
      "#" +
      [r, g, b]
        .map((x) => {
          return x.toString(16).padStart(2, "0");
        })
        .join("")
    );
  }

  return (
    "#" +
    [r, g, b, a]
      .map((x) => {
        return x.toString(16).padStart(2, "0");
      })
      .join("")
  );
}

function filterFigmaNode(node, opts) {
  opts = opts || {};
  var fields = opts.fields;       // array of top-level fields to keep (besides id/name/type)
  var maxDepth = opts.maxDepth;   // max levels of children to expand (undefined = unlimited)
  var depth = opts.depth || 0;

  if (node.type === "VECTOR") {
    return null;
  }

  var filtered = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  // Instance provenance (variant state + main component node id) — lets an
  // agent map an instance to its component variant in one pass.
  if (node.componentProperties) {
    filtered.componentProperties = node.componentProperties;
  }
  if (node.componentId) {
    filtered.componentId = node.componentId;
  }

  if (node.fills && node.fills.length > 0) {
    // Flag image fills so reference captures (screenshots/pasted images) can be
    // told apart from real design frames without inspecting raw paint data.
    if (node.fills.some((f) => f && f.type === "IMAGE")) {
      filtered.hasImageFill = true;
    }
    filtered.fills = node.fills.map((fill) => {
      var processedFill = Object.assign({}, fill);
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map(
          (stop) => {
            var processedStop = Object.assign({}, stop);
            if (processedStop.color) {
              processedStop.color = rgbaToHex(processedStop.color);
            }
            delete processedStop.boundVariables;
            return processedStop;
          }
        );
      }

      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke) => {
      var processedStroke = Object.assign({}, stroke);
      delete processedStroke.boundVariables;
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }

  if (node.children) {
    var wantChildren = !fields || fields.indexOf("children") !== -1;
    var underDepth = maxDepth === undefined || depth < maxDepth;
    if (wantChildren && underDepth) {
      filtered.children = node.children
        .map(function (child) {
          return filterFigmaNode(child, {
            fields: fields,
            maxDepth: maxDepth,
            depth: depth + 1,
          });
        })
        .filter(function (child) {
          return child !== null;
        });
    } else if (node.children.length) {
      // Children exist but were not expanded (depth limit or field selection);
      // surface the count so the caller knows to drill deeper.
      filtered.childCount = node.children.length;
    }
  }

  // Field selection: keep only id/name/type (+childCount) and requested fields.
  if (fields && fields.length) {
    var keep = { id: 1, name: 1, type: 1, childCount: 1, hasImageFill: 1, subtreeHash: 1 };
    for (var fi = 0; fi < fields.length; fi++) keep[fields[fi]] = 1;
    for (var fk in filtered) {
      if (Object.prototype.hasOwnProperty.call(filtered, fk) && !keep[fk]) {
        delete filtered[fk];
      }
    }
  }

  return filtered;
}

async function getNodeInfo(nodeId, fields, maxDepth, includeHash) {
  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  const response = await node.exportAsync({
    format: "JSON_REST_V1",
  });

  const out = filterFigmaNode(response.document, { fields: fields, maxDepth: maxDepth });
  if (includeHash && out) out.subtreeHash = computeSubtreeHash(node);
  return out;
}

async function getNodesInfo(nodeIds, fields, maxDepth, includeHash) {
  try {
    // Load all nodes in parallel
    const nodes = await Promise.all(
      nodeIds.map((id) => figma.getNodeByIdAsync(id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        const document = filterFigmaNode(response.document, { fields: fields, maxDepth: maxDepth });
        if (includeHash && document) document.subtreeHash = computeSubtreeHash(node);
        return {
          nodeId: node.id,
          document: document,
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

// ===========================================================================
// get_frame_context — one-shot, RN-ready digest of a screen subtree
// ---------------------------------------------------------------------------
// Returns a pruned node tree (OS chrome + hidden nodes removed) where each node
// carries only what a React Native implementation needs: relative bounds, text
// + typography, flex-friendly layout, semantic tokens, and an image-fill flag.
// Replaces the get_node_info + scan_text_nodes + get_nodes_design_info round
// trips with a single call.

const DEFAULT_CHROME_NAMES = [
  "status bar",
  "home indicator",
  "keyboard",
  "notch",
  "dynamic island",
];

// Normalize a node name for chrome matching: lowercase + strip non-alphanumerics
// so "Status Bar" / "HomeIndicator" / "status-bar" all collapse to one key.
// Matching is then EXACT (not substring), so real content like
// "Keyboard Shortcuts" is never mistaken for OS chrome.
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Figma auto-layout alignment -> CSS/RN flex equivalents.
function mapPrimaryAxis(v) {
  switch (v) {
    case "MIN": return "flex-start";
    case "MAX": return "flex-end";
    case "CENTER": return "center";
    case "SPACE_BETWEEN": return "space-between";
    default: return v;
  }
}
function mapCounterAxis(v) {
  switch (v) {
    case "MIN": return "flex-start";
    case "MAX": return "flex-end";
    case "CENTER": return "center";
    case "BASELINE": return "baseline";
    default: return v;
  }
}

// Compact, resolved semantic tokens for one node (variable/style NAMES).
async function nodeTokens(node, resolver) {
  const tokens = {};
  try {
    const bv = await extractBoundVariables(node, resolver); // {prop:[{name,...}]}
    if (bv) {
      const pick = (k) => bv[k] && bv[k][0] && bv[k][0].name;
      const skip = {
        fills: 1, strokes: 1, cornerRadius: 1,
        topLeftRadius: 1, topRightRadius: 1,
        bottomLeftRadius: 1, bottomRightRadius: 1,
      };
      const fill = pick("fills"); if (fill) tokens.fill = fill;
      const stroke = pick("strokes"); if (stroke) tokens.stroke = stroke;
      const radius =
        pick("cornerRadius") || pick("topLeftRadius") ||
        pick("bottomLeftRadius") || pick("topRightRadius") ||
        pick("bottomRightRadius");
      if (radius) tokens.radius = radius;
      // Surface any other bound props (itemSpacing, padding*, fontSize, …).
      for (const k of Object.keys(bv)) {
        if (skip[k]) continue;
        const name = bv[k] && bv[k][0] && bv[k][0].name;
        if (name && tokens[k] === undefined) tokens[k] = name;
      }
    }
  } catch (e) {}
  try {
    const styles = await extractStyleRefs(node, resolver); // {fill,stroke,text,...:{name}}
    if (styles) {
      if (styles.text && styles.text.name) tokens.textStyle = styles.text.name;
      if (!tokens.fill && styles.fill && styles.fill.name) tokens.fillStyle = styles.fill.name;
      if (!tokens.stroke && styles.stroke && styles.stroke.name) tokens.strokeStyle = styles.stroke.name;
      if (styles.effect && styles.effect.name) tokens.effectStyle = styles.effect.name;
    }
  } catch (e) {}
  return Object.keys(tokens).length ? tokens : null;
}

async function getFrameContext(params) {
  const { nodeId, excludeChrome = true, includeHash = false } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) throw new Error(`Node not found with ID: ${nodeId}`);

  // Max levels of children to expand (undefined = unlimited). Matches the
  // filterFigmaNode / get_node_info convention: expand while depth < maxDepth.
  // Nodes cut off by the limit still appear, tagged with childCount + truncated.
  const maxDepth =
    params && Number.isFinite(params.maxDepth)
      ? Math.max(0, Math.floor(params.maxDepth))
      : undefined;

  const commandId = (params && params.commandId) || generateCommandId();
  const resolver = makeDsResolver(true);
  // Exact (normalized) chrome match — see normalizeName.
  const chrome = new Set(
    (Array.isArray(params && params.chromeNames) && params.chromeNames.length
      ? params.chromeNames
      : DEFAULT_CHROME_NAMES
    ).map(normalizeName)
  );
  let rb = { x: 0, y: 0 };
  try { if (root.absoluteBoundingBox) rb = root.absoluteBoundingBox; } catch (e) {}

  // Cheap synchronous pre-count so we can emit progress and not trip the 30s
  // MCP inactivity timeout on large screens.
  let total = 0;
  (function countNodes(n) {
    total++;
    let k = null;
    try { k = n.children; } catch (e) {}
    if (k) for (const c of k) countNodes(c);
  })(root);
  let processed = 0;
  await sendProgressUpdate(commandId, "get_frame_context", "started", 0, total, 0, "Digesting frame...", null);

  // Per-node work is fully guarded: a single unclassifiable node (widget / a
  // newer Figma node type whose props throw) is skipped instead of failing the
  // whole digest.
  async function walk(node, depth) {
    // visibility + chrome filters
    try {
      if (node.visible === false) return null;
      if (excludeChrome && chrome.has(normalizeName(node.name))) return null;
    } catch (e) {}

    // node identity — if even this throws, the node is unusable: skip it.
    let rec;
    try {
      rec = { id: node.id, name: node.name, type: node.type };
    } catch (e) {
      return null;
    }

    processed++;
    if (processed % 50 === 0) {
      await sendProgressUpdate(
        commandId, "get_frame_context", "in_progress",
        Math.min(99, Math.round((processed / total) * 100)),
        total, processed, `Digested ${processed}/${total} nodes`, null
      );
    }

    try {
      const box = node.absoluteBoundingBox;
      if (box) {
        rec.bounds = {
          x: Math.round(box.x - rb.x),
          y: Math.round(box.y - rb.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        };
      }
    } catch (e) {}

    if (rec.type === "TEXT") {
      try { rec.characters = node.characters; } catch (e) {}
      try {
        const typ = {
          fontSize: typeof node.fontSize === "number" ? node.fontSize : undefined,
          fontWeight: typeof node.fontWeight === "number" ? node.fontWeight : undefined,
          letterSpacing: node.letterSpacing,
          lineHeight: node.lineHeight,
          textAlignHorizontal: node.textAlignHorizontal,
          textAlignVertical: node.textAlignVertical,
        };
        if (node.fontName && node.fontName.family) {
          typ.fontFamily = node.fontName.family;
          typ.fontStyle = node.fontName.style;
        }
        rec.typography = typ;
      } catch (e) {}
    }

    try {
      if (node.layoutMode && node.layoutMode !== "NONE") {
        rec.layout = {
          flexDirection: node.layoutMode === "HORIZONTAL" ? "row" : "column",
          gap: node.itemSpacing,
          padding: {
            top: node.paddingTop,
            right: node.paddingRight,
            bottom: node.paddingBottom,
            left: node.paddingLeft,
          },
          justifyContent: mapPrimaryAxis(node.primaryAxisAlignItems),
          alignItems: mapCounterAxis(node.counterAxisAlignItems),
        };
        if (node.layoutWrap === "WRAP") rec.layout.flexWrap = "wrap";
      }
    } catch (e) {}

    try {
      if (typeof node.cornerRadius === "number" && node.cornerRadius) {
        rec.cornerRadius = node.cornerRadius;
      }
      if (typeof node.opacity === "number" && node.opacity !== 1) {
        rec.opacity = node.opacity;
      }
    } catch (e) {}

    try {
      const tokens = await nodeTokens(node, resolver);
      if (tokens) rec.tokens = tokens;
    } catch (e) {}

    try { if (nodeHasImageFill(node)) rec.hasImageFill = true; } catch (e) {}

    let kids = null;
    try { kids = node.children; } catch (e) {}
    if (kids && kids.length) {
      if (maxDepth !== undefined && depth >= maxDepth) {
        // Depth limit reached: don't descend. Surface the raw child count and a
        // truncated flag so the caller knows to re-digest this node deeper.
        rec.childCount = kids.length;
        rec.truncated = true;
      } else {
        const arr = [];
        for (const c of kids) {
          let r = null;
          try { r = await walk(c, depth + 1); } catch (e) {}
          if (r) arr.push(r);
        }
        if (arr.length) rec.children = arr;
      }
    }
    return rec;
  }

  const tree = await walk(root, 0);
  if (tree && includeHash) tree.subtreeHash = computeSubtreeHash(root);
  await sendProgressUpdate(commandId, "get_frame_context", "completed", 100, total, processed, "Frame digested", null);
  return tree;
}

/**
 * Read Figma Motion data (animations / manual keyframe tracks / timelines) from a
 * node subtree. Motion is the Animation panel feature — it is NOT a prototype
 * reaction, so get_reactions can never see it.
 *
 * Beta API: every property access is guarded so an older Figma desktop build
 * just yields `supported: false` instead of throwing.
 */
async function getMotion(nodeId, maxDepthParam) {
  const root = await figma.getNodeByIdAsync(nodeId);
  if (!root) throw new Error(`Node not found: ${nodeId}`);
  const maxDepth = Number.isFinite(maxDepthParam) ? Math.max(0, Math.floor(maxDepthParam)) : 6;

  const safe = (fn) => {
    try {
      return fn();
    } catch (_) {
      return undefined;
    }
  };

  // Motion objects are host objects — spread them into plain JSON.
  const plain = (value, depth = 0) => {
    if (value === null || value === undefined) return value;
    if (depth > 8) return '[deep]';
    const kind = typeof value;
    if (kind === 'number' || kind === 'string' || kind === 'boolean') return value;
    if (kind === 'function') return undefined;
    if (Array.isArray(value)) return value.map((item) => plain(item, depth + 1));
    const out = {};
    for (const key in value) {
      const child = safe(() => value[key]);
      const converted = plain(child, depth + 1);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  };

  const results = [];
  const walk = (node, depth) => {
    const animations = safe(() => node.animations);
    const tracks = safe(() => node.manualKeyframeTracks);
    const timelines = safe(() => node.timelines);
    const styles = safe(() => node.animationStyles);
    const hasAny =
      (animations && Object.keys(plain(animations) || {}).length > 0) ||
      (tracks && tracks.length > 0) ||
      (timelines && timelines.length > 0) ||
      (styles && styles.length > 0);
    if (hasAny) {
      results.push({
        id: node.id,
        name: node.name,
        type: node.type,
        depth,
        animations: plain(animations),
        manualKeyframeTracks: plain(tracks),
        timelines: plain(timelines),
        animationStyles: plain(styles),
      });
    }
    if (depth < maxDepth && 'children' in node) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);

  return {
    // `animations` missing entirely on the root means this Figma build predates Motion.
    supported: safe(() => root.animations) !== undefined,
    documentTimelines: plain(safe(() => figma.motion && figma.motion.timelines)),
    availableAnimationStyles: plain(safe(() => figma.motion && figma.motion.animationStyles)),
    nodesWithMotion: results.length,
    nodes: results,
  };
}

async function getReactions(nodeIds, maxDepthParam) {
  try {
    const commandId = generateCommandId();
    // Max levels below each given node to search (undefined = unlimited).
    // Same convention as get_node_info: recurse while depth < maxDepth.
    const maxDepth = Number.isFinite(maxDepthParam)
      ? Math.max(0, Math.floor(maxDepthParam))
      : undefined;
    // Count of nodes visited across the whole scan — used to emit periodic
    // progress updates so a single deep node doesn't starve the inactivity
    // timer (which otherwise fires only once per top-level nodeId).
    let visited = 0;
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "started",
      0,
      nodeIds.length,
      0,
      `Starting deep search for reactions in ${nodeIds.length} nodes and their children` +
        (maxDepth !== undefined ? ` (maxDepth ${maxDepth})` : "")
    );

    // Function to find nodes with reactions from the node and all its children
    async function findNodesWithReactions(node, processedNodes = new Set(), depth = 0, results = []) {
      // Skip already processed nodes (prevent circular references)
      if (processedNodes.has(node.id)) {
        return results;
      }

      processedNodes.add(node.id);

      // Keep the inactivity timer alive during a long deep scan.
      visited++;
      if (visited % 500 === 0) {
        await sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          0,
          nodeIds.length,
          0,
          `Scanning… visited ${visited} nodes, found ${results.length} with reactions`
        );
      }

      // Check if the current node has reactions
      // NOTE: this used to drop reactions whose navigation is 'CHANGE_TO'.
      // CHANGE_TO is exactly what variant-based (interactive component) loop
      // animations use — AFTER_DELAY → CHANGE_TO another variant — so filtering
      // it made timeline-style animations look like "no prototype data at all".
      // Keep everything; the caller decides what is relevant.
      const filteredReactions =
        node.reactions && node.reactions.length > 0 ? node.reactions : [];
      const hasFilteredReactions = filteredReactions.length > 0;
      
      // If the node has filtered reactions, add it to results and apply highlight effect
      if (hasFilteredReactions) {
        results.push({
          id: node.id,
          name: node.name,
          type: node.type,
          depth: depth,
          hasReactions: true,
          reactions: filteredReactions,
          path: getNodePath(node)
        });
        // Apply highlight effect (orange border)
        await highlightNodeWithAnimation(node);
      }
      
      // If node has children, recursively search them — but stop descending once
      // the depth limit is reached (undefined = unlimited).
      if (node.children && (maxDepth === undefined || depth < maxDepth)) {
        for (const child of node.children) {
          await findNodesWithReactions(child, processedNodes, depth + 1, results);
        }
      }

      return results;
    }
    
    // Function to apply animated highlight effect to a node
    async function highlightNodeWithAnimation(node) {
      // Save original stroke properties
      const originalStrokeWeight = node.strokeWeight;
      const originalStrokes = node.strokes ? [...node.strokes] : [];
      
      try {
        // Apply orange border stroke
        node.strokeWeight = 4;
        node.strokes = [{
          type: 'SOLID',
          color: { r: 1, g: 0.5, b: 0 }, // Orange color
          opacity: 0.8
        }];
        
        // Set timeout for animation effect (restore to original after 1.5 seconds)
        setTimeout(() => {
          try {
            // Restore original stroke properties
            node.strokeWeight = originalStrokeWeight;
            node.strokes = originalStrokes;
          } catch (restoreError) {
            console.error(`Error restoring node stroke: ${restoreError.message}`);
          }
        }, 1500);
      } catch (highlightError) {
        console.error(`Error highlighting node: ${highlightError.message}`);
        // Continue even if highlighting fails
      }
    }
    
    // Get node hierarchy path as a string
    function getNodePath(node) {
      const path = [];
      let current = node;
      
      while (current && current.parent) {
        path.unshift(current.name);
        current = current.parent;
      }
      
      return path.join(' > ');
    }

    // Array to store all results
    let allResults = [];
    let processedCount = 0;
    const totalCount = nodeIds.length;
    
    // Iterate through each node and its children to search for reactions
    for (let i = 0; i < nodeIds.length; i++) {
      try {
        const nodeId = nodeIds[i];
        const node = await figma.getNodeByIdAsync(nodeId);
        
        if (!node) {
          processedCount++;
          sendProgressUpdate(
            commandId,
            "get_reactions",
            "in_progress",
            processedCount / totalCount,
            totalCount,
            processedCount,
            `Node not found: ${nodeId}`
          );
          continue;
        }
        
        // Search for reactions in the node and its children
        const processedNodes = new Set();
        const nodeResults = await findNodesWithReactions(node, processedNodes);
        
        // Add results
        allResults = allResults.concat(nodeResults);
        
        // Update progress
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Processed node ${processedCount}/${totalCount}, found ${nodeResults.length} nodes with reactions`
        );
      } catch (error) {
        processedCount++;
        sendProgressUpdate(
          commandId,
          "get_reactions",
          "in_progress",
          processedCount / totalCount,
          totalCount,
          processedCount,
          `Error processing node: ${error.message}`
        );
      }
    }

    // Completion update
    sendProgressUpdate(
      commandId,
      "get_reactions",
      "completed",
      1,
      totalCount,
      totalCount,
      `Completed deep search: found ${allResults.length} nodes with reactions.`
    );

    return {
      nodesCount: nodeIds.length,
      nodesWithReactions: allResults.length,
      nodes: allResults
    };
  } catch (error) {
    throw new Error(`Failed to get reactions: ${error.message}`);
  }
}

async function readMyDesign() {
  try {
    // Load all selected nodes in parallel
    const nodes = await Promise.all(
      figma.currentPage.selection.map((node) => figma.getNodeByIdAsync(node.id))
    );

    // Filter out any null values (nodes that weren't found)
    const validNodes = nodes.filter((node) => node !== null);

    // Export all valid nodes in parallel
    const responses = await Promise.all(
      validNodes.map(async (node) => {
        const response = await node.exportAsync({
          format: "JSON_REST_V1",
        });
        return {
          nodeId: node.id,
          document: filterFigmaNode(response.document),
        };
      })
    );

    return responses;
  } catch (error) {
    throw new Error(`Error getting nodes info: ${error.message}`);
  }
}

async function createRectangle(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Rectangle",
    parentId,
  } = params || {};

  const rect = figma.createRectangle();
  rect.x = x;
  rect.y = y;
  rect.resize(width, height);
  rect.name = name;

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(rect);
  } else {
    figma.currentPage.appendChild(rect);
  }

  return {
    id: rect.id,
    name: rect.name,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    parentId: rect.parent ? rect.parent.id : undefined,
  };
}

async function createFrame(params) {
  const {
    x = 0,
    y = 0,
    width = 100,
    height = 100,
    name = "Frame",
    parentId,
    fillColor,
    strokeColor,
    strokeWeight,
    layoutMode = "NONE",
    layoutWrap = "NO_WRAP",
    paddingTop = 10,
    paddingRight = 10,
    paddingBottom = 10,
    paddingLeft = 10,
    primaryAxisAlignItems = "MIN",
    counterAxisAlignItems = "MIN",
    layoutSizingHorizontal = "FIXED",
    layoutSizingVertical = "FIXED",
    itemSpacing = 0,
  } = params || {};

  const frame = figma.createFrame();
  frame.x = x;
  frame.y = y;
  frame.resize(width, height);
  frame.name = name;

  // Set layout mode if provided
  if (layoutMode !== "NONE") {
    frame.layoutMode = layoutMode;
    frame.layoutWrap = layoutWrap;

    // Set padding values only when layoutMode is not NONE
    frame.paddingTop = paddingTop;
    frame.paddingRight = paddingRight;
    frame.paddingBottom = paddingBottom;
    frame.paddingLeft = paddingLeft;

    // Set axis alignment only when layoutMode is not NONE
    frame.primaryAxisAlignItems = primaryAxisAlignItems;
    frame.counterAxisAlignItems = counterAxisAlignItems;

    // Set layout sizing only when layoutMode is not NONE
    frame.layoutSizingHorizontal = layoutSizingHorizontal;
    frame.layoutSizingVertical = layoutSizingVertical;

    // Set item spacing only when layoutMode is not NONE
    frame.itemSpacing = itemSpacing;
  }

  // Set fill color if provided
  if (fillColor) {
    const paintStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(fillColor.r) || 0,
        g: parseFloat(fillColor.g) || 0,
        b: parseFloat(fillColor.b) || 0,
      },
      opacity: parseFloat(fillColor.a) || 1,
    };
    frame.fills = [paintStyle];
  }

  // Set stroke color and weight if provided
  if (strokeColor) {
    const strokeStyle = {
      type: "SOLID",
      color: {
        r: parseFloat(strokeColor.r) || 0,
        g: parseFloat(strokeColor.g) || 0,
        b: parseFloat(strokeColor.b) || 0,
      },
      opacity: parseFloat(strokeColor.a) || 1,
    };
    frame.strokes = [strokeStyle];
  }

  // Set stroke weight if provided
  if (strokeWeight !== undefined) {
    frame.strokeWeight = strokeWeight;
  }

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(frame);
  } else {
    figma.currentPage.appendChild(frame);
  }

  return {
    id: frame.id,
    name: frame.name,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    fills: frame.fills,
    strokes: frame.strokes,
    strokeWeight: frame.strokeWeight,
    layoutMode: frame.layoutMode,
    layoutWrap: frame.layoutWrap,
    parentId: frame.parent ? frame.parent.id : undefined,
  };
}

async function createText(params) {
  const {
    x = 0,
    y = 0,
    text = "Text",
    fontSize = 14,
    fontWeight = 400,
    fontColor = { r: 0, g: 0, b: 0, a: 1 }, // Default to black
    name = "",
    parentId,
  } = params || {};

  // Map common font weights to Figma font styles
  const getFontStyle = (weight) => {
    switch (weight) {
      case 100:
        return "Thin";
      case 200:
        return "Extra Light";
      case 300:
        return "Light";
      case 400:
        return "Regular";
      case 500:
        return "Medium";
      case 600:
        return "Semi Bold";
      case 700:
        return "Bold";
      case 800:
        return "Extra Bold";
      case 900:
        return "Black";
      default:
        return "Regular";
    }
  };

  const textNode = figma.createText();
  textNode.x = x;
  textNode.y = y;
  textNode.name = name || text;
  try {
    await figma.loadFontAsync({
      family: "Inter",
      style: getFontStyle(fontWeight),
    });
    textNode.fontName = { family: "Inter", style: getFontStyle(fontWeight) };
    textNode.fontSize = parseInt(fontSize);
  } catch (error) {
    console.error("Error setting font size", error);
  }
  setCharacters(textNode, text);

  // Set text color
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(fontColor.r) || 0,
      g: parseFloat(fontColor.g) || 0,
      b: parseFloat(fontColor.b) || 0,
    },
    opacity: parseFloat(fontColor.a) || 1,
  };
  textNode.fills = [paintStyle];

  // If parentId is provided, append to that node, otherwise append to current page
  if (parentId) {
    const parentNode = await figma.getNodeByIdAsync(parentId);
    if (!parentNode) {
      throw new Error(`Parent node not found with ID: ${parentId}`);
    }
    if (!("appendChild" in parentNode)) {
      throw new Error(`Parent node does not support children: ${parentId}`);
    }
    parentNode.appendChild(textNode);
  } else {
    figma.currentPage.appendChild(textNode);
  }

  return {
    id: textNode.id,
    name: textNode.name,
    x: textNode.x,
    y: textNode.y,
    width: textNode.width,
    height: textNode.height,
    characters: textNode.characters,
    fontSize: textNode.fontSize,
    fontWeight: fontWeight,
    fontColor: fontColor,
    fontName: textNode.fontName,
    fills: textNode.fills,
    parentId: textNode.parent ? textNode.parent.id : undefined,
  };
}

async function setFillColor(params) {
  console.log("setFillColor", params);
  const {
    nodeId,
    color: { r, g, b, a },
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("fills" in node)) {
    throw new Error(`Node does not support fills: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: parseFloat(r) || 0,
    g: parseFloat(g) || 0,
    b: parseFloat(b) || 0,
    a: parseFloat(a) || 1,
  };

  // Set fill
  const paintStyle = {
    type: "SOLID",
    color: {
      r: parseFloat(rgbColor.r),
      g: parseFloat(rgbColor.g),
      b: parseFloat(rgbColor.b),
    },
    opacity: parseFloat(rgbColor.a),
  };

  console.log("paintStyle", paintStyle);

  node.fills = [paintStyle];

  return {
    id: node.id,
    name: node.name,
    fills: [paintStyle],
  };
}

/**
 * 소스 노드를 PNG 로 구워 타깃 노드의 **이미지 fill** 로 넣는다.
 *
 * 왜 "노드 → 노드" 인가:
 *  - 바이트가 소켓을 건너지 않는다. 스크린샷 한 장이 수 MB 라 base64 로 실어 나르면
 *    릴레이 메시지 상한에 걸리기 쉽다. export 와 createImage 를 **둘 다 플러그인 안에서** 한다.
 *  - **타깃의 변형(회전·마스크)이 그대로 보존된다.** fills 만 바꾸므로 rotation /
 *    relativeTransform 을 읽거나 쓸 필요가 없다 — 플러그인 API 밖에 있는 그 값들을
 *    건드리지 않고도 목업 안의 화면을 교체할 수 있다.
 *
 * 목업(기울어진 폰) 안의 `Screen` 사각형에 앱 화면 프레임을 넣는 용도로 만들었다.
 */
async function setImageFillFromNode(params) {
  const {
    sourceNodeId,
    targetNodeId,
    scale = 2,
    scaleMode,
    replacePaint = false,
  } = params || {};

  if (!sourceNodeId) throw new Error("Missing sourceNodeId parameter");
  if (!targetNodeId) throw new Error("Missing targetNodeId parameter");

  const source = await figma.getNodeByIdAsync(sourceNodeId);
  if (!source) throw new Error(`Source node not found: ${sourceNodeId}`);
  if (!("exportAsync" in source)) {
    throw new Error(`Source node does not support exporting: ${sourceNodeId}`);
  }

  const target = await figma.getNodeByIdAsync(targetNodeId);
  if (!target) throw new Error(`Target node not found: ${targetNodeId}`);
  if (!("fills" in target)) {
    throw new Error(`Target node does not support fills: ${targetNodeId}`);
  }

  const validModes = ["FILL", "FIT", "CROP", "TILE"];
  if (scaleMode && validModes.indexOf(scaleMode) === -1) {
    throw new Error(`Invalid scaleMode: ${scaleMode} (${validModes.join(" | ")})`);
  }

  const bytes = await source.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });

  const image = figma.createImage(bytes);

  const fills = Array.isArray(target.fills) ? target.fills.slice() : [];
  const index = fills.findIndex((f) => f && f.type === "IMAGE");
  const existing = index !== -1 ? fills[index] : null;

  let paint;
  let preserved;
  if (existing && !replacePaint) {
    // ⚠️ 기존 paint 의 **기하를 그대로 물려받고 픽셀만 갈아끼운다.**
    //
    // 목업의 화면 자리(보통 "Paste content here" 라는 벡터)는 축에 정렬된 노드이고,
    // 기기 기울기는 `scaleMode:"CROP"` + `imageTransform`(2×3 아핀) 으로 표현돼 있다.
    // paint 를 통째로 새로 만들면 그 행렬이 날아가서, 똑바른 이미지가 기울어진 패스로
    // **크롭만** 된 그림이 나온다(기기 각도와 안 맞는다).
    //
    // 우리는 같은 자리에 다른 스크린샷을 넣을 뿐이므로 기하는 바뀔 이유가 없다.
    // imageHash 만 바꾸면 회전·기울기·크롭·필터가 전부 유지된다.
    // ⚠️ scaleMode 는 **일부러 무시한다.** 물려받기의 요점이 "픽셀만 바꾼다" 인데,
    // FILL/FIT 로 덮으면 Figma 가 imageTransform 을 무시해 기울기가 날아간다.
    // 모드를 정말 바꿔야 하면 replacePaint 로 새 paint 를 만들 것.
    paint = Object.assign({}, existing, { imageHash: image.hash });
    preserved = {
      scaleMode: existing.scaleMode,
      hasImageTransform: !!existing.imageTransform,
      rotation: existing.rotation,
    };
    fills[index] = paint;
  } else {
    paint = {
      type: "IMAGE",
      scaleMode: scaleMode || "FILL",
      imageHash: image.hash,
    };
    preserved = null;
    if (index !== -1) fills[index] = paint;
    else fills.push(paint);
  }

  target.fills = fills;

  return {
    sourceId: source.id,
    sourceName: source.name,
    targetId: target.id,
    targetName: target.name,
    imageHash: image.hash,
    bytes: bytes.length,
    scale: scale,
    scaleMode: paint.scaleMode,
    // 기존 paint 를 물려받았는지 — 물려받지 못했다면 기기 각도와 안 맞을 수 있다.
    inheritedGeometry: preserved,
  };
}

function base64ToUint8Array(base64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(base64).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (chars.indexOf(clean[i]) << 18) |
      (chars.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? chars.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? chars.indexOf(clean[i + 3]) : 0);
    out[p++] = (n >> 16) & 255;
    if (clean[i + 2]) out[p++] = (n >> 8) & 255;
    if (clean[i + 3]) out[p++] = n & 255;
  }
  return out.subarray(0, p);
}

/**
 * 노드의 기하 — **기울어진 목업 슬롯의 네 꼭짓점**을 얻는 용도.
 *
 * Figma 는 skew 를 지원하지 않는다. 그래서 기기 각도에 맞춘 화면은 전부 목업 플러그인이
 * "레이어를 이미지로 뽑아 4포인트 벡터에 맞게 뒤틀어서" 만든 결과물이다. 우리도 같은 걸
 * 하려면 그 사각형의 꼭짓점이 필요한데, `get_node_info` 는 벡터 패스를 주지 않는다.
 *
 * 좌표는 **노드 로컬**(0..width, 0..height)로 돌려준다 — 이미지 fill 이 칠해지는 좌표계와
 * 같아서, 워프 결과를 그대로 채우면 맞는다.
 */
async function getNodeGeometry(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);

  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    width: "width" in node ? node.width : null,
    height: "height" in node ? node.height : null,
    rotation: "rotation" in node ? node.rotation : null,
  };

  if (node.type === "VECTOR" && node.vectorNetwork) {
    out.vertices = (node.vectorNetwork.vertices || []).map((v) => ({
      x: v.x,
      y: v.y,
    }));
  }
  if ("absoluteTransform" in node) out.absoluteTransform = node.absoluteTransform;

  const fills = "fills" in node && Array.isArray(node.fills) ? node.fills : [];
  const img = fills.find((f) => f && f.type === "IMAGE");
  if (img) {
    out.imageFill = {
      scaleMode: img.scaleMode,
      imageTransform: img.imageTransform || null,
      rotation: img.rotation != null ? img.rotation : null,
    };
  }
  return out;
}

/**
 * 이미 워프된 PNG 를 base64 로 받아 노드의 이미지 fill 로 넣는다.
 *
 * `set_image_fill_from_node` 는 Figma 안에서 굽기 때문에 **뒤틀 수가 없다**. 원근 워프는
 * Figma 밖(PIL 등)에서 해야 하므로, 그 결과를 되돌려 받을 통로가 이것이다.
 * 바이트가 릴레이를 타므로 **워프된 결과 한 장만** 보낼 것 — 원본 대량 전송용이 아니다.
 *
 * paint 기하는 `set_image_fill_from_node` 와 같은 규칙으로 물려받는다.
 */
async function setImageFillFromBytes(params) {
  const { nodeId, imageBase64, scaleMode, replacePaint = false } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  if (!imageBase64) throw new Error("Missing imageBase64 parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (!("fills" in node)) throw new Error(`Node does not support fills: ${nodeId}`);

  const bytes = base64ToUint8Array(imageBase64);
  const image = figma.createImage(bytes);

  const fills = Array.isArray(node.fills) ? node.fills.slice() : [];
  const index = fills.findIndex((f) => f && f.type === "IMAGE");
  const existing = index !== -1 ? fills[index] : null;

  let paint;
  if (existing && !replacePaint) {
    paint = Object.assign({}, existing, { imageHash: image.hash });
  } else {
    paint = { type: "IMAGE", scaleMode: scaleMode || "FILL", imageHash: image.hash };
  }
  if (index !== -1) fills[index] = paint;
  else fills.push(paint);
  node.fills = fills;

  return {
    id: node.id,
    name: node.name,
    imageHash: image.hash,
    bytes: bytes.length,
    scaleMode: paint.scaleMode,
    inherited: !!(existing && !replacePaint),
  };
}

async function setStrokeColor(params) {
  const {
    nodeId,
    color: { r, g, b, a },
    weight = 1,
  } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("strokes" in node)) {
    throw new Error(`Node does not support strokes: ${nodeId}`);
  }

  // Create RGBA color
  const rgbColor = {
    r: r !== undefined ? r : 0,
    g: g !== undefined ? g : 0,
    b: b !== undefined ? b : 0,
    a: a !== undefined ? a : 1,
  };

  // Set stroke
  const paintStyle = {
    type: "SOLID",
    color: {
      r: rgbColor.r,
      g: rgbColor.g,
      b: rgbColor.b,
    },
    opacity: rgbColor.a,
  };

  node.strokes = [paintStyle];

  // Set stroke weight if available
  if ("strokeWeight" in node) {
    node.strokeWeight = weight;
  }

  return {
    id: node.id,
    name: node.name,
    strokes: node.strokes,
    strokeWeight: "strokeWeight" in node ? node.strokeWeight : undefined,
  };
}

async function moveNode(params) {
  const { nodeId, x, y } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (x === undefined || y === undefined) {
    throw new Error("Missing x or y parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("x" in node) || !("y" in node)) {
    throw new Error(`Node does not support position: ${nodeId}`);
  }

  node.x = x;
  node.y = y;

  return {
    id: node.id,
    name: node.name,
    x: node.x,
    y: node.y,
  };
}

async function resizeNode(params) {
  const { nodeId, width, height } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (width === undefined || height === undefined) {
    throw new Error("Missing width or height parameters");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("resize" in node)) {
    throw new Error(`Node does not support resizing: ${nodeId}`);
  }

  node.resize(width, height);

  return {
    id: node.id,
    name: node.name,
    width: node.width,
    height: node.height,
  };
}

async function deleteNode(params) {
  const { nodeId } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Save node info before deleting
  const nodeInfo = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  node.remove();

  return nodeInfo;
}

async function getStyles() {
  const styles = {
    colors: await figma.getLocalPaintStylesAsync(),
    texts: await figma.getLocalTextStylesAsync(),
    effects: await figma.getLocalEffectStylesAsync(),
    grids: await figma.getLocalGridStylesAsync(),
  };

  return {
    colors: styles.colors.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      paint: style.paints[0],
    })),
    texts: styles.texts.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
      fontSize: style.fontSize,
      fontName: style.fontName,
    })),
    effects: styles.effects.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
    grids: styles.grids.map((style) => ({
      id: style.id,
      name: style.name,
      key: style.key,
    })),
  };
}

async function getLocalComponents(params) {
  const commandId = (params && params.commandId) || generateCommandId();
  const pages = figma.root.children;
  const totalPages = pages.length;

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "started",
    0,
    totalPages,
    0,
    "Starting component scan across " + totalPages + " pages...",
    null
  );

  var allComponents = [];

  for (var i = 0; i < totalPages; i++) {
    var page = pages[i];
    await page.loadAsync();

    var pageComponents = page.findAllWithCriteria({
      types: ["COMPONENT", "COMPONENT_SET"],
    });

    for (var j = 0; j < pageComponents.length; j++) {
      var component = pageComponents[j];
      allComponents.push({
        id: component.id,
        name: component.name,
        type: component.type,
        key: "key" in component ? component.key : null,
        remote: !!component.remote,
      });
    }

    var progress = Math.round(((i + 1) / totalPages) * 100);
    await sendProgressUpdate(
      commandId,
      "get_local_components",
      "in_progress",
      progress,
      totalPages,
      i + 1,
      "Scanned " + page.name + ": " + pageComponents.length + " components (total so far: " + allComponents.length + ")",
      null
    );
  }

  await sendProgressUpdate(
    commandId,
    "get_local_components",
    "completed",
    100,
    totalPages,
    totalPages,
    "Found " + allComponents.length + " components across " + totalPages + " pages",
    null
  );

  const total = allComponents.length;
  const { limit, offset = 0, countOnly = false } = params || {};
  if (countOnly) {
    return { count: total, total: total, countOnly: true };
  }
  const start = offset > 0 ? offset : 0;
  const slice =
    limit !== undefined && limit !== null
      ? allComponents.slice(start, start + limit)
      : allComponents.slice(start);
  const nextOffset = start + slice.length < total ? start + slice.length : null;

  return {
    total: total,
    count: slice.length,
    offset: start,
    nextOffset: nextOffset,
    components: slice,
  };
}

// async function getTeamComponents() {
//   try {
//     const teamComponents =
//       await figma.teamLibrary.getAvailableComponentsAsync();

//     return {
//       count: teamComponents.length,
//       components: teamComponents.map((component) => ({
//         key: component.key,
//         name: component.name,
//         description: component.description,
//         libraryName: component.libraryName,
//       })),
//     };
//   } catch (error) {
//     throw new Error(`Error getting team components: ${error.message}`);
//   }
// }

async function createComponentInstance(params) {
  const { componentKey, componentId, x = 0, y = 0, parentId } = params || {};

  if (!componentKey && !componentId) {
    throw new Error("Missing componentKey or componentId parameter. Use componentId for local components (from get_local_components), or componentKey for published library components.");
  }

  try {
    let component;

    if (componentId) {
      // Local component: get node directly by ID
      const node = await figma.getNodeByIdAsync(componentId);
      if (!node) {
        throw new Error(`Component node not found with id: ${componentId}`);
      }
      if (node.type !== "COMPONENT") {
        throw new Error(`Node ${componentId} is not a COMPONENT (got type: ${node.type}). Use get_local_components to find valid component IDs.`);
      }
      component = node;
    } else {
      // Published library component: import by key
      component = await figma.importComponentByKeyAsync(componentKey);
    }

    const instance = component.createInstance();
    instance.x = x;
    instance.y = y;

    if (parentId) {
      const parent = await figma.getNodeByIdAsync(parentId);
      if (parent && "appendChild" in parent) {
        parent.appendChild(instance);
      } else {
        figma.currentPage.appendChild(instance);
      }
    } else {
      figma.currentPage.appendChild(instance);
    }

    const mainComponent = await instance.getMainComponentAsync();

    return {
      id: instance.id,
      name: instance.name,
      x: instance.x,
      y: instance.y,
      width: instance.width,
      height: instance.height,
      mainComponentId: mainComponent ? mainComponent.id : undefined,
    };
  } catch (error) {
    throw new Error(`Error creating component instance: ${error.message}`);
  }
}

// 6-digit lowercase hex from a Figma RGBA (0..1). Matches Figma's SVG output,
// which uses #rrggbb + a separate fill-opacity (alpha is ignored here).
function rgbToHex6(c) {
  const h = (x) => Math.round((x || 0) * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

// True if a live node paints any IMAGE fill (used to flag reference captures
// like screenshots / pasted images vs. real design frames).
function nodeHasImageFill(node) {
  try {
    const fills = node.fills;
    return (
      Array.isArray(fills) &&
      fills.some((p) => p && p.type === "IMAGE" && p.visible !== false)
    );
  } catch (e) {
    return false;
  }
}

// Walk a subtree collecting, in document order, every SOLID paint bound to a
// color variable: { token, hex, property }. The binding can live on the paint
// (paint.boundVariables.color) or on the node (node.boundVariables.fills[i]),
// so we check both.
//
// This is returned as authoritative METADATA — the plugin deliberately does
// NOT mutate the SVG. Matching resolved hexes against SVG text is lossy: a
// hard-coded hex that happens to equal a token's color would be wrongly
// tokenized, and two tokens resolving to the same color are indistinguishable.
// The caller (sync-figma skill / RN tooling) has the design-system context to
// inject {{token}} placeholders correctly; we just hand it the facts.
async function collectColorTokens(node, resolver, out) {
  const scanPaints = async (paints, nodeLevelAliases, property) => {
    if (!Array.isArray(paints)) return;
    for (let i = 0; i < paints.length; i++) {
      const p = paints[i];
      if (!p || p.type !== "SOLID" || !p.color) continue;
      const varId =
        (p.boundVariables && p.boundVariables.color && p.boundVariables.color.id) ||
        (Array.isArray(nodeLevelAliases) && nodeLevelAliases[i] && nodeLevelAliases[i].id);
      if (!varId) continue;
      const v = await resolver.variable(varId);
      if (v && v.name) {
        out.push({
          token: v.name,
          hex: rgbToHex6(p.color).toLowerCase(),
          property: property,
        });
      }
    }
  };
  const nbv = node.boundVariables || {};
  try { await scanPaints(node.fills, nbv.fills, "fill"); } catch (e) {}
  try { await scanPaints(node.strokes, nbv.strokes, "stroke"); } catch (e) {}
  let kids = null;
  try { kids = node.children; } catch (e) {}
  if (kids) for (const c of kids) await collectColorTokens(c, resolver, out);
}

// UTF-8 encode a string to a Uint8Array (for base64 transport of SVG text).
function utf8ToUint8(str) {
  const enc = encodeURIComponent(str);
  const out = [];
  for (let i = 0; i < enc.length; i++) {
    if (enc[i] === "%") {
      out.push(parseInt(enc.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(enc.charCodeAt(i));
    }
  }
  return new Uint8Array(out);
}

// cyrb53 — fast, well-distributed string hash. Deterministic (no Date/random),
// so identical input always yields the identical hash.
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ (seed || 0);
  let h2 = 0x41c6ce57 ^ (seed || 0);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const out = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return out.toString(16);
}

// Stable structural hash of a node's subtree: child structure/order, text
// characters, bound variable ids, and rounded SIZE (not absolute position, so
// relocating the whole frame doesn't change it). Same content -> same hash.
function computeSubtreeHash(node) {
  const lines = [];
  function walk(n, depth) {
    let line = depth + ":" + n.type;
    try {
      if (n.type === "TEXT" && typeof n.characters === "string")
        line += "|t=" + n.characters;
    } catch (e) {}
    try {
      const bv = n.boundVariables;
      if (bv && typeof bv === "object") {
        const keys = Object.keys(bv).sort();
        for (const k of keys) {
          const val = bv[k];
          const arr = Array.isArray(val) ? val : [val];
          line += "|" + k + "=" + arr.map((a) => (a && a.id) || "").join(",");
        }
      }
    } catch (e) {}
    try {
      // "?" distinguishes a node without a size from one that is genuinely 0×0,
      // so they don't hash identically.
      const w = typeof n.width === "number" ? Math.round(n.width) : "?";
      const h = typeof n.height === "number" ? Math.round(n.height) : "?";
      line += "|s=" + w + "x" + h;
    } catch (e) {}
    if (n.visible === false) line += "|hidden";
    lines.push(line);
    let kids = null;
    try { kids = n.children; } catch (e) {}
    if (kids) for (const c of kids) walk(c, depth + 1);
  }
  walk(node, 0);
  return cyrb53(lines.join("\n"));
}

async function exportNodeAsImage(params) {
  const { nodeId, scale = 1, includeColorTokens = false } = params || {};
  let format = ((params && params.format) || "PNG").toString().toUpperCase();

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (!("exportAsync" in node)) {
    throw new Error(`Node does not support exporting: ${nodeId}`);
  }

  try {
    const base = { nodeId, nodeName: node.name, format, scale };

    // SVG path: always return the real, renderable SVG (resolved colors). When
    // asked, ALSO return authoritative color-token metadata so the caller can
    // inject its own {{token}} placeholders — the SVG itself is never mutated.
    if (format === "SVG") {
      const svg = await node.exportAsync({ format: "SVG_STRING" });
      const out = Object.assign(base, {
        mimeType: "image/svg+xml",
        svg: svg,
        imageData: customBase64Encode(utf8ToUint8(svg)),
      });
      if (includeColorTokens) {
        const resolver = makeDsResolver(true);
        const colorTokens = [];
        await collectColorTokens(node, resolver, colorTokens);
        out.colorTokens = colorTokens; // ordered [{ token, hex, property }]
        const seen = [];
        for (const t of colorTokens) if (seen.indexOf(t.token) === -1) seen.push(t.token);
        out.usedTokens = seen;
      }
      return out;
    }

    // Raster / PDF path.
    const settings = {
      format: format,
      constraint: { type: "SCALE", value: scale },
    };
    const bytes = await node.exportAsync(settings);
    const mimeType =
      format === "JPG"
        ? "image/jpeg"
        : format === "PDF"
        ? "application/pdf"
        : "image/png";

    const out = Object.assign(base, {
      mimeType,
      imageData: customBase64Encode(bytes),
    });
    if (
      format !== "PDF" &&
      typeof node.width === "number" &&
      typeof node.height === "number"
    ) {
      out.width = Math.round(node.width * scale);
      out.height = Math.round(node.height * scale);
    }
    return out;
  } catch (error) {
    throw new Error(`Error exporting node as image: ${error.message}`);
  }
}
function customBase64Encode(bytes) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let base64 = "";

  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a, b, c, d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i = i + 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048 = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032 = (2^6 - 1) << 6
    d = chunk & 63; // 63 = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += chars[a] + chars[b] + chars[c] + chars[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder === 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3 = 2^2 - 1

    base64 += chars[a] + chars[b] + "==";
  } else if (byteRemainder === 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008 = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15 = 2^4 - 1

    base64 += chars[a] + chars[b] + chars[c] + "=";
  }

  return base64;
}

async function setCornerRadius(params) {
  const { nodeId, radius, corners } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (radius === undefined) {
    throw new Error("Missing radius parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Check if node supports corner radius
  if (!("cornerRadius" in node)) {
    throw new Error(`Node does not support corner radius: ${nodeId}`);
  }

  // If corners array is provided, set individual corner radii
  if (corners && Array.isArray(corners) && corners.length === 4) {
    if ("topLeftRadius" in node) {
      // Node supports individual corner radii
      if (corners[0]) node.topLeftRadius = radius;
      if (corners[1]) node.topRightRadius = radius;
      if (corners[2]) node.bottomRightRadius = radius;
      if (corners[3]) node.bottomLeftRadius = radius;
    } else {
      // Node only supports uniform corner radius
      node.cornerRadius = radius;
    }
  } else {
    // Set uniform corner radius
    node.cornerRadius = radius;
  }

  return {
    id: node.id,
    name: node.name,
    cornerRadius: "cornerRadius" in node ? node.cornerRadius : undefined,
    topLeftRadius: "topLeftRadius" in node ? node.topLeftRadius : undefined,
    topRightRadius: "topRightRadius" in node ? node.topRightRadius : undefined,
    bottomRightRadius:
      "bottomRightRadius" in node ? node.bottomRightRadius : undefined,
    bottomLeftRadius:
      "bottomLeftRadius" in node ? node.bottomLeftRadius : undefined,
  };
}

async function setTextContent(params) {
  const { nodeId, text } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  if (text === undefined) {
    throw new Error("Missing text parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  if (node.type !== "TEXT") {
    throw new Error(`Node is not a text node: ${nodeId}`);
  }

  try {
    await figma.loadFontAsync(node.fontName);

    await setCharacters(node, text);

    return {
      id: node.id,
      name: node.name,
      characters: node.characters,
      fontName: node.fontName,
    };
  } catch (error) {
    throw new Error(`Error setting text content: ${error.message}`);
  }
}

// Initialize settings on load
(async function initializePlugin() {
  try {
    const savedSettings = await figma.clientStorage.getAsync("settings");
    if (savedSettings) {
      if (savedSettings.serverPort) {
        state.serverPort = savedSettings.serverPort;
      }
    }

    // Send initial settings to UI
    figma.ui.postMessage({
      type: "init-settings",
      settings: {
        serverPort: state.serverPort,
      },
    });
  } catch (error) {
    console.error("Error loading settings:", error);
  }
})();

function uniqBy(arr, predicate) {
  const cb = typeof predicate === "function" ? predicate : (o) => o[predicate];
  return [
    ...arr
      .reduce((map, item) => {
        const key = item === null || item === undefined ? item : cb(item);

        map.has(key) || map.set(key, item);

        return map;
      }, new Map())
      .values(),
  ];
}
const setCharacters = async (node, characters, options) => {
  const fallbackFont = (options && options.fallbackFont) || {
    family: "Inter",
    style: "Regular",
  };
  try {
    if (node.fontName === figma.mixed) {
      if (options && options.smartStrategy === "prevail") {
        const fontHashTree = {};
        for (let i = 1; i < node.characters.length; i++) {
          const charFont = node.getRangeFontName(i - 1, i);
          const key = `${charFont.family}::${charFont.style}`;
          fontHashTree[key] = fontHashTree[key] ? fontHashTree[key] + 1 : 1;
        }
        const prevailedTreeItem = Object.entries(fontHashTree).sort(
          (a, b) => b[1] - a[1]
        )[0];
        const [family, style] = prevailedTreeItem[0].split("::");
        const prevailedFont = {
          family,
          style,
        };
        await figma.loadFontAsync(prevailedFont);
        node.fontName = prevailedFont;
      } else if (options && options.smartStrategy === "strict") {
        return setCharactersWithStrictMatchFont(node, characters, fallbackFont);
      } else if (options && options.smartStrategy === "experimental") {
        return setCharactersWithSmartMatchFont(node, characters, fallbackFont);
      } else {
        const firstCharFont = node.getRangeFontName(0, 1);
        await figma.loadFontAsync(firstCharFont);
        node.fontName = firstCharFont;
      }
    } else {
      await figma.loadFontAsync({
        family: node.fontName.family,
        style: node.fontName.style,
      });
    }
  } catch (err) {
    console.warn(
      `Failed to load "${node.fontName["family"]} ${node.fontName["style"]}" font and replaced with fallback "${fallbackFont.family} ${fallbackFont.style}"`,
      err
    );
    await figma.loadFontAsync(fallbackFont);
    node.fontName = fallbackFont;
  }
  try {
    node.characters = characters;
    return true;
  } catch (err) {
    console.warn(`Failed to set characters. Skipped.`, err);
    return false;
  }
};

const setCharactersWithStrictMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const fontHashTree = {};
  for (let i = 1; i < node.characters.length; i++) {
    const startIdx = i - 1;
    const startCharFont = node.getRangeFontName(startIdx, i);
    const startCharFontVal = `${startCharFont.family}::${startCharFont.style}`;
    while (i < node.characters.length) {
      i++;
      const charFont = node.getRangeFontName(i - 1, i);
      if (startCharFontVal !== `${charFont.family}::${charFont.style}`) {
        break;
      }
    }
    fontHashTree[`${startIdx}_${i}`] = startCharFontVal;
  }
  await figma.loadFontAsync(fallbackFont);
  node.fontName = fallbackFont;
  node.characters = characters;
  console.log(fontHashTree);
  await Promise.all(
    Object.keys(fontHashTree).map(async (range) => {
      console.log(range, fontHashTree[range]);
      const [start, end] = range.split("_");
      const [family, style] = fontHashTree[range].split("::");
      const matchedFont = {
        family,
        style,
      };
      await figma.loadFontAsync(matchedFont);
      return node.setRangeFontName(Number(start), Number(end), matchedFont);
    })
  );
  return true;
};

const getDelimiterPos = (str, delimiter, startIdx = 0, endIdx = str.length) => {
  const indices = [];
  let temp = startIdx;
  for (let i = startIdx; i < endIdx; i++) {
    if (
      str[i] === delimiter &&
      i + startIdx !== endIdx &&
      temp !== i + startIdx
    ) {
      indices.push([temp, i + startIdx]);
      temp = i + startIdx + 1;
    }
  }
  temp !== endIdx && indices.push([temp, endIdx]);
  return indices.filter(Boolean);
};

const buildLinearOrder = (node) => {
  const fontTree = [];
  const newLinesPos = getDelimiterPos(node.characters, "\n");
  newLinesPos.forEach(([newLinesRangeStart, newLinesRangeEnd], n) => {
    const newLinesRangeFont = node.getRangeFontName(
      newLinesRangeStart,
      newLinesRangeEnd
    );
    if (newLinesRangeFont === figma.mixed) {
      const spacesPos = getDelimiterPos(
        node.characters,
        " ",
        newLinesRangeStart,
        newLinesRangeEnd
      );
      spacesPos.forEach(([spacesRangeStart, spacesRangeEnd], s) => {
        const spacesRangeFont = node.getRangeFontName(
          spacesRangeStart,
          spacesRangeEnd
        );
        if (spacesRangeFont === figma.mixed) {
          const spacesRangeFont = node.getRangeFontName(
            spacesRangeStart,
            spacesRangeStart[0]
          );
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        } else {
          fontTree.push({
            start: spacesRangeStart,
            delimiter: " ",
            family: spacesRangeFont.family,
            style: spacesRangeFont.style,
          });
        }
      });
    } else {
      fontTree.push({
        start: newLinesRangeStart,
        delimiter: "\n",
        family: newLinesRangeFont.family,
        style: newLinesRangeFont.style,
      });
    }
  });
  return fontTree
    .sort((a, b) => +a.start - +b.start)
    .map(({ family, style, delimiter }) => ({ family, style, delimiter }));
};

const setCharactersWithSmartMatchFont = async (
  node,
  characters,
  fallbackFont
) => {
  const rangeTree = buildLinearOrder(node);
  const fontsToLoad = uniqBy(
    rangeTree,
    ({ family, style }) => `${family}::${style}`
  ).map(({ family, style }) => ({
    family,
    style,
  }));

  await Promise.all([...fontsToLoad, fallbackFont].map(figma.loadFontAsync));

  node.fontName = fallbackFont;
  node.characters = characters;

  let prevPos = 0;
  rangeTree.forEach(({ family, style, delimiter }) => {
    if (prevPos < node.characters.length) {
      const delimeterPos = node.characters.indexOf(delimiter, prevPos);
      const endPos =
        delimeterPos > prevPos ? delimeterPos : node.characters.length;
      const matchedFont = {
        family,
        style,
      };
      node.setRangeFontName(prevPos, endPos, matchedFont);
      prevPos = endPos + 1;
    }
  });
  return true;
};

// Add the cloneNode function implementation
async function cloneNode(params) {
  const { nodeId, x, y, name, parentId } = params || {};

  if (!nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node not found with ID: ${nodeId}`);
  }

  // Clone the node
  const clone = node.clone();

  // 복제본은 원본 이름을 그대로 물려받는다. 언어 행을 통째로 복제할 때
  // (DE_01..08 → IT_01..08) 이름이 안 바뀌면 어느 게 어느 언어인지 구분이 안 되므로,
  // 복제 시점에 바로 붙일 수 있게 해 둔다.
  if (name !== undefined) {
    clone.name = name;
  }

  // If x and y are provided, move the clone to that position
  if (x !== undefined && y !== undefined) {
    if (!("x" in clone) || !("y" in clone)) {
      throw new Error(`Cloned node does not support position: ${nodeId}`);
    }
    clone.x = x;
    clone.y = y;
  }

  // 복제본을 어디에 붙일지. `parentId` 가 없으면 원본 옆에 붙는데, 다른 페이지·섹션의
  // 노드를 가져올 때는 그게 곧 "남의 자리에 쓰레기를 남기는" 짓이 된다. 그래서 명시할 수 있게 뒀다.
  if (parentId) {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) throw new Error(`Parent node not found: ${parentId}`);
    if (!("appendChild" in parent)) throw new Error(`Parent cannot hold children: ${parentId}`);
    parent.appendChild(clone);
    // 섹션/프레임에 넣으면 x,y 가 부모 기준으로 재해석된다 — 넣은 뒤 다시 찍어 준다.
    if (x !== undefined && y !== undefined) {
      clone.x = x;
      clone.y = y;
    }
  } else if (node.parent) {
    node.parent.appendChild(clone);
  } else {
    figma.currentPage.appendChild(clone);
  }

  return {
    id: clone.id,
    name: clone.name,
    x: "x" in clone ? clone.x : undefined,
    y: "y" in clone ? clone.y : undefined,
    width: "width" in clone ? clone.width : undefined,
    height: "height" in clone ? clone.height : undefined,
  };
}

async function scanTextNodes(params) {
  console.log(`Starting to scan text nodes from node ID: ${params.nodeId}`);
  const {
    nodeId,
    useChunking = true,
    chunkSize = 10,
    // Visual highlighting is OFF by default — it is purely cosmetic and was
    // the dominant cost (a fill write + 100ms delay per text node).
    skipHighlight = true,
    commandId = generateCommandId(),
  } = params || {};

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    console.error(`Node with ID ${nodeId} not found`);
    // Send error progress update
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "error",
      0,
      0,
      0,
      `Node with ID ${nodeId} not found`,
      { error: `Node not found: ${nodeId}` }
    );
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // If chunking is not enabled, use the original implementation
  if (!useChunking) {
    const textNodes = [];
    try {
      // Send started progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "started",
        0,
        1, // Not known yet how many nodes there are
        0,
        `Starting scan of node "${node.name || nodeId}" without chunking`,
        null
      );

      await findTextNodes(node, [], 0, textNodes);

      // Send completed progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "completed",
        100,
        textNodes.length,
        textNodes.length,
        `Scan complete. Found ${textNodes.length} text nodes.`,
        { textNodes }
      );

      return {
        success: true,
        message: `Scanned ${textNodes.length} text nodes.`,
        count: textNodes.length,
        textNodes: textNodes,
        commandId,
      };
    } catch (error) {
      console.error("Error scanning text nodes:", error);

      // Send error progress update
      sendProgressUpdate(
        commandId,
        "scan_text_nodes",
        "error",
        0,
        0,
        0,
        `Error scanning text nodes: ${error.message}`,
        { error: error.message }
      );

      throw new Error(`Error scanning text nodes: ${error.message}`);
    }
  }

  // Chunked implementation
  console.log(`Using chunked scanning with chunk size: ${chunkSize}`);

  // First, collect all nodes to process (without processing them yet)
  const nodesToProcess = [];

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "started",
    0,
    0, // Not known yet how many nodes there are
    0,
    `Starting chunked scan of node "${node.name || nodeId}"`,
    { chunkSize }
  );

  await collectNodesToProcess(node, [], 0, nodesToProcess);

  const totalNodes = nodesToProcess.length;
  console.log(`Found ${totalNodes} total nodes to process`);

  // Calculate number of chunks needed
  const totalChunks = Math.ceil(totalNodes / chunkSize);
  console.log(`Will process in ${totalChunks} chunks`);

  // Send update after node collection
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "in_progress",
    5, // 5% progress for collection phase
    totalNodes,
    0,
    `Found ${totalNodes} nodes to scan. Will process in ${totalChunks} chunks.`,
    {
      totalNodes,
      totalChunks,
      chunkSize,
    }
  );

  // Process nodes in chunks
  const allTextNodes = [];
  let processedNodes = 0;
  let chunksProcessed = 0;

  for (let i = 0; i < totalNodes; i += chunkSize) {
    const chunkEnd = Math.min(i + chunkSize, totalNodes);
    console.log(
      `Processing chunk ${chunksProcessed + 1}/${totalChunks} (nodes ${i} to ${chunkEnd - 1
      })`
    );

    // Send update before processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processing chunk ${chunksProcessed + 1}/${totalChunks}`,
      {
        currentChunk: chunksProcessed + 1,
        totalChunks,
        textNodesFound: allTextNodes.length,
      }
    );

    const chunkNodes = nodesToProcess.slice(i, chunkEnd);
    const chunkTextNodes = [];

    // Process each node in this chunk
    for (const nodeInfo of chunkNodes) {
      if (nodeInfo.node.type === "TEXT") {
        try {
          const textNodeInfo = await processTextNode(
            nodeInfo.node,
            nodeInfo.parentPath,
            nodeInfo.depth,
            skipHighlight
          );
          if (textNodeInfo) {
            chunkTextNodes.push(textNodeInfo);
          }
        } catch (error) {
          console.error(`Error processing text node: ${error.message}`);
          // Continue with other nodes
        }
      }
      // (No per-node delay: yielding once per chunk below is enough to keep
      // the Figma UI responsive without paying a delay for every node.)
    }

    // Add results from this chunk
    allTextNodes.push(...chunkTextNodes);
    processedNodes += chunkNodes.length;
    chunksProcessed++;

    // Send update after processing chunk
    sendProgressUpdate(
      commandId,
      "scan_text_nodes",
      "in_progress",
      Math.round(5 + (chunksProcessed / totalChunks) * 90), // 5-95% for processing
      totalNodes,
      processedNodes,
      `Processed chunk ${chunksProcessed}/${totalChunks}. Found ${allTextNodes.length} text nodes so far.`,
      {
        currentChunk: chunksProcessed,
        totalChunks,
        processedNodes,
        textNodesFound: allTextNodes.length,
        chunkResult: chunkTextNodes,
      }
    );

    // Yield between chunks to keep the Figma UI responsive. When highlighting
    // we keep a longer pause so the flashes are visible; otherwise just yield.
    if (i + chunkSize < totalNodes) {
      await delay(skipHighlight ? 0 : 50);
    }
  }

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "scan_text_nodes",
    "completed",
    100,
    totalNodes,
    processedNodes,
    `Scan complete. Found ${allTextNodes.length} text nodes.`,
    {
      textNodes: allTextNodes,
      processedNodes,
      chunks: chunksProcessed,
    }
  );

  return {
    success: true,
    message: `Chunked scan complete. Found ${allTextNodes.length} text nodes.`,
    totalNodes: allTextNodes.length,
    processedNodes: processedNodes,
    chunks: chunksProcessed,
    textNodes: allTextNodes,
    commandId,
  };
}

// Helper function to collect all nodes that need to be processed
async function collectNodesToProcess(
  node,
  parentPath = [],
  depth = 0,
  nodesToProcess = []
) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  // Add this node to the processing list
  nodesToProcess.push({
    node: node,
    parentPath: nodePath,
    depth: depth,
  });

  // Recursively add children
  if ("children" in node) {
    for (const child of node.children) {
      await collectNodesToProcess(child, nodePath, depth + 1, nodesToProcess);
    }
  }
}

// Process a single text node
async function processTextNode(node, parentPath, depth, skipHighlight = true) {
  if (node.type !== "TEXT") return null;

  try {
    // Safely extract font information
    let fontFamily = "";
    let fontStyle = "";

    if (node.fontName) {
      if (typeof node.fontName === "object") {
        if ("family" in node.fontName) fontFamily = node.fontName.family;
        if ("style" in node.fontName) fontStyle = node.fontName.style;
      }
    }

    // Create a safe representation of the text node
    const safeTextNode = {
      id: node.id,
      name: node.name || "Text",
      type: node.type,
      characters: node.characters,
      fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
      fontFamily: fontFamily,
      fontStyle: fontStyle,
      x: typeof node.x === "number" ? node.x : 0,
      y: typeof node.y === "number" ? node.y : 0,
      width: typeof node.width === "number" ? node.width : 0,
      height: typeof node.height === "number" ? node.height : 0,
      path: parentPath.join(" > "),
      depth: depth,
    };

    // Highlight the node briefly (optional visual feedback). This is OFF by
    // default because the per-node fill write + delay dominates scan time
    // (e.g. ~50s for 500 nodes); only do it when explicitly requested.
    if (!skipHighlight) {
      try {
        const originalFills = JSON.parse(JSON.stringify(node.fills));
        node.fills = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.3,
          },
        ];

        // Brief delay for the highlight to be visible
        await delay(100);

        try {
          node.fills = originalFills;
        } catch (err) {
          console.error("Error resetting fills:", err);
        }
      } catch (highlightErr) {
        console.error("Error highlighting text node:", highlightErr);
        // Continue anyway, highlighting is just visual feedback
      }
    }

    return safeTextNode;
  } catch (nodeErr) {
    console.error("Error processing text node:", nodeErr);
    return null;
  }
}

// A delay function that returns a promise
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep the original findTextNodes for backward compatibility
async function findTextNodes(node, parentPath = [], depth = 0, textNodes = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Get the path to this node including its name
  const nodePath = [...parentPath, node.name || `Unnamed ${node.type}`];

  if (node.type === "TEXT") {
    try {
      // Safely extract font information to avoid Symbol serialization issues
      let fontFamily = "";
      let fontStyle = "";

      if (node.fontName) {
        if (typeof node.fontName === "object") {
          if ("family" in node.fontName) fontFamily = node.fontName.family;
          if ("style" in node.fontName) fontStyle = node.fontName.style;
        }
      }

      // Create a safe representation of the text node with only serializable properties
      const safeTextNode = {
        id: node.id,
        name: node.name || "Text",
        type: node.type,
        characters: node.characters,
        fontSize: typeof node.fontSize === "number" ? node.fontSize : 0,
        fontFamily: fontFamily,
        fontStyle: fontStyle,
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
        path: nodePath.join(" > "),
        depth: depth,
      };

      // Only highlight the node if it's not being done via API
      try {
        // Safe way to create a temporary highlight without causing serialization issues
        const originalFills = JSON.parse(JSON.stringify(node.fills));
        node.fills = [
          {
            type: "SOLID",
            color: { r: 1, g: 0.5, b: 0 },
            opacity: 0.3,
          },
        ];

        // Promise-based delay instead of setTimeout
        await delay(500);

        try {
          node.fills = originalFills;
        } catch (err) {
          console.error("Error resetting fills:", err);
        }
      } catch (highlightErr) {
        console.error("Error highlighting text node:", highlightErr);
        // Continue anyway, highlighting is just visual feedback
      }

      textNodes.push(safeTextNode);
    } catch (nodeErr) {
      console.error("Error processing text node:", nodeErr);
      // Skip this node but continue with others
    }
  }

  // Recursively process children of container nodes
  if ("children" in node) {
    for (const child of node.children) {
      await findTextNodes(child, nodePath, depth + 1, textNodes);
    }
  }
}

// Replace text in a specific node
async function setMultipleTextContents(params) {
  const { nodeId, text } = params || {};
  const commandId = params.commandId || generateCommandId();

  if (!nodeId || !text || !Array.isArray(text)) {
    const errorMsg = "Missing required parameters: nodeId and text array";

    // Send error progress update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );

    throw new Error(errorMsg);
  }

  console.log(
    `Starting text replacement for node: ${nodeId} with ${text.length} text replacements`
  );

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "started",
    0,
    text.length,
    0,
    `Starting text replacement for ${text.length} nodes`,
    { totalReplacements: text.length }
  );

  // Define the results array and counters
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Split text replacements into chunks of 5
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${text.length} replacements into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "in_progress",
    5, // 5% progress for planning phase
    text.length,
    0,
    `Preparing to replace text in ${text.length} nodes using ${chunks.length} chunks`,
    {
      totalReplacements: text.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } replacements`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Processing text replacements chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process replacements within a chunk in parallel
    const chunkPromises = chunk.map(async (replacement) => {
      if (!replacement.nodeId || replacement.text === undefined) {
        console.error(`Missing nodeId or text for replacement`);
        return {
          success: false,
          nodeId: replacement.nodeId || "unknown",
          error: "Missing nodeId or text in replacement entry",
        };
      }

      try {
        console.log(
          `Attempting to replace text in node: ${replacement.nodeId}`
        );

        // Get the text node to update (just to check it exists and get original text)
        const textNode = await figma.getNodeByIdAsync(replacement.nodeId);

        if (!textNode) {
          console.error(`Text node not found: ${replacement.nodeId}`);
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node not found: ${replacement.nodeId}`,
          };
        }

        if (textNode.type !== "TEXT") {
          console.error(
            `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`
          );
          return {
            success: false,
            nodeId: replacement.nodeId,
            error: `Node is not a text node: ${replacement.nodeId} (type: ${textNode.type})`,
          };
        }

        // Save original text for the result
        const originalText = textNode.characters;
        console.log(`Original text: "${originalText}"`);
        console.log(`Will translate to: "${replacement.text}"`);

        // Highlight the node before changing text
        let originalFills;
        try {
          // Save original fills for restoration later
          originalFills = JSON.parse(JSON.stringify(textNode.fills));
          // Apply highlight color (orange with 30% opacity)
          textNode.fills = [
            {
              type: "SOLID",
              color: { r: 1, g: 0.5, b: 0 },
              opacity: 0.3,
            },
          ];
        } catch (highlightErr) {
          console.error(
            `Error highlighting text node: ${highlightErr.message}`
          );
          // Continue anyway, highlighting is just visual feedback
        }

        // Use the existing setTextContent function to handle font loading and text setting
        await setTextContent({
          nodeId: replacement.nodeId,
          text: replacement.text,
        });

        // Keep highlight for a moment after text change, then restore original fills
        if (originalFills) {
          try {
            // Use delay function for consistent timing
            await delay(500);
            textNode.fills = originalFills;
          } catch (restoreErr) {
            console.error(`Error restoring fills: ${restoreErr.message}`);
          }
        }

        console.log(
          `Successfully replaced text in node: ${replacement.nodeId}`
        );
        return {
          success: true,
          nodeId: replacement.nodeId,
          originalText: originalText,
          translatedText: replacement.text,
        };
      } catch (error) {
        console.error(
          `Error replacing text in node ${replacement.nodeId}: ${error.message}`
        );
        return {
          success: false,
          nodeId: replacement.nodeId,
          error: `Error applying replacement: ${error.message}`,
        };
      }
    });

    // Wait for all replacements in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update with partial results
    sendProgressUpdate(
      commandId,
      "set_multiple_text_contents",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90), // 5-95% for processing
      text.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks to avoid overloading Figma
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks to avoid overloading Figma...");
      await delay(1000); // 1 second delay between chunks
    }
  }

  console.log(
    `Replacement complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "set_multiple_text_contents",
    "completed",
    100,
    text.length,
    successCount + failureCount,
    `Text replacement complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalReplacements: text.length,
      replacementsApplied: successCount,
      replacementsFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodeId: nodeId,
    replacementsApplied: successCount,
    replacementsFailed: failureCount,
    totalReplacements: text.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Function to generate simple UUIDs for command IDs
function generateCommandId() {
  return (
    "cmd_" +
    Math.random().toString(36).substring(2, 15) +
    Math.random().toString(36).substring(2, 15)
  );
}

async function getAnnotations(params) {
  try {
    const { nodeId, includeCategories = true } = params;

    // Get categories first if needed
    let categoriesMap = {};
    if (includeCategories) {
      const categories = await figma.annotations.getAnnotationCategoriesAsync();
      categoriesMap = categories.reduce((map, category) => {
        map[category.id] = {
          id: category.id,
          label: category.label,
          color: category.color,
          isPreset: category.isPreset,
        };
        return map;
      }, {});
    }

    if (nodeId) {
      // Get annotations for a specific node
      const node = await figma.getNodeByIdAsync(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      if (!("annotations" in node)) {
        throw new Error(`Node type ${node.type} does not support annotations`);
      }

      // Collect annotations from this node and all its descendants
      const mergedAnnotations = [];
      // 방문 상한/깊이 제한 — 애니메이션 프레임처럼 자식이 수백 개인 노드에서
      // 무제한 재귀가 응답 시한을 넘겨 조회 자체가 실패하던 것을 막는다.
      const { maxDepth = Infinity, maxNodes = 4000 } = params;
      let visited = 0;
      const collect = async (n, depth = 0) => {
        if (visited >= maxNodes) return;
        visited++;
        if ("annotations" in n && n.annotations && n.annotations.length > 0) {
          for (const a of n.annotations) {
            mergedAnnotations.push({ nodeId: n.id, annotation: a, nodeName: n.name });
          }
        }
        if (depth >= maxDepth) return;
        if ("children" in n) {
          for (const child of n.children) {
            await collect(child, depth + 1);
          }
        }
      };
      await collect(node);

      const result = {
        nodeId: node.id,
        name: node.name,
        annotations: mergedAnnotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    } else {
      // Get all annotations in the current page
      const annotations = [];
      const processNode = async (node) => {
        if (
          "annotations" in node &&
          node.annotations &&
          node.annotations.length > 0
        ) {
          annotations.push({
            nodeId: node.id,
            name: node.name,
            annotations: node.annotations,
          });
        }
        if ("children" in node) {
          for (const child of node.children) {
            await processNode(child);
          }
        }
      };

      // Start from current page
      await processNode(figma.currentPage);

      const result = {
        annotatedNodes: annotations,
      };

      if (includeCategories) {
        result.categories = Object.values(categoriesMap);
      }

      return result;
    }
  } catch (error) {
    console.error("Error in getAnnotations:", error);
    throw error;
  }
}

async function setAnnotation(params) {
  try {
    console.log("=== setAnnotation Debug Start ===");
    console.log("Input params:", JSON.stringify(params, null, 2));

    const { nodeId, annotationId, labelMarkdown, categoryId, properties } =
      params;

    // Validate required parameters
    if (!nodeId) {
      console.error("Validation failed: Missing nodeId");
      return { success: false, error: "Missing nodeId" };
    }

    if (!labelMarkdown) {
      console.error("Validation failed: Missing labelMarkdown");
      return { success: false, error: "Missing labelMarkdown" };
    }

    console.log("Attempting to get node:", nodeId);
    // Get and validate node
    const node = await figma.getNodeByIdAsync(nodeId);
    console.log("Node lookup result:", {
      id: nodeId,
      found: !!node,
      type: node ? node.type : undefined,
      name: node ? node.name : undefined,
      hasAnnotations: node ? "annotations" in node : false,
    });

    if (!node) {
      console.error("Node lookup failed:", nodeId);
      return { success: false, error: `Node not found: ${nodeId}` };
    }

    // Validate node supports annotations
    if (!("annotations" in node)) {
      console.error("Node annotation support check failed:", {
        nodeType: node.type,
        nodeId: node.id,
      });
      return {
        success: false,
        error: `Node type ${node.type} does not support annotations`,
      };
    }

    // Create the annotation object
    const newAnnotation = {
      labelMarkdown,
    };

    // Validate and add categoryId if provided
    if (categoryId) {
      console.log("Adding categoryId to annotation:", categoryId);
      newAnnotation.categoryId = categoryId;
    }

    // Validate and add properties if provided
    if (properties && Array.isArray(properties) && properties.length > 0) {
      console.log(
        "Adding properties to annotation:",
        JSON.stringify(properties, null, 2)
      );
      newAnnotation.properties = properties;
    }

    // Log current annotations before update
    console.log("Current node annotations:", node.annotations);

    // Overwrite annotations
    console.log(
      "Setting new annotation:",
      JSON.stringify(newAnnotation, null, 2)
    );
    node.annotations = [newAnnotation];

    // Verify the update
    console.log("Updated node annotations:", node.annotations);
    console.log("=== setAnnotation Debug End ===");

    return {
      success: true,
      nodeId: node.id,
      name: node.name,
      annotations: node.annotations,
    };
  } catch (error) {
    console.error("=== setAnnotation Error ===");
    console.error("Error details:", {
      message: error.message,
      stack: error.stack,
      params: JSON.stringify(params, null, 2),
    });
    return { success: false, error: error.message };
  }
}

/**
 * Scan for nodes with specific types within a node
 * @param {Object} params - Parameters object
 * @param {string} params.nodeId - ID of the node to scan within
 * @param {Array<string>} params.types - Array of node types to find (e.g. ['COMPONENT', 'FRAME'])
 * @returns {Object} - Object containing found nodes
 */
async function scanNodesByTypes(params) {
  console.log(`Starting to scan nodes by types from node ID: ${params.nodeId}`);
  const { nodeId, types = [] } = params || {};

  if (!types || types.length === 0) {
    throw new Error("No types specified to search for");
  }

  const node = await figma.getNodeByIdAsync(nodeId);

  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Simple implementation without chunking
  const matchingNodes = [];

  // Send a single progress update to notify start
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "scan_nodes_by_types",
    "started",
    0,
    1,
    0,
    `Starting scan of node "${node.name || nodeId}" for types: ${types.join(
      ", "
    )}`,
    null
  );

  // Recursively find nodes with specified types
  const skipped = [];
  await findNodesByTypes(node, types, matchingNodes, skipped);

  const total = matchingNodes.length;
  const { limit, offset = 0, countOnly = false, resolveNames = true } = params || {};

  // Count-only mode: skip enrichment and payload entirely.
  if (countOnly) {
    sendProgressUpdate(commandId, "scan_nodes_by_types", "completed", 100, total, total,
      `Scan complete. Found ${total} matching nodes.`, { total });
    return { success: true, countOnly: true, total: total, searchedTypes: types, skippedContainers: skipped };
  }

  // Paginate, then enrich only the returned slice — so scanning a 762-node
  // section doesn't resolve every main component.
  const start = offset > 0 ? offset : 0;
  const slice =
    limit !== undefined && limit !== null
      ? matchingNodes.slice(start, start + limit)
      : matchingNodes.slice(start);

  // Enrich INSTANCE nodes, but bound the async work (one getMainComponentAsync
  // per instance) so an unpaginated scan of a huge section can't stall.
  // Page with `limit` to enrich beyond the cap.
  const resolver = makeDsResolver(resolveNames);
  const ENRICH_CAP = 300;
  let instanceCount = 0;
  let enrichedCount = 0;
  for (const m of slice) {
    if (m.type !== "INSTANCE") continue;
    instanceCount++;
    if (enrichedCount >= ENRICH_CAP) continue;
    try {
      const live = await figma.getNodeByIdAsync(m.id);
      if (live) {
        if (live.componentProperties) {
          m.componentProperties = simplifyComponentProperties(live.componentProperties);
        }
        m.mainComponent = await resolver.mainComponent(live); // {id,key,remote,name,...}
        enrichedCount++;
      }
    } catch (e) {
      /* leave instance un-enriched on failure */
    }
  }
  const enrichmentTruncated = instanceCount > enrichedCount;

  const nextOffset = start + slice.length < total ? start + slice.length : null;

  sendProgressUpdate(commandId, "scan_nodes_by_types", "completed", 100, total, total,
    `Scan complete. Found ${total} matching nodes (returned ${slice.length}).`, { total });

  return {
    success: true,
    total: total,
    offset: start,
    returned: slice.length,
    nextOffset: nextOffset,
    enrichmentTruncated: enrichmentTruncated, // true if >ENRICH_CAP instances; page for the rest
    // Containers whose children couldn't be read (a descendant node type this
    // plugin API can't classify); their subtrees were skipped, not failed.
    skippedContainers: skipped,
    searchedTypes: types,
    matchingNodes: slice,
  };
}

// Compact instance variant state for scans (name -> {type, value})
function simplifyComponentProperties(cp) {
  const out = {};
  try {
    for (const k of Object.keys(cp)) {
      const p = cp[k];
      out[k] = { type: p.type, value: p.value };
    }
  } catch (e) {}
  return out;
}

/**
 * Helper function to recursively find nodes with specific types
 * @param {SceneNode} node - The root node to start searching from
 * @param {Array<string>} types - Array of node types to find
 * @param {Array} matchingNodes - Array to store found nodes
 */
async function findNodesByTypes(node, types, matchingNodes = [], skipped = []) {
  // Skip invisible nodes
  if (node.visible === false) return;

  // Check if this node is one of the specified types
  if (types.includes(node.type)) {
    // Create a minimal representation with just ID, type and bbox
    matchingNodes.push({
      id: node.id,
      name: node.name || `Unnamed ${node.type}`,
      type: node.type,
      // Basic bounding box info
      bbox: {
        x: typeof node.x === "number" ? node.x : 0,
        y: typeof node.y === "number" ? node.y : 0,
        width: typeof node.width === "number" ? node.width : 0,
        height: typeof node.height === "number" ? node.height : 0,
      },
    });
  }

  // Recursively process children of container nodes. Reading `.children` can
  // throw if a descendant is a node type this plugin API can't classify;
  // skip that subtree (and record it) instead of failing the whole scan.
  if ("children" in node) {
    let kids = null;
    try {
      kids = node.children;
    } catch (e) {
      skipped.push({ id: node.id, name: node.name, type: node.type });
    }
    if (kids) {
      for (const child of kids) {
        await findNodesByTypes(child, types, matchingNodes, skipped);
      }
    }
  }
}

// Set multiple annotations with async progress updates
async function setMultipleAnnotations(params) {
  console.log("=== setMultipleAnnotations Debug Start ===");
  console.log("Input params:", JSON.stringify(params, null, 2));

  const { nodeId, annotations } = params;

  if (!annotations || annotations.length === 0) {
    console.error("Validation failed: No annotations provided");
    return { success: false, error: "No annotations provided" };
  }

  console.log(
    `Processing ${annotations.length} annotations for node ${nodeId}`
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process annotations sequentially
  for (let i = 0; i < annotations.length; i++) {
    const annotation = annotations[i];
    console.log(
      `\nProcessing annotation ${i + 1}/${annotations.length}:`,
      JSON.stringify(annotation, null, 2)
    );

    try {
      console.log("Calling setAnnotation with params:", {
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      const result = await setAnnotation({
        nodeId: annotation.nodeId,
        labelMarkdown: annotation.labelMarkdown,
        categoryId: annotation.categoryId,
        properties: annotation.properties,
      });

      console.log("setAnnotation result:", JSON.stringify(result, null, 2));

      if (result.success) {
        successCount++;
        results.push({ success: true, nodeId: annotation.nodeId });
        console.log(`✓ Annotation ${i + 1} applied successfully`);
      } else {
        failureCount++;
        results.push({
          success: false,
          nodeId: annotation.nodeId,
          error: result.error,
        });
        console.error(`✗ Annotation ${i + 1} failed:`, result.error);
      }
    } catch (error) {
      failureCount++;
      const errorResult = {
        success: false,
        nodeId: annotation.nodeId,
        error: error.message,
      };
      results.push(errorResult);
      console.error(`✗ Annotation ${i + 1} failed with error:`, error);
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
  }

  const summary = {
    success: successCount > 0,
    annotationsApplied: successCount,
    annotationsFailed: failureCount,
    totalAnnotations: annotations.length,
    results: results,
  };

  console.log("\n=== setMultipleAnnotations Summary ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== setMultipleAnnotations Debug End ===");

  return summary;
}

async function deleteMultipleNodes(params) {
  const { nodeIds } = params || {};
  const commandId = generateCommandId();

  if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
    const errorMsg = "Missing or invalid nodeIds parameter";
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "error",
      0,
      0,
      0,
      errorMsg,
      { error: errorMsg }
    );
    throw new Error(errorMsg);
  }

  console.log(`Starting deletion of ${nodeIds.length} nodes`);

  // Send started progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "started",
    0,
    nodeIds.length,
    0,
    `Starting deletion of ${nodeIds.length} nodes`,
    { totalNodes: nodeIds.length }
  );

  const results = [];
  let successCount = 0;
  let failureCount = 0;

  // Process nodes in chunks of 5 to avoid overwhelming Figma
  const CHUNK_SIZE = 5;
  const chunks = [];

  for (let i = 0; i < nodeIds.length; i += CHUNK_SIZE) {
    chunks.push(nodeIds.slice(i, i + CHUNK_SIZE));
  }

  console.log(`Split ${nodeIds.length} deletions into ${chunks.length} chunks`);

  // Send chunking info update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "in_progress",
    5,
    nodeIds.length,
    0,
    `Preparing to delete ${nodeIds.length} nodes using ${chunks.length} chunks`,
    {
      totalNodes: nodeIds.length,
      chunks: chunks.length,
      chunkSize: CHUNK_SIZE,
    }
  );

  // Process each chunk sequentially
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(
      `Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length
      } nodes`
    );

    // Send chunk processing start update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + (chunkIndex / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Processing deletion chunk ${chunkIndex + 1}/${chunks.length}`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
      }
    );

    // Process deletions within a chunk in parallel
    const chunkPromises = chunk.map(async (nodeId) => {
      try {
        const node = await figma.getNodeByIdAsync(nodeId);

        if (!node) {
          console.error(`Node not found: ${nodeId}`);
          return {
            success: false,
            nodeId: nodeId,
            error: `Node not found: ${nodeId}`,
          };
        }

        // Save node info before deleting
        const nodeInfo = {
          id: node.id,
          name: node.name,
          type: node.type,
        };

        // Delete the node
        node.remove();

        console.log(`Successfully deleted node: ${nodeId}`);
        return {
          success: true,
          nodeId: nodeId,
          nodeInfo: nodeInfo,
        };
      } catch (error) {
        console.error(`Error deleting node ${nodeId}: ${error.message}`);
        return {
          success: false,
          nodeId: nodeId,
          error: error.message,
        };
      }
    });

    // Wait for all deletions in this chunk to complete
    const chunkResults = await Promise.all(chunkPromises);

    // Process results for this chunk
    chunkResults.forEach((result) => {
      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
      results.push(result);
    });

    // Send chunk processing complete update
    sendProgressUpdate(
      commandId,
      "delete_multiple_nodes",
      "in_progress",
      Math.round(5 + ((chunkIndex + 1) / chunks.length) * 90),
      nodeIds.length,
      successCount + failureCount,
      `Completed chunk ${chunkIndex + 1}/${chunks.length
      }. ${successCount} successful, ${failureCount} failed so far.`,
      {
        currentChunk: chunkIndex + 1,
        totalChunks: chunks.length,
        successCount,
        failureCount,
        chunkResults: chunkResults,
      }
    );

    // Add a small delay between chunks
    if (chunkIndex < chunks.length - 1) {
      console.log("Pausing between chunks...");
      await delay(1000);
    }
  }

  console.log(
    `Deletion complete: ${successCount} successful, ${failureCount} failed`
  );

  // Send completed progress update
  sendProgressUpdate(
    commandId,
    "delete_multiple_nodes",
    "completed",
    100,
    nodeIds.length,
    successCount + failureCount,
    `Node deletion complete: ${successCount} successful, ${failureCount} failed`,
    {
      totalNodes: nodeIds.length,
      nodesDeleted: successCount,
      nodesFailed: failureCount,
      completedInChunks: chunks.length,
      results: results,
    }
  );

  return {
    success: successCount > 0,
    nodesDeleted: successCount,
    nodesFailed: failureCount,
    totalNodes: nodeIds.length,
    results: results,
    completedInChunks: chunks.length,
    commandId,
  };
}

// Implementation for getInstanceOverrides function
async function getInstanceOverrides(instanceNode = null) {
  console.log("=== getInstanceOverrides called ===");

  let sourceInstance = null;

  // Check if an instance node was passed directly
  if (instanceNode) {
    console.log("Using provided instance node");

    // Validate that the provided node is an instance
    if (instanceNode.type !== "INSTANCE") {
      console.error("Provided node is not an instance");
      figma.notify("Provided node is not a component instance");
      return { success: false, message: "Provided node is not a component instance" };
    }

    sourceInstance = instanceNode;
  } else {
    // No node provided, use selection
    console.log("No node provided, using current selection");

    // Get the current selection
    const selection = figma.currentPage.selection;

    // Check if there's anything selected
    if (selection.length === 0) {
      console.log("No nodes selected");
      figma.notify("Please select at least one instance");
      return { success: false, message: "No nodes selected" };
    }

    // Filter for instances in the selection
    const instances = selection.filter(node => node.type === "INSTANCE");

    if (instances.length === 0) {
      console.log("No instances found in selection");
      figma.notify("Please select at least one component instance");
      return { success: false, message: "No instances found in selection" };
    }

    // Take the first instance from the selection
    sourceInstance = instances[0];
  }

  try {
    console.log(`Getting instance information:`);
    console.log(sourceInstance);

    // Get component overrides and main component
    const overrides = sourceInstance.overrides || [];
    console.log(`  Raw Overrides:`, overrides);

    // Get main component
    const mainComponent = await sourceInstance.getMainComponentAsync();
    if (!mainComponent) {
      console.error("Failed to get main component");
      figma.notify("Failed to get main component");
      return { success: false, message: "Failed to get main component" };
    }

    // return data to MCP server
    const returnData = {
      success: true,
      message: `Got component information from "${sourceInstance.name}" for overrides.length: ${overrides.length}`,
      sourceInstanceId: sourceInstance.id,
      mainComponentId: mainComponent.id,
      overridesCount: overrides.length
    };

    console.log("Data to return to MCP server:", returnData);
    figma.notify(`Got component information from "${sourceInstance.name}"`);

    return returnData;
  } catch (error) {
    console.error("Error in getInstanceOverrides:", error);
    figma.notify(`Error: ${error.message}`);
    return {
      success: false,
      message: `Error: ${error.message}`
    };
  }
}

/**
 * Helper function to validate and get target instances
 * @param {string[]} targetNodeIds - Array of instance node IDs
 * @returns {instanceNode[]} targetInstances - Array of target instances
 */
async function getValidTargetInstances(targetNodeIds) {
  let targetInstances = [];

  // Handle array of instances or single instance
  if (Array.isArray(targetNodeIds)) {
    if (targetNodeIds.length === 0) {
      return { success: false, message: "No instances provided" };
    }
    for (const targetNodeId of targetNodeIds) {
      const targetNode = await figma.getNodeByIdAsync(targetNodeId);
      if (targetNode && targetNode.type === "INSTANCE") {
        targetInstances.push(targetNode);
      }
    }
    if (targetInstances.length === 0) {
      return { success: false, message: "No valid instances provided" };
    }
  } else {
    return { success: false, message: "Invalid target node IDs provided" };
  }


  return { success: true, message: "Valid target instances provided", targetInstances };
}

/**
 * Helper function to validate and get saved override data
 * @param {string} sourceInstanceId - Source instance ID
 * @returns {Promise<Object>} - Validation result with source instance data or error
 */
async function getSourceInstanceData(sourceInstanceId) {
  if (!sourceInstanceId) {
    return { success: false, message: "Missing source instance ID" };
  }

  // Get source instance by ID
  const sourceInstance = await figma.getNodeByIdAsync(sourceInstanceId);
  if (!sourceInstance) {
    return {
      success: false,
      message: "Source instance not found. The original instance may have been deleted."
    };
  }

  // Verify it's an instance
  if (sourceInstance.type !== "INSTANCE") {
    return {
      success: false,
      message: "Source node is not a component instance."
    };
  }

  // Get main component
  const mainComponent = await sourceInstance.getMainComponentAsync();
  if (!mainComponent) {
    return {
      success: false,
      message: "Failed to get main component from source instance."
    };
  }

  return {
    success: true,
    sourceInstance,
    mainComponent,
    overrides: sourceInstance.overrides || []
  };
}

/**
 * Sets saved overrides to the selected component instance(s)
 * @param {InstanceNode[] | null} targetInstances - Array of instance nodes to set overrides to
 * @param {Object} sourceResult - Source instance data from getSourceInstanceData
 * @returns {Promise<Object>} - Result of the set operation
 */
async function setInstanceOverrides(targetInstances, sourceResult) {
  try {


    const { sourceInstance, mainComponent, overrides } = sourceResult;

    console.log(`Processing ${targetInstances.length} instances with ${overrides.length} overrides`);
    console.log(`Source instance: ${sourceInstance.id}, Main component: ${mainComponent.id}`);
    console.log(`Overrides:`, overrides);

    // Process all instances
    const results = [];
    let totalAppliedCount = 0;

    for (const targetInstance of targetInstances) {
      try {
        // // Skip if trying to apply to the source instance itself
        // if (targetInstance.id === sourceInstance.id) {
        //   console.log(`Skipping source instance itself: ${targetInstance.id}`);
        //   results.push({
        //     success: false,
        //     instanceId: targetInstance.id,
        //     instanceName: targetInstance.name,
        //     message: "This is the source instance itself, skipping"
        //   });
        //   continue;
        // }

        // Swap component
        try {
          targetInstance.swapComponent(mainComponent);
          console.log(`Swapped component for instance "${targetInstance.name}"`);
        } catch (error) {
          console.error(`Error swapping component for instance "${targetInstance.name}":`, error);
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: `Error: ${error.message}`
          });
        }

        // Prepare overrides by replacing node IDs
        let appliedCount = 0;

        // Apply each override
        for (const override of overrides) {
          // Skip if no ID or overriddenFields
          if (!override.id || !override.overriddenFields || override.overriddenFields.length === 0) {
            continue;
          }

          // Replace source instance ID with target instance ID in the node path
          const overrideNodeId = override.id.replace(sourceInstance.id, targetInstance.id);
          const overrideNode = await figma.getNodeByIdAsync(overrideNodeId);

          if (!overrideNode) {
            console.log(`Override node not found: ${overrideNodeId}`);
            continue;
          }

          // Get source node to copy properties from
          const sourceNode = await figma.getNodeByIdAsync(override.id);
          if (!sourceNode) {
            console.log(`Source node not found: ${override.id}`);
            continue;
          }

          // Apply each overridden field
          let fieldApplied = false;
          for (const field of override.overriddenFields) {
            try {
              if (field === "componentProperties") {
                // Apply component properties
                if (sourceNode.componentProperties && overrideNode.componentProperties) {
                  const properties = {};
                  for (const key in sourceNode.componentProperties) {
                    // if INSTANCE_SWAP use id, otherwise use value
                    if (sourceNode.componentProperties[key].type === 'INSTANCE_SWAP') {
                      properties[key] = sourceNode.componentProperties[key].value;
                    
                    } else {
                      properties[key] = sourceNode.componentProperties[key].value;
                    }
                  }
                  overrideNode.setProperties(properties);
                  fieldApplied = true;
                }
              } else if (field === "characters" && overrideNode.type === "TEXT") {
                // For text nodes, need to load fonts first
                await figma.loadFontAsync(overrideNode.fontName);
                overrideNode.characters = sourceNode.characters;
                fieldApplied = true;
              } else if (field in overrideNode) {
                // Direct property assignment
                overrideNode[field] = sourceNode[field];
                fieldApplied = true;
              }
            } catch (fieldError) {
              console.error(`Error applying field ${field}:`, fieldError);
            }
          }

          if (fieldApplied) {
            appliedCount++;
          }
        }

        if (appliedCount > 0) {
          totalAppliedCount += appliedCount;
          results.push({
            success: true,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            appliedCount
          });
          console.log(`Applied ${appliedCount} overrides to "${targetInstance.name}"`);
        } else {
          results.push({
            success: false,
            instanceId: targetInstance.id,
            instanceName: targetInstance.name,
            message: "No overrides were applied"
          });
        }
      } catch (instanceError) {
        console.error(`Error processing instance "${targetInstance.name}":`, instanceError);
        results.push({
          success: false,
          instanceId: targetInstance.id,
          instanceName: targetInstance.name,
          message: `Error: ${instanceError.message}`
        });
      }
    }

    // Return results
    if (totalAppliedCount > 0) {
      const instanceCount = results.filter(r => r.success).length;
      const message = `Applied ${totalAppliedCount} overrides to ${instanceCount} instances`;
      figma.notify(message);
      return {
        success: true,
        message,
        totalCount: totalAppliedCount,
        results
      };
    } else {
      const message = "No overrides applied to any instance";
      figma.notify(message);
      return { success: false, message, results };
    }

  } catch (error) {
    console.error("Error in setInstanceOverrides:", error);
    const message = `Error: ${error.message}`;
    figma.notify(message);
    return { success: false, message };
  }
}

async function setLayoutMode(params) {
  const { nodeId, layoutMode = "NONE", layoutWrap = "NO_WRAP" } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layoutMode
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layoutMode`);
  }

  // Set layout mode
  node.layoutMode = layoutMode;

  // Set layoutWrap if applicable
  if (layoutMode !== "NONE") {
    node.layoutWrap = layoutWrap;
  }

  return {
    id: node.id,
    name: node.name,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setPadding(params) {
  const { nodeId, paddingTop, paddingRight, paddingBottom, paddingLeft } =
    params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports padding
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support padding`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Padding can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set padding values if provided
  if (paddingTop !== undefined) node.paddingTop = paddingTop;
  if (paddingRight !== undefined) node.paddingRight = paddingRight;
  if (paddingBottom !== undefined) node.paddingBottom = paddingBottom;
  if (paddingLeft !== undefined) node.paddingLeft = paddingLeft;

  return {
    id: node.id,
    name: node.name,
    paddingTop: node.paddingTop,
    paddingRight: node.paddingRight,
    paddingBottom: node.paddingBottom,
    paddingLeft: node.paddingLeft,
  };
}

async function setAxisAlign(params) {
  const { nodeId, primaryAxisAlignItems, counterAxisAlignItems } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports axis alignment
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support axis alignment`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Axis alignment can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set primaryAxisAlignItems if provided
  if (primaryAxisAlignItems !== undefined) {
    if (
      !["MIN", "MAX", "CENTER", "SPACE_BETWEEN"].includes(primaryAxisAlignItems)
    ) {
      throw new Error(
        "Invalid primaryAxisAlignItems value. Must be one of: MIN, MAX, CENTER, SPACE_BETWEEN"
      );
    }
    node.primaryAxisAlignItems = primaryAxisAlignItems;
  }

  // Validate and set counterAxisAlignItems if provided
  if (counterAxisAlignItems !== undefined) {
    if (!["MIN", "MAX", "CENTER", "BASELINE"].includes(counterAxisAlignItems)) {
      throw new Error(
        "Invalid counterAxisAlignItems value. Must be one of: MIN, MAX, CENTER, BASELINE"
      );
    }
    // BASELINE is only valid for horizontal layout
    if (
      counterAxisAlignItems === "BASELINE" &&
      node.layoutMode !== "HORIZONTAL"
    ) {
      throw new Error(
        "BASELINE alignment is only valid for horizontal auto-layout frames"
      );
    }
    node.counterAxisAlignItems = counterAxisAlignItems;
  }

  return {
    id: node.id,
    name: node.name,
    primaryAxisAlignItems: node.primaryAxisAlignItems,
    counterAxisAlignItems: node.counterAxisAlignItems,
    layoutMode: node.layoutMode,
  };
}

async function setLayoutSizing(params) {
  const { nodeId, layoutSizingHorizontal, layoutSizingVertical } = params || {};

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports layout sizing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support layout sizing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Layout sizing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Validate and set layoutSizingHorizontal if provided
  if (layoutSizingHorizontal !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingHorizontal)) {
      throw new Error(
        "Invalid layoutSizingHorizontal value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingHorizontal === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingHorizontal === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingHorizontal = layoutSizingHorizontal;
  }

  // Validate and set layoutSizingVertical if provided
  if (layoutSizingVertical !== undefined) {
    if (!["FIXED", "HUG", "FILL"].includes(layoutSizingVertical)) {
      throw new Error(
        "Invalid layoutSizingVertical value. Must be one of: FIXED, HUG, FILL"
      );
    }
    // HUG is only valid on auto-layout frames and text nodes
    if (
      layoutSizingVertical === "HUG" &&
      !["FRAME", "TEXT"].includes(node.type)
    ) {
      throw new Error(
        "HUG sizing is only valid on auto-layout frames and text nodes"
      );
    }
    // FILL is only valid on auto-layout children
    if (
      layoutSizingVertical === "FILL" &&
      (!node.parent || node.parent.layoutMode === "NONE")
    ) {
      throw new Error("FILL sizing is only valid on auto-layout children");
    }
    node.layoutSizingVertical = layoutSizingVertical;
  }

  return {
    id: node.id,
    name: node.name,
    layoutSizingHorizontal: node.layoutSizingHorizontal,
    layoutSizingVertical: node.layoutSizingVertical,
    layoutMode: node.layoutMode,
  };
}

async function setItemSpacing(params) {
  const { nodeId, itemSpacing, counterAxisSpacing } = params || {};

  // Validate that at least one spacing parameter is provided
  if (itemSpacing === undefined && counterAxisSpacing === undefined) {
    throw new Error("At least one of itemSpacing or counterAxisSpacing must be provided");
  }

  // Get the target node
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    throw new Error(`Node with ID ${nodeId} not found`);
  }

  // Check if node is a frame or component that supports item spacing
  if (
    node.type !== "FRAME" &&
    node.type !== "COMPONENT" &&
    node.type !== "COMPONENT_SET" &&
    node.type !== "INSTANCE"
  ) {
    throw new Error(`Node type ${node.type} does not support item spacing`);
  }

  // Check if the node has auto-layout enabled
  if (node.layoutMode === "NONE") {
    throw new Error(
      "Item spacing can only be set on auto-layout frames (layoutMode must not be NONE)"
    );
  }

  // Set item spacing if provided
  if (itemSpacing !== undefined) {
    if (typeof itemSpacing !== "number") {
      throw new Error("Item spacing must be a number");
    }
    node.itemSpacing = itemSpacing;
  }

  // Set counter axis spacing if provided
  if (counterAxisSpacing !== undefined) {
    if (typeof counterAxisSpacing !== "number") {
      throw new Error("Counter axis spacing must be a number");
    }
    // counterAxisSpacing only applies when layoutWrap is WRAP
    if (node.layoutWrap !== "WRAP") {
      throw new Error(
        "Counter axis spacing can only be set on frames with layoutWrap set to WRAP"
      );
    }
    node.counterAxisSpacing = counterAxisSpacing;
  }

  return {
    id: node.id,
    name: node.name,
    itemSpacing: node.itemSpacing || undefined,
    counterAxisSpacing: node.counterAxisSpacing || undefined,
    layoutMode: node.layoutMode,
    layoutWrap: node.layoutWrap,
  };
}

async function setDefaultConnector(params) {
  const { connectorId } = params || {};
  
  // If connectorId is provided, search and set by that ID (do not check existing storage)
  if (connectorId) {
    // Get node by specified ID
    const node = await figma.getNodeByIdAsync(connectorId);
    if (!node) {
      throw new Error(`Connector node not found with ID: ${connectorId}`);
    }
    
    // Check node type
    if (node.type !== 'CONNECTOR') {
      throw new Error(`Node is not a connector: ${connectorId}`);
    }
    
    // Set the found connector as the default connector
    await figma.clientStorage.setAsync('defaultConnectorId', connectorId);
    
    return {
      success: true,
      message: `Default connector set to: ${connectorId}`,
      connectorId: connectorId
    };
  } 
  // If connectorId is not provided, check existing storage
  else {
    // Check if there is an existing default connector in client storage
    try {
      const existingConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
      
      // If there is an existing connector ID, check if the node is still valid
      if (existingConnectorId) {
        try {
          const existingConnector = await figma.getNodeByIdAsync(existingConnectorId);
          
          // If the stored connector still exists and is of type CONNECTOR
          if (existingConnector && existingConnector.type === 'CONNECTOR') {
            return {
              success: true,
              message: `Default connector is already set to: ${existingConnectorId}`,
              connectorId: existingConnectorId,
              exists: true
            };
          }
          // The stored connector is no longer valid - find a new connector
          else {
            console.log(`Stored connector ID ${existingConnectorId} is no longer valid, finding a new connector...`);
          }
        } catch (error) {
          console.log(`Error finding stored connector: ${error.message}. Will try to set a new one.`);
        }
      }
    } catch (error) {
      console.log(`Error checking for existing connector: ${error.message}`);
    }
    
    // If there is no stored default connector or it is invalid, find one in the current page
    try {
      // Find CONNECTOR type nodes in the current page
      const currentPageConnectors = figma.currentPage.findAllWithCriteria({ types: ['CONNECTOR'] });
      
      if (currentPageConnectors && currentPageConnectors.length > 0) {
        // Use the first connector found
        const foundConnector = currentPageConnectors[0];
        const autoFoundId = foundConnector.id;
        
        // Set the found connector as the default connector
        await figma.clientStorage.setAsync('defaultConnectorId', autoFoundId);
        
        return {
          success: true,
          message: `Automatically found and set default connector to: ${autoFoundId}`,
          connectorId: autoFoundId,
          autoSelected: true
        };
      } else {
        // If no connector is found in the current page, show a guide message
        throw new Error('No connector found in the current page. Please create a connector in Figma first or specify a connector ID.');
      }
    } catch (error) {
      // Error occurred while running findAllWithCriteria
      throw new Error(`Failed to find a connector: ${error.message}`);
    }
  }
}

async function createCursorNode(targetNodeId) {
  const svgString = `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16 8V35.2419L22 28.4315L27 39.7823C27 39.7823 28.3526 40.2722 29 39.7823C29.6474 39.2924 30.2913 38.3057 30 37.5121C28.6247 33.7654 25 26.1613 25 26.1613H32L16 8Z" fill="#202125" />
  </svg>`;
  try {
    const targetNode = await figma.getNodeByIdAsync(targetNodeId);
    if (!targetNode) throw new Error("Target node not found");

    // The targetNodeId has semicolons since it is a nested node.
    // So we need to get the parent node ID from the target node ID and check if we can appendChild to it or not.
    let parentNodeId = targetNodeId.includes(';') 
      ? targetNodeId.split(';')[0] 
      : targetNodeId;
    if (!parentNodeId) throw new Error("Could not determine parent node ID");

    // Find the parent node to append cursor node as child
    let parentNode = await figma.getNodeByIdAsync(parentNodeId);
    if (!parentNode) throw new Error("Parent node not found");

    // If the parent node is not eligible to appendChild, set the parentNode to the parent of the parentNode
    if (parentNode.type === 'INSTANCE' || parentNode.type === 'COMPONENT' || parentNode.type === 'COMPONENT_SET') {
      parentNode = parentNode.parent;
      if (!parentNode) throw new Error("Parent node not found");
    }

    // Create the cursor node
    const importedNode = await figma.createNodeFromSvg(svgString);
    if (!importedNode || !importedNode.id) {
      throw new Error("Failed to create imported cursor node");
    }
    importedNode.name = "TTF_Connector / Mouse Cursor";
    importedNode.resize(48, 48);

    const cursorNode = importedNode.findOne(node => node.type === 'VECTOR');
    if (cursorNode) {
      cursorNode.fills = [{
        type: 'SOLID',
        color: { r: 0, g: 0, b: 0 },
        opacity: 1
      }];
      cursorNode.strokes = [{
        type: 'SOLID',
        color: { r: 1, g: 1, b: 1 },
        opacity: 1
      }];
      cursorNode.strokeWeight = 2;
      cursorNode.strokeAlign = 'OUTSIDE';
      cursorNode.effects = [{
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: 0.3 },
        offset: { x: 1, y: 1 },
        radius: 2,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }];
    }

    // Append the cursor node to the parent node
    parentNode.appendChild(importedNode);

    // if the parentNode has auto-layout enabled, set the layoutPositioning to ABSOLUTE
    if ('layoutMode' in parentNode && parentNode.layoutMode !== 'NONE') {
      importedNode.layoutPositioning = 'ABSOLUTE';
    }

    // Adjust the importedNode's position to the targetNode's position
    if (
      targetNode.absoluteBoundingBox &&
      parentNode.absoluteBoundingBox
    ) {
      // if the targetNode has absoluteBoundingBox, set the importedNode's absoluteBoundingBox to the targetNode's absoluteBoundingBox
      console.log('targetNode.absoluteBoundingBox', targetNode.absoluteBoundingBox);
      console.log('parentNode.absoluteBoundingBox', parentNode.absoluteBoundingBox);
      importedNode.x = targetNode.absoluteBoundingBox.x - parentNode.absoluteBoundingBox.x  + targetNode.absoluteBoundingBox.width / 2 - 48 / 2
      importedNode.y = targetNode.absoluteBoundingBox.y - parentNode.absoluteBoundingBox.y + targetNode.absoluteBoundingBox.height / 2 - 48 / 2;
    } else if (
      'x' in targetNode && 'y' in targetNode && 'width' in targetNode && 'height' in targetNode) {
        // if the targetNode has x, y, width, height, calculate center based on relative position
        console.log('targetNode.x/y/width/height', targetNode.x, targetNode.y, targetNode.width, targetNode.height);
        importedNode.x = targetNode.x + targetNode.width / 2 - 48 / 2;
        importedNode.y = targetNode.y + targetNode.height / 2 - 48 / 2;
    } else {
      // Fallback: Place at top-left of target if possible, otherwise at (0,0) relative to parent
      if ('x' in targetNode && 'y' in targetNode) {
        console.log('Fallback to targetNode x/y');
        importedNode.x = targetNode.x;
        importedNode.y = targetNode.y;
      } else {
        console.log('Fallback to (0,0)');
        importedNode.x = 0;
        importedNode.y = 0;
      }
    }

    // get the importedNode ID and the importedNode
    console.log('importedNode', importedNode);


    return { id: importedNode.id, node: importedNode };
    
  } catch (error) {
    console.error("Error creating cursor from SVG:", error);
    return { id: null, node: null, error: error.message };
  }
}

async function createConnections(params) {
  if (!params || !params.connections || !Array.isArray(params.connections)) {
    throw new Error('Missing or invalid connections parameter');
  }
  
  const { connections } = params;
  
  // Command ID for progress tracking
  const commandId = generateCommandId();
  sendProgressUpdate(
    commandId,
    "create_connections",
    "started",
    0,
    connections.length,
    0,
    `Starting to create ${connections.length} connections`
  );
  
  // Get default connector ID from client storage
  const defaultConnectorId = await figma.clientStorage.getAsync('defaultConnectorId');
  if (!defaultConnectorId) {
    throw new Error('No default connector set. Please try one of the following options to create connections:\n1. Create a connector in FigJam and copy/paste it to your current page, then run the "set_default_connector" command.\n2. Select an existing connector on the current page, then run the "set_default_connector" command.');
  }
  
  // Get the default connector
  const defaultConnector = await figma.getNodeByIdAsync(defaultConnectorId);
  if (!defaultConnector) {
    throw new Error(`Default connector not found with ID: ${defaultConnectorId}`);
  }
  if (defaultConnector.type !== 'CONNECTOR') {
    throw new Error(`Node is not a connector: ${defaultConnectorId}`);
  }
  
  // Results array for connection creation
  const results = [];
  let processedCount = 0;
  const totalCount = connections.length;
  
  // Preload fonts (used for text if provided)
  let fontLoaded = false;
  
  for (let i = 0; i < connections.length; i++) {
    try {
      const { startNodeId: originalStartId, endNodeId: originalEndId, text } = connections[i];
      let startId = originalStartId;
      let endId = originalEndId;

      // Check and potentially replace start node ID
      if (startId.includes(';')) {
        console.log(`Nested start node detected: ${startId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(startId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested start node: ${startId}`);
        }
        startId = cursorResult.id; 
      }  
      
      const startNode = await figma.getNodeByIdAsync(startId);
      if (!startNode) throw new Error(`Start node not found with ID: ${startId}`);

      // Check and potentially replace end node ID
      if (endId.includes(';')) {
        console.log(`Nested end node detected: ${endId}. Creating cursor node.`);
        const cursorResult = await createCursorNode(endId);
        if (!cursorResult || !cursorResult.id) {
          throw new Error(`Failed to create cursor node for nested end node: ${endId}`);
        }
        endId = cursorResult.id;
      }
      const endNode = await figma.getNodeByIdAsync(endId);
      if (!endNode) throw new Error(`End node not found with ID: ${endId}`);

      
      // Clone the default connector
      const clonedConnector = defaultConnector.clone();
      
      // Update connector name using potentially replaced node names
      clonedConnector.name = `TTF_Connector/${startNode.id}/${endNode.id}`;
      
      // Set start and end points using potentially replaced IDs
      clonedConnector.connectorStart = {
        endpointNodeId: startId,
        magnet: 'AUTO'
      };
      
      clonedConnector.connectorEnd = {
        endpointNodeId: endId,
        magnet: 'AUTO'
      };
      
      // Add text (if provided)
      if (text) {
        try {
          // Try to load the necessary fonts
          try {
            // First check if default connector has font and use the same
            if (defaultConnector.text && defaultConnector.text.fontName) {
              const fontName = defaultConnector.text.fontName;
              await figma.loadFontAsync(fontName);
              clonedConnector.text.fontName = fontName;
            } else {
              // Try default Inter font
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            }
          } catch (fontError) {
            // If first font load fails, try another font style
            try {
              await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            } catch (mediumFontError) {
              // If second font fails, try system font
              try {
                await figma.loadFontAsync({ family: "System", style: "Regular" });
              } catch (systemFontError) {
                // If all font loading attempts fail, throw error
                throw new Error(`Failed to load any font: ${fontError.message}`);
              }
            }
          }
          
          // Set the text
          clonedConnector.text.characters = text;
        } catch (textError) {
          console.error("Error setting text:", textError);
          // Continue with connection even if text setting fails
          results.push({
            id: clonedConnector.id,
            startNodeId: startNodeId,
            endNodeId: endNodeId,
            text: "",
            textError: textError.message
          });
          
          // Continue to next connection
          continue;
        }
      }
      
      // Add to results (using the *original* IDs for reference if needed)
      results.push({
        id: clonedConnector.id,
        originalStartNodeId: originalStartId,
        originalEndNodeId: originalEndId,
        usedStartNodeId: startId, // ID actually used for connection
        usedEndNodeId: endId,     // ID actually used for connection
        text: text || ""
      });
      
      // Update progress
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Created connection ${processedCount}/${totalCount}`
      );
      
    } catch (error) {
      console.error("Error creating connection", error);
      // Continue processing remaining connections even if an error occurs
      processedCount++;
      sendProgressUpdate(
        commandId,
        "create_connections",
        "in_progress",
        processedCount / totalCount,
        totalCount,
        processedCount,
        `Error creating connection: ${error.message}`
      );
      
      results.push({
        error: error.message,
        connectionInfo: connections[i]
      });
    }
  }
  
  // Completion update
  sendProgressUpdate(
    commandId,
    "create_connections",
    "completed",
    1,
    totalCount,
    totalCount,
    `Completed creating ${results.length} connections`
  );
  
  return {
    success: true,
    count: results.length,
    connections: results
  };
}

// ── 노드에 붙는 데이터 (SSOT 를 파일이 아니라 문서에 두기 위한 것) ──
//
// **왜 sharedPluginData 인가** — `setPluginData` 는 쓴 플러그인만 읽을 수 있다.
// 위젯이나 다른 플러그인에서도 같은 데이터를 만지려면 네임스페이스를 공유해야 한다.
//
// 값은 문자열만 담긴다(JSON 을 직렬화해 넣는다). 키 하나가 너무 커지면 잘리므로
// 로케일별로 키를 나누는 편이 안전하다 (`listing:it` 처럼).
async function setNodeData(params) {
  const { nodeId, namespace = "gymwork_aso", key, value } = params || {};
  if (!nodeId || !key) throw new Error("Missing nodeId or key");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  node.setSharedPluginData(namespace, key, text);
  // 실제로 들어갔는지 되읽어 확인한다 — 상한을 넘기면 조용히 잘린다.
  const back = node.getSharedPluginData(namespace, key);
  return {
    id: node.id, namespace, key,
    bytes: text.length,
    stored: back.length,
    truncated: back.length !== text.length,
  };
}

async function getNodeData(params) {
  const { nodeId, namespace = "gymwork_aso", key } = params || {};
  if (!nodeId) throw new Error("Missing nodeId");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  const keys = node.getSharedPluginDataKeys(namespace);
  if (key) {
    const v = node.getSharedPluginData(namespace, key);
    return { id: node.id, namespace, key, value: v || null, keys };
  }
  const out = {};
  for (const k of keys) out[k] = node.getSharedPluginData(namespace, k);
  return { id: node.id, namespace, keys, values: out };
}

async function deleteNodeData(params) {
  const { nodeId, namespace = "gymwork_aso", key } = params || {};
  if (!nodeId || !key) throw new Error("Missing nodeId or key");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  node.setSharedPluginData(namespace, key, ""); // 빈 문자열이 곧 삭제다
  return { id: node.id, namespace, key, deleted: true };
}

// 인스턴스를 일반 프레임으로 분리한다.
//
// **왜 필요한가** — Figma 는 인스턴스 내부 자식의 순서도 x 좌표도 못 바꾸게 막는다
// ("This property cannot be overridden in an instance"). RTL 로 뒤집으려면 그 벽을 넘어야 하는데,
// 마스터를 고치면 모든 언어가 같이 바뀌므로 이 행만 분리하는 게 맞다.
// ASO 자산은 일회성 산출물이라 컴포넌트 연결이 사라져도 잃는 게 없다.
async function detachInstance(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== "INSTANCE") return { id: node.id, type: node.type, detached: false };
  const frame = node.detachInstance();
  return { id: frame.id, name: frame.name, type: frame.type, detached: true };
}

// 아랍어처럼 오른쪽에서 왼쪽으로 읽는 언어를 위해 가로 배치를 뒤집는다.
//
// **왜 자식 순서인가** — 오토레이아웃 행은 자식 순서가 곧 화면 순서다. 좌표를 옮겨 봐야
// 레이아웃이 다시 계산하며 원래대로 돌아간다. 절대배치 컨테이너는 반대로 순서가 무의미하므로
// x 를 거울처럼 뒤집어야 한다 — 그래서 둘 다 지원한다.
async function mirrorHorizontal(params) {
  const { nodeId, mode = "auto" } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (!("children" in node)) throw new Error(`Node has no children: ${nodeId}`);

  const isAuto = "layoutMode" in node && node.layoutMode === "HORIZONTAL";
  const use = mode === "auto" ? (isAuto ? "order" : "position") : mode;

  if (use === "order") {
    // 뒤에서부터 다시 append 하면 순서가 뒤집힌다.
    const kids = [...node.children];
    for (let i = kids.length - 1; i >= 0; i -= 1) node.appendChild(kids[i]);
    return { id: node.id, mode: "order", count: kids.length, layoutMode: node.layoutMode };
  }

  const W = node.width;
  const moved = [];
  for (const c of node.children) {
    if (!("x" in c)) continue;
    const nx = W - c.x - c.width;
    c.x = nx;
    moved.push({ id: c.id, from: c.x, to: nx });
  }
  return { id: node.id, mode: "position", count: moved.length, width: W };
}

// 텍스트 정렬. RTL 로 뒤집을 때 좌정렬 문구는 우정렬로 가야 읽는 방향과 맞는다.
async function setTextAlign(params) {
  const { nodeId, horizontal, vertical } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== "TEXT") throw new Error(`Not a text node: ${nodeId}`);
  if (horizontal) node.textAlignHorizontal = horizontal;
  if (vertical) node.textAlignVertical = vertical;
  return { id: node.id, textAlignHorizontal: node.textAlignHorizontal, textAlignVertical: node.textAlignVertical };
}

const TEXT_SEGMENT_PROPS = [
  "fontSize", "fontName", "fills", "fontWeight",
  "lineHeight", "letterSpacing", "textCase", "textDecoration",
];

// 한 텍스트 노드 안의 구간별 스타일을 읽는다.
//
// **왜 필요한가** — `node.characters = "..."` 는 첫 글자의 스타일을 문자열 전체에 발라 버린다.
// ASO 타이틀은 "Share Your Win"(큼) + "#WorkoutComplete"(작음) 처럼 한 노드 안에 크기가
// 섞여 있는 경우가 많아서, 그냥 번역문을 넣으면 크기 차이가 조용히 사라진다.
async function getTextSegments(params) {
  const { nodeId } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== "TEXT") throw new Error(`Not a text node: ${nodeId}`);

  const segments = node.getStyledTextSegments(TEXT_SEGMENT_PROPS);
  return {
    id: node.id,
    characters: node.characters,
    mixed: segments.length > 1,
    segments: segments.map((s) => ({
      characters: s.characters, start: s.start, end: s.end,
      fontSize: s.fontSize, fontName: s.fontName, fills: s.fills,
      lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
      textCase: s.textCase, textDecoration: s.textDecoration,
    })),
  };
}

// 구간 스타일을 유지한 채 텍스트를 갈아 끼운다. segments = [{characters, fontSize, fontName, ...}].
// 전체 문자열을 한 번에 쓴 뒤 구간마다 스타일을 다시 발라 준다 — 순서를 뒤집으면
// characters 대입이 방금 칠한 스타일을 도로 지운다.
async function setTextSegments(params) {
  const { nodeId, segments } = params || {};
  if (!nodeId || !Array.isArray(segments) || segments.length === 0) {
    throw new Error("Missing nodeId or segments");
  }
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type !== "TEXT") throw new Error(`Not a text node: ${nodeId}`);

  const fonts = [];
  for (const s of segments) if (s.fontName) fonts.push(s.fontName);
  if (fonts.length === 0) fonts.push(node.fontName === figma.mixed ? { family: "Inter", style: "Regular" } : node.fontName);
  for (const f of fonts) await figma.loadFontAsync(f);

  node.characters = segments.map((s) => s.characters).join("");

  let pos = 0;
  for (const s of segments) {
    const start = pos, end = pos + s.characters.length;
    pos = end;
    if (end <= start) continue;
    if (s.fontName) node.setRangeFontName(start, end, s.fontName);
    if (typeof s.fontSize === "number") node.setRangeFontSize(start, end, s.fontSize);
    if (s.fills) node.setRangeFills(start, end, s.fills);
    if (s.lineHeight) node.setRangeLineHeight(start, end, s.lineHeight);
    if (s.letterSpacing) node.setRangeLetterSpacing(start, end, s.letterSpacing);
    if (s.textCase) node.setRangeTextCase(start, end, s.textCase);
    if (s.textDecoration) node.setRangeTextDecoration(start, end, s.textDecoration);
  }
  return { id: node.id, characters: node.characters, segments: segments.length };
}

// 섹션을 만든다. 캔버스에서 "여기부터 여기까지는 한 덩어리"를 선언하는 유일한 수단이고,
// 프레임과 달리 자식 좌표를 건드리지 않고 배경도 깔지 않아 기존 자산을 담기에 안전하다.
async function createSection(params) {
  const { name, x = 0, y = 0, width = 1000, height = 1000 } = params || {};
  const section = figma.createSection();
  section.name = name || "Section";
  section.x = x;
  section.y = y;
  section.resizeWithoutConstraints(width, height);
  figma.currentPage.appendChild(section);
  return { id: section.id, name: section.name, x: section.x, y: section.y, width, height };
}

// 노드를 COMPONENT 로 승격한다.
//
// **왜 필요한가** — "원본을 고치면 찍어낸 것들이 따라온다"는 건 Figma 에서 컴포넌트/인스턴스로만
// 성립한다. 언어별 행을 복제본으로 만들면 디자인 수정이 행 개수만큼 반복 노동이 된다.
// 인스턴스는 텍스트 오버라이드를 유지한 채 마스터 변경을 따라오므로, 번역을 다시 붓지 않아도 된다.
async function createComponentFromNode(params) {
  const { nodeId, name } = params || {};
  if (!nodeId) throw new Error("Missing nodeId parameter");

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  if (node.type === "COMPONENT") return { id: node.id, name: node.name, alreadyComponent: true };

  const component = figma.createComponentFromNode(node);
  if (name) component.name = name;
  return { id: component.id, name: component.name, width: component.width, height: component.height };
}

// 이미지 fill 을 노드에서 노드로 그대로 옮긴다 (imageHash + paint 기하 전부).
//
// **왜 export 로는 안 되나** — 마스크 노드는 단독으로 export 하면 1×1 투명이 나온다.
// 기기 목업의 화면 슬롯은 모서리가 둥근 알파를 가진 이미지가 마스크 역할을 하는데,
// 그 알파를 밖으로 꺼낼 방법이 없다. 그래서 바이트를 건드리지 않고 hash 만 옮긴다.
// 같은 파일 안에서는 imageHash 가 그대로 유효하므로 재업로드도 필요 없다.
async function copyImageFill(params) {
  const { sourceNodeId, targetNodeId, fillIndex = 0 } = params || {};
  if (!sourceNodeId || !targetNodeId) {
    throw new Error("Missing sourceNodeId or targetNodeId");
  }

  const source = await figma.getNodeByIdAsync(sourceNodeId);
  const target = await figma.getNodeByIdAsync(targetNodeId);
  if (!source) throw new Error(`Source node not found: ${sourceNodeId}`);
  if (!target) throw new Error(`Target node not found: ${targetNodeId}`);
  if (!("fills" in source)) throw new Error(`Source has no fills: ${sourceNodeId}`);
  if (!("fills" in target)) throw new Error(`Target has no fills: ${targetNodeId}`);

  const sourceFills = source.fills;
  if (sourceFills === figma.mixed) throw new Error("Source has mixed fills");
  const image = sourceFills.filter((p) => p.type === "IMAGE")[fillIndex];
  if (!image) throw new Error(`Source has no IMAGE fill at index ${fillIndex}`);

  // paint 를 통째로 복제한다 — scaleMode/imageTransform/rotation/opacity 가 여기 들어 있고,
  // 하나라도 빠뜨리면 기울기나 크롭이 조용히 어긋난다.
  target.fills = [JSON.parse(JSON.stringify(image))];

  return {
    sourceId: source.id,
    targetId: target.id,
    imageHash: image.imageHash,
    scaleMode: image.scaleMode,
  };
}

// 노드 이름 바꾸기 — 한 번에 여러 개.
// 레이어 이름은 자산을 고르는 유일한 단서다(스토어 업로드 스크립트가 `IT_03` 으로 찾는다).
// TEXT 는 내용이 바뀌면 이름이 따라오지만 FRAME/GROUP 은 안 그래서, 복제한 행의
// 프레임 이름을 고쳐 줄 수단이 필요하다.
async function setNodeNames(params) {
  const { names } = params || {};
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Missing or empty names parameter (expected [{nodeId, name}])");
  }

  const results = [];
  for (const entry of names) {
    const { nodeId, name } = entry || {};
    if (!nodeId || typeof name !== "string") {
      results.push({ nodeId, success: false, error: "each entry needs {nodeId, name}" });
      continue;
    }
    const node = await figma.getNodeByIdAsync(nodeId);
    if (!node) {
      results.push({ nodeId, success: false, error: "node not found" });
      continue;
    }
    const previousName = node.name;
    node.name = name;
    results.push({ nodeId, success: true, previousName, name: node.name });
  }

  return {
    success: results.every((r) => r.success),
    renamed: results.filter((r) => r.success).length,
    results,
  };
}

// Set focus on a specific node
async function setFocus(params) {
  if (!params || !params.nodeId) {
    throw new Error("Missing nodeId parameter");
  }

  const node = await figma.getNodeByIdAsync(params.nodeId);
  if (!node) {
    throw new Error(`Node with ID ${params.nodeId} not found`);
  }

  // Set selection to the node
  figma.currentPage.selection = [node];
  
  // Scroll and zoom to show the node in viewport
  figma.viewport.scrollAndZoomIntoView([node]);

  return {
    success: true,
    name: node.name,
    id: node.id,
    message: `Focused on node "${node.name}"`
  };
}

// Set selection to multiple nodes
async function setSelections(params) {
  if (!params || !params.nodeIds || !Array.isArray(params.nodeIds)) {
    throw new Error("Missing or invalid nodeIds parameter");
  }

  if (params.nodeIds.length === 0) {
    throw new Error("nodeIds array cannot be empty");
  }

  // Get all valid nodes
  const nodes = [];
  const notFoundIds = [];
  
  for (const nodeId of params.nodeIds) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node) {
      nodes.push(node);
    } else {
      notFoundIds.push(nodeId);
    }
  }

  if (nodes.length === 0) {
    throw new Error(`No valid nodes found for the provided IDs: ${params.nodeIds.join(', ')}`);
  }

  // Set selection to the nodes
  figma.currentPage.selection = nodes;
  
  // Scroll and zoom to show all nodes in viewport
  figma.viewport.scrollAndZoomIntoView(nodes);

  const selectedNodes = nodes.map(node => ({
    name: node.name,
    id: node.id
  }));

  return {
    success: true,
    count: nodes.length,
    selectedNodes: selectedNodes,
    notFoundIds: notFoundIds,
    message: `Selected ${nodes.length} nodes${notFoundIds.length > 0 ? ` (${notFoundIds.length} not found)` : ''}`
  };
}
