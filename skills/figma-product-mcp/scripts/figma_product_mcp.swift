import AppKit
import ApplicationServices
import Foundation

struct Project: Codable {
    let id: String
    let title: String
    let displayTitle: String
    let url: String
}

struct Config: Codable {
    let pluginMenuTitle: String
    let defaultProjectIDs: [String]
    let projects: [Project]
}

struct ProjectResult: Codable {
    let id: String
    let title: String
    let url: String
    var status: String
    var detail: String
    var channel: String?
    // Which step of the plugin handshake gave up. "did not reach connected
    // state" alone is unactionable — the step name is what makes a failed run
    // diagnosable without re-running it by hand.
    var step: String?
    // Protocol version the relay sees this window's plugin speaking. Differing
    // from relayProtocolVersion means Figma is still running stale plugin code.
    var pluginVersion: String?
}

struct Report: Codable {
    let ok: Bool
    let dryRun: Bool
    let timestamp: String
    let results: [ProjectResult]
    // Relay ground truth: which plugins are actually connected, and at what
    // version. Absent when the relay could not be reached (then the launcher
    // falls back to reading the plugin panel's banner text).
    var relayReachable: Bool?
    var relayProtocolVersion: String?
    // Figma's menu bar titles at the moment a Plugins-menu lookup failed.
    var menuBar: [String]?
}

enum LauncherError: Error, CustomStringConvertible {
    case usage(String)
    case config(String)
    case accessibility
    case figma(String)

    var description: String {
        switch self {
        case .usage(let text), .config(let text), .figma(let text): return text
        case .accessibility: return "macOS Accessibility access is required"
        }
    }
}

struct Options {
    var configPath = ""
    var dryRun = false
    var openOnly = false
    var promptAccessibility = false
    var allProjects = false
    var forceReconnect = false
    var timeout: TimeInterval = 25
    var relayURL = ProcessInfo.processInfo.environment["TALK_TO_FIGMA_RELAY_URL"] ?? "http://127.0.0.1:3055"
    var selectedIDs = Set<String>()
}

func parseOptions() throws -> Options {
    var options = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--config":
            guard !args.isEmpty else { throw LauncherError.usage("--config requires a path") }
            options.configPath = args.removeFirst()
        case "--project":
            guard !args.isEmpty else { throw LauncherError.usage("--project requires an id") }
            options.selectedIDs.insert(args.removeFirst())
        case "--timeout":
            guard !args.isEmpty, let value = Double(args.removeFirst()), value > 0 else {
                throw LauncherError.usage("--timeout requires a positive number")
            }
            options.timeout = value
        case "--relay-url":
            guard !args.isEmpty else { throw LauncherError.usage("--relay-url requires a URL") }
            options.relayURL = args.removeFirst()
        case "--dry-run": options.dryRun = true
        case "--open-only": options.openOnly = true
        case "--all": options.allProjects = true
        case "--force-reconnect": options.forceReconnect = true
        case "--prompt-accessibility": options.promptAccessibility = true
        case "--help", "-h":
            print("""
            Usage: run.sh [--dry-run] [--open-only] [--all | --project ID]
                          [--force-reconnect] [--timeout SECONDS] [--relay-url URL]
                          [--prompt-accessibility]

            --force-reconnect  Re-run the plugin even in windows that are already
                               connected. Needed after a plugin code deploy: Figma
                               only re-reads code.js when the plugin is run again.
                               (A plugin whose version differs from the relay's is
                               re-run anyway, without this flag.)

            Exit codes: 0 all target projects connected · 1 one or more projects
            failed (see each result's status/step) · 2 usage/config/accessibility
            problem · 70 unexpected error.
            """)
            exit(0)
        default: throw LauncherError.usage("Unknown argument: \(arg)")
        }
    }
    guard !options.configPath.isEmpty else { throw LauncherError.usage("--config is required") }
    return options
}

func loadConfig(path: String, selectedIDs: Set<String>, allProjects: Bool) throws -> Config {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let decoded = try JSONDecoder().decode(Config.self, from: data)
    let targetIDs = !selectedIDs.isEmpty
        ? selectedIDs
        : (allProjects ? Set(decoded.projects.map(\.id)) : Set(decoded.defaultProjectIDs))
    let projects = decoded.projects.filter { targetIDs.contains($0.id) }
    guard !projects.isEmpty else { throw LauncherError.config("No configured projects matched the request") }
    guard Dictionary(grouping: projects, by: \.id).allSatisfy({ $0.value.count == 1 }) else {
        throw LauncherError.config("Duplicate project ids in config")
    }
    for project in projects {
        guard let url = URL(string: project.url), url.scheme == "https", url.host?.contains("figma.com") == true else {
            throw LauncherError.config("Invalid Figma URL for \(project.id)")
        }
    }
    guard Set(projects.map(\.id)) == targetIDs else {
        throw LauncherError.config("One or more requested project ids are missing from config")
    }
    return Config(pluginMenuTitle: decoded.pluginMenuTitle, defaultProjectIDs: decoded.defaultProjectIDs, projects: projects)
}

func axValue(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axValue(element, attribute) as? String
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axValue(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

func axText(_ element: AXUIElement) -> String {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
        .compactMap { axString(element, $0 as CFString) }
        .joined(separator: " ")
}

func descendants(_ root: AXUIElement, maxDepth: Int = 22) -> [AXUIElement] {
    var output: [AXUIElement] = []
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var seen = Set<CFHashCode>()
    while !queue.isEmpty {
        let (element, depth) = queue.removeFirst()
        let key = CFHash(element)
        if seen.contains(key) { continue }
        seen.insert(key)
        output.append(element)
        if depth < maxDepth {
            queue.append(contentsOf: axChildren(element).map { ($0, depth + 1) })
        }
    }
    return output
}

func role(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as CFString) ?? ""
}

func press(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func waitUntil(timeout: TimeInterval, interval: TimeInterval = 0.25, _ test: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    repeat {
        if test() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(interval))
    } while Date() < end
    return false
}

func runningFigma() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == "com.figma.Desktop" || $0.localizedName == "Figma"
    }
}

func launchFigmaIfNeeded(timeout: TimeInterval) throws -> NSRunningApplication {
    if let app = runningFigma() { return app }
    guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.figma.Desktop") else {
        throw LauncherError.figma("Figma.app was not found")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
    guard waitUntil(timeout: timeout, { runningFigma() != nil }), let app = runningFigma() else {
        throw LauncherError.figma("Figma did not launch before timeout")
    }
    return app
}

func appAX(_ app: NSRunningApplication) -> AXUIElement {
    AXUIElementCreateApplication(app.processIdentifier)
}

func windows(_ appElement: AXUIElement) -> [AXUIElement] {
    axValue(appElement, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
}

func projectKey(_ project: Project) -> String {
    URL(string: project.url)?.pathComponents.dropFirst(2).first ?? ""
}

func projectMatch(_ element: AXUIElement, project: Project) -> Bool {
    let text = axText(element)
    return text.localizedCaseInsensitiveContains(project.title)
        || text.localizedCaseInsensitiveContains(project.displayTitle)
        || (!projectKey(project).isEmpty && text.contains(projectKey(project)))
}

func projectWindow(_ appElement: AXUIElement, project: Project) -> AXUIElement? {
    windows(appElement).first { window in
        projectMatch(window, project: project)
            || descendants(window).contains { projectMatch($0, project: project) }
    }
}

func isTab(_ element: AXUIElement) -> Bool {
    role(element) == "AXTab" || role(element) == (kAXRadioButtonRole as String)
}

func projectTab(_ appElement: AXUIElement, project: Project) -> (AXUIElement, AXUIElement)? {
    for window in windows(appElement) {
        if let tab = descendants(window).first(where: { isTab($0) && projectMatch($0, project: project) }) {
            return (window, tab)
        }
    }
    return nil
}

func openProject(_ project: Project, app: NSRunningApplication, appElement: AXUIElement, timeout: TimeInterval) -> Bool {
    if projectWindow(appElement, project: project) != nil { return true }
    guard let url = URL(string: project.url),
          let appURL = app.bundleURL ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.figma.Desktop") else { return false }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.addsToRecentItems = false
    NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: configuration)
    return waitUntil(timeout: timeout) { projectWindow(appElement, project: project) != nil }
}

func pointAndSize(_ element: AXUIElement) -> (CGPoint, CGSize)? {
    guard let positionValue = axValue(element, kAXPositionAttribute as CFString),
          let sizeValue = axValue(element, kAXSizeAttribute as CFString),
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return (point, size)
}

func rightClick(_ element: AXUIElement) -> Bool {
    guard let (point, size) = pointAndSize(element) else { return false }
    let center = CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: center, mouseButton: .right),
          let up = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: center, mouseButton: .right) else { return false }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
}

func menuItem(_ appElement: AXUIElement, named title: String) -> AXUIElement? {
    descendants(appElement, maxDepth: 16).first {
        role($0) == (kAXMenuItemRole as String) && axText($0) == title
    }
}

func splitIntoNewWindow(_ appElement: AXUIElement, project: Project, configuredProjects: [Project], timeout: TimeInterval) -> Bool {
    guard let (originalWindow, tab) = projectTab(appElement, project: project) else { return false }
    let productTabs = descendants(originalWindow).filter { tabElement in
        isTab(tabElement) && configuredProjects.contains { projectMatch(tabElement, project: $0) }
    }
    if productTabs.count <= 1 { return true }
    _ = AXUIElementPerformAction(originalWindow, kAXRaiseAction as CFString)
    guard rightClick(tab) else { return false }
    _ = waitUntil(timeout: 2) {
        menuItem(appElement, named: "Move to New Window") != nil || menuItem(appElement, named: "Move to Another Window") != nil
    }
    if let direct = menuItem(appElement, named: "Move to New Window") {
        guard press(direct) else { return false }
    } else if let submenu = menuItem(appElement, named: "Move to Another Window") {
        guard press(submenu), waitUntil(timeout: 2, { menuItem(appElement, named: "New Window") != nil }),
              let newWindow = menuItem(appElement, named: "New Window"), press(newWindow) else { return false }
    } else {
        return false
    }
    return waitUntil(timeout: timeout) {
        guard let newProjectWindow = projectWindow(appElement, project: project) else { return false }
        return CFHash(newProjectWindow) != CFHash(originalWindow)
    }
}

// ---------------------------------------------------------------------------
// Relay ground truth.
//
// The plugin panel's "Connected to server in channel" banner is a label, not a
// fact: it survives a relay restart that already dropped the socket, it says
// nothing about WHICH code.js Figma loaded, and since the compact plugin UI it
// may not even live inside the project window's accessibility tree. The relay
// knows all three, so ask it: GET /channels lists every live plugin with the
// document it announced and the protocol version it speaks.
// ---------------------------------------------------------------------------
struct RelayConnection {
    let channel: String
    let pluginVersion: String?
}

struct RelaySnapshot {
    let protocolVersion: String?
    let connectionsByDocument: [String: [RelayConnection]]
}

func fetchRelaySnapshot(baseURL: String, timeout: TimeInterval = 3) -> RelaySnapshot? {
    guard let url = URL(string: baseURL.hasSuffix("/") ? baseURL + "channels" : baseURL + "/channels") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = timeout
    var payload: Data?
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        payload = data
        semaphore.signal()
    }.resume()
    guard semaphore.wait(timeout: .now() + timeout + 1) == .success,
          let data = payload,
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }

    var byDocument: [String: [RelayConnection]] = [:]
    for project in root["projects"] as? [[String: Any]] ?? [] {
        guard let name = project["name"] as? String else { continue }
        var live: [RelayConnection] = []
        for connection in project["connections"] as? [[String: Any]] ?? [] {
            let channel = connection["channel"] as? String ?? ""
            for client in connection["clients"] as? [[String: Any]] ?? [] {
                guard (client["role"] as? String) == "figma" else { continue }
                live.append(RelayConnection(channel: channel, pluginVersion: client["protocolVersion"] as? String))
            }
        }
        if !live.isEmpty { byDocument[name] = live }
    }
    return RelaySnapshot(protocolVersion: root["protocolVersion"] as? String, connectionsByDocument: byDocument)
}

// The plugin announces the Figma document name, which is the config's
// displayTitle (emoji included). Exact match first so near-identical titles
// (CO_Product / C_Product) cannot swap places.
func relayConnection(_ snapshot: RelaySnapshot, for project: Project) -> RelayConnection? {
    if let exact = snapshot.connectionsByDocument[project.displayTitle] { return exact.first }
    for (name, connections) in snapshot.connectionsByDocument
    where name == project.title || name.localizedCaseInsensitiveContains(project.title) {
        return connections.first
    }
    return nil
}

enum PluginState {
    case missing
    case stale(String?)              // connected, but running other code than the relay
    case current(String?, String?)   // version, channel
}

func pluginState(_ snapshot: RelaySnapshot?, project: Project, window: AXUIElement?) -> PluginState {
    guard let snapshot else {
        // No relay: the banner text is all we have. It cannot distinguish a
        // stale plugin from a current one, so never report "stale" from here.
        guard let window, windowContains(window, text: "Connected to server in channel") else { return .missing }
        return .current(nil, nil)
    }
    guard let connection = relayConnection(snapshot, for: project) else { return .missing }
    guard let expected = snapshot.protocolVersion, connection.pluginVersion != expected else {
        return .current(connection.pluginVersion, connection.channel)
    }
    return .stale(connection.pluginVersion)
}

// ---------------------------------------------------------------------------
// Menu bar access.
//
// The menu bar hangs off the application element's AXMenuBar attribute, not its
// children, and Figma rewrites it per key window: with a file-browser (Recents)
// window key the bar is Figma/File/Edit/View/Window/Help — no Plugins menu at
// all. Reading AXMenuBar directly is both correct and cheap; the old walk
// searched every open document window to depth 8 to find the same item.
// ---------------------------------------------------------------------------
func menuBar(_ appElement: AXUIElement) -> AXUIElement? {
    guard let value = axValue(appElement, kAXMenuBarAttribute as CFString), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func menuBarTitles(_ appElement: AXUIElement) -> [String] {
    guard let bar = menuBar(appElement) else { return [] }
    return axChildren(bar).map(axText).filter { !$0.isEmpty }
}

func menuBarItem(_ appElement: AXUIElement, named title: String) -> AXUIElement? {
    guard let bar = menuBar(appElement) else { return nil }
    return axChildren(bar).first { axText($0) == title }
}

// A menu left open by a failed step swallows every later click, so each failure
// path closes it before returning.
func dismissOpenMenus() {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: false) else { return }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

// Raising a window is not the same as making it key, and Figma's menu bar
// follows the KEY window. Set it explicitly, then wait for Figma to agree.
func focusWindow(_ app: NSRunningApplication, appElement: AXUIElement, window: AXUIElement, timeout: TimeInterval) -> Bool {
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
    app.activate(options: [.activateAllWindows])
    return waitUntil(timeout: min(timeout, 8)) {
        guard let focused = axValue(appElement, kAXFocusedWindowAttribute as CFString),
              CFGetTypeID(focused) == AXUIElementGetTypeID() else { return false }
        return CFHash(focused as! AXUIElement) == CFHash(window)
    }
}

func windowContains(_ window: AXUIElement, text: String) -> Bool {
    descendants(window).contains { axText($0).localizedCaseInsensitiveContains(text) }
}

func channel(in window: AXUIElement) -> String? {
    let texts = descendants(window).map(axText)
    if let index = texts.firstIndex(where: { $0.localizedCaseInsensitiveContains("Connected to server in channel") }) {
        let suffix = texts[index].split(separator: ":").last.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let suffix, !suffix.isEmpty { return suffix }
        if index + 1 < texts.count {
            let next = texts[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
            if !next.isEmpty { return next }
        }
    }
    return nil
}

enum ActivationOutcome {
    case connected(version: String?, channel: String?)
    case failed(step: String, detail: String, menuBar: [String]?)
}

// Run `Plugins > Development > <plugin>` in this window and wait for the RELAY
// to report the window's plugin connected at the relay's own protocol version.
// Waiting on the relay rather than on the panel's banner text is what makes a
// plugin-code deploy verifiable: re-running stale code would still print the
// banner, but it would keep reporting the old version.
func activatePlugin(
    _ app: NSRunningApplication,
    appElement: AXUIElement,
    window: AXUIElement,
    project: Project,
    pluginTitle: String,
    relayURL: String,
    relayReachable: Bool,
    timeout: TimeInterval
) -> ActivationOutcome {
    guard focusWindow(app, appElement: appElement, window: window, timeout: timeout) else {
        return .failed(step: "focus_window", detail: "The project window never became Figma's key window", menuBar: menuBarTitles(appElement))
    }
    // Figma drops the Plugins menu entirely when a file-browser (Recents)
    // window is key, so say that out loud instead of "did not reach connected".
    guard waitUntil(timeout: 5, { menuBarItem(appElement, named: "Plugins") != nil }) else {
        let titles = menuBarTitles(appElement)
        return .failed(
            step: "plugins_menu_missing",
            detail: "Figma's menu bar has no Plugins menu (\(titles.joined(separator: ", "))) — a Figma file-browser window is key instead of this design window",
            menuBar: titles
        )
    }
    guard let plugins = menuBarItem(appElement, named: "Plugins"), press(plugins) else {
        return .failed(step: "plugins_menu_press", detail: "Could not open Figma's Plugins menu", menuBar: menuBarTitles(appElement))
    }
    guard waitUntil(timeout: 3, { menuItem(appElement, named: pluginTitle) != nil }),
          let plugin = menuItem(appElement, named: pluginTitle) else {
        dismissOpenMenus()
        return .failed(step: "plugin_menu_item_missing", detail: "\(pluginTitle) is not under Plugins > Development in this window", menuBar: nil)
    }
    guard press(plugin) else {
        dismissOpenMenus()
        return .failed(step: "plugin_menu_item_press", detail: "Could not run \(pluginTitle)", menuBar: nil)
    }
    guard relayReachable else {
        // No relay to ask — fall back to the banner, which at least proves the
        // plugin started, and let the report say the version is unverified.
        if waitUntil(timeout: timeout, { windowContains(window, text: "Connected to server in channel") }) {
            return .connected(version: nil, channel: channel(in: window))
        }
        return .failed(step: "connect_timeout", detail: "Plugin ran but the panel never showed a connected banner", menuBar: nil)
    }
    var lastSeen: String?
    let settled = waitUntil(timeout: timeout, interval: 0.5) {
        guard let snapshot = fetchRelaySnapshot(baseURL: relayURL) else { return false }
        if case .current = pluginState(snapshot, project: project, window: window) { return true }
        if case .stale(let version) = pluginState(snapshot, project: project, window: window) { lastSeen = version }
        return false
    }
    guard settled, let snapshot = fetchRelaySnapshot(baseURL: relayURL),
          case .current(let version, let channelName) = pluginState(snapshot, project: project, window: window) else {
        let expected = fetchRelaySnapshot(baseURL: relayURL)?.protocolVersion ?? "?"
        return .failed(
            step: "connect_timeout",
            detail: lastSeen == nil
                ? "Plugin ran but the relay never saw \(project.displayTitle) connect"
                : "Plugin reconnected still speaking v\(lastSeen!) (relay v\(expected)) — Figma reloaded the old code.js",
            menuBar: nil
        )
    }
    return .connected(version: version, channel: channelName)
}

// stdout for the caller, stderr so a nonzero exit still carries the reason
// (job runners keep the error text but often replace a failed step's output),
// and a file so a follow-up session can read what happened without re-running.
let reportPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".talk-to-figma")
    .appendingPathComponent("launcher-report.json")

func emitReport(_ report: Report) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(report), let text = String(data: data, encoding: .utf8) else { return }
    print(text)
    if !report.ok {
        FileHandle.standardError.write(Data(text.utf8))
    }
    try? FileManager.default.createDirectory(at: reportPath.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: reportPath)
}

do {
    let options = try parseOptions()
    let config = try loadConfig(path: options.configPath, selectedIDs: options.selectedIDs, allProjects: options.allProjects)
    var results = config.projects.map {
        ProjectResult(
            id: $0.id, title: $0.title, url: $0.url,
            status: options.dryRun ? "configured" : "pending", detail: "",
            channel: nil, step: nil, pluginVersion: nil
        )
    }
    if options.dryRun {
        // A dry run is also the status report: no UI is touched, but the relay
        // is asked what is connected and whether it is running current code.
        let probe = fetchRelaySnapshot(baseURL: options.relayURL)
        for (index, project) in config.projects.enumerated() {
            switch pluginState(probe, project: project, window: nil) {
            case .missing:
                results[index].detail = probe == nil ? "relay unreachable — connection state unknown" : "no live plugin"
            case .stale(let version):
                results[index].detail = "stale plugin (v\(version ?? "?") vs relay v\(probe?.protocolVersion ?? "?")) — needs a re-run"
                results[index].pluginVersion = version
            case .current(let version, let channelName):
                results[index].detail = "connected"
                results[index].pluginVersion = version
                results[index].channel = channelName
            }
        }
        emitReport(Report(
            ok: true, dryRun: true,
            timestamp: ISO8601DateFormatter().string(from: Date()),
            results: results,
            relayReachable: probe != nil, relayProtocolVersion: probe?.protocolVersion, menuBar: nil
        ))
        exit(0)
    }

    let promptKey = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    guard AXIsProcessTrustedWithOptions([promptKey: options.promptAccessibility] as CFDictionary) else {
        throw LauncherError.accessibility
    }
    let app = try launchFigmaIfNeeded(timeout: options.timeout)
    let root = appAX(app)

    for (index, project) in config.projects.enumerated() {
        if openProject(project, app: app, appElement: root, timeout: options.timeout) {
            results[index].status = "opened"
            results[index].detail = "Figma file is open"
        } else {
            results[index].status = "open_failed"
            results[index].detail = "Figma file did not appear before timeout"
        }
    }
    for (index, project) in config.projects.enumerated() where results[index].status == "opened" {
        if splitIntoNewWindow(root, project: project, configuredProjects: config.projects, timeout: options.timeout) {
            results[index].status = options.openOnly ? "opened" : "separated"
            results[index].detail = "Project is in a distinct Figma window"
        } else {
            results[index].status = "separation_failed"
            results[index].detail = "Could not move the design tab to a distinct window"
        }
    }
    var snapshot = fetchRelaySnapshot(baseURL: options.relayURL)
    var menuBarSeen: [String]?
    if !options.openOnly {
        for (index, project) in config.projects.enumerated() where results[index].status == "separated" {
            guard let window = projectWindow(root, project: project) else {
                results[index].status = "window_missing"
                results[index].detail = "Project window disappeared before plugin launch"
                continue
            }
            // Already connected AND running the relay's own version: leave it
            // alone (re-running would drop a healthy channel). A stale plugin is
            // re-run without asking — that is the whole point of a deploy.
            if case .current(let version, let channelName) = pluginState(snapshot, project: project, window: window), !options.forceReconnect {
                results[index].status = "connected"
                results[index].detail = "Talk To Figma MCP is connected"
                results[index].pluginVersion = version
                results[index].channel = channelName ?? channel(in: window)
                continue
            }
            let outcome = activatePlugin(
                app,
                appElement: root,
                window: window,
                project: project,
                pluginTitle: config.pluginMenuTitle,
                relayURL: options.relayURL,
                relayReachable: snapshot != nil,
                timeout: options.timeout
            )
            switch outcome {
            case .connected(let version, let channelName):
                results[index].status = "connected"
                results[index].detail = "Talk To Figma MCP is connected"
                results[index].pluginVersion = version
                results[index].channel = channelName ?? channel(in: window)
            case .failed(let step, let detail, let menuBar):
                results[index].status = "plugin_failed"
                results[index].detail = detail
                results[index].step = step
                if let menuBar, menuBarSeen == nil { menuBarSeen = menuBar }
            }
            // Channels change on every plugin re-run, so re-read ground truth.
            snapshot = fetchRelaySnapshot(baseURL: options.relayURL) ?? snapshot
        }
    }
    let expected = options.openOnly ? "opened" : "connected"
    let ok = results.allSatisfy { $0.status == expected }
    emitReport(Report(
        ok: ok,
        dryRun: false,
        timestamp: ISO8601DateFormatter().string(from: Date()),
        results: results,
        relayReachable: snapshot != nil,
        relayProtocolVersion: snapshot?.protocolVersion,
        menuBar: menuBarSeen
    ))
    exit(ok ? 0 : 1)
} catch {
    let result = ProjectResult(
        id: "launcher", title: "launcher", url: "",
        status: "launcher_failed", detail: String(describing: error),
        channel: nil, step: nil, pluginVersion: nil
    )
    emitReport(Report(
        ok: false, dryRun: false,
        timestamp: ISO8601DateFormatter().string(from: Date()),
        results: [result],
        relayReachable: nil, relayProtocolVersion: nil, menuBar: nil
    ))
    exit(error is LauncherError ? 2 : 70)
}
