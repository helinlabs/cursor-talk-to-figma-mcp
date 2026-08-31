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

// ---------------------------------------------------------------------------
// Electron renderer accessibility.
//
// Figma is Electron, and Chromium leaves its renderer accessibility tree empty
// until an assistive client asks for it. Unasked, the Figma app element exposes
// only the native shell — the window plus a dozen AXGroups — with no tab strip
// and no web area, so projectTab() finds no tab for any project and every
// project is reported "separation_failed". Chromium resets this per process, so
// a plain Figma restart is enough to silently break an otherwise healthy
// launcher. AXManualAccessibility is Chromium's documented opt-in switch:
// setting it is idempotent and it stays on for the life of the Figma process.
// The tree then populates asynchronously, so wait for a web area before
// walking anything that depends on it.
// ---------------------------------------------------------------------------
func appAX(_ app: NSRunningApplication) -> AXUIElement {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    _ = AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return element
}

func rendererAccessibilityReady(_ appElement: AXUIElement) -> Bool {
    windows(appElement).contains { window in
        descendants(window).contains { role($0) == "AXWebArea" }
    }
}

func enableRendererAccessibility(_ appElement: AXUIElement, timeout: TimeInterval) -> Bool {
    if rendererAccessibilityReady(appElement) { return true }
    _ = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    return waitUntil(timeout: timeout) { rendererAccessibilityReady(appElement) }
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

func leftClick(_ element: AXUIElement) -> Bool {
    guard let (point, size) = pointAndSize(element) else { return false }
    let center = CGPoint(x: point.x + size.width / 2, y: point.y + size.height / 2)
    guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: center, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: center, mouseButton: .left) else { return false }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
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
    menuItem(appElement) { axText($0) == title }
}

func menuItem(_ appElement: AXUIElement, where matches: (AXUIElement) -> Bool) -> AXUIElement? {
    descendants(appElement, maxDepth: 16).first {
        role($0) == (kAXMenuItemRole as String) && matches($0)
    }
}

// Look inside ONE menu item's own submenu instead of the whole app.
//
// Menu item titles are not unique across Figma's menu tree, so an app-wide
// lookup silently resolves to the wrong item. "New Window" is the case that
// bites: the tab context menu's "Move to Another Window >" submenu has one,
// and so does the menu bar's File menu. The app-wide search finds the File
// one first — it exists whether or not any menu is open — so the launcher
// pressed File > New Window, which opens an empty window and leaves the tab
// exactly where it was. That reads downstream as "separation_failed" and
// litters a stray "Recents" window on every attempt.
func submenuItem(_ parent: AXUIElement, named title: String) -> AXUIElement? {
    axChildren(parent)
        .filter { role($0) == (kAXMenuRole as String) }
        .flatMap { axChildren($0) }
        .first { role($0) == (kAXMenuItemRole as String) && axText($0) == title }
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
        guard press(direct) else { dismissOpenMenus(); return false }
    } else if let submenu = menuItem(appElement, named: "Move to Another Window") {
        guard press(submenu),
              waitUntil(timeout: 2, { submenuItem(submenu, named: "New Window") != nil }),
              let newWindow = submenuItem(submenu, named: "New Window"),
              press(newWindow) else { dismissOpenMenus(); return false }
    } else {
        dismissOpenMenus()
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

// ---------------------------------------------------------------------------
// The announced document name goes stale, so ask the plugin where it is now.
//
// The relay records the document a plugin announced when it connected, and
// never revisits it. That is fine while one window holds one file, but when two
// configured files share a window the tab switch swaps the document under a
// running plugin without a fresh announce. The relay then reports a channel as
// "GW_Product" while the plugin answering on it is in GW_Apple Watch, and the
// launcher reports the project connected. Measured 2026-08-31: the channel the
// relay labelled GW_Product answered `figma.root.name` as GW_Apple Watch.
//
// Reporting that as connected is worse than reporting nothing. Callers write to
// whatever answers, so a wrong document is a wrong-file write waiting to
// happen. One round trip through the relay's own script endpoint settles it.
func liveDocumentName(baseURL: String, project: Project, timeout: TimeInterval = 8) -> String? {
    var components = URLComponents(string: baseURL.hasSuffix("/") ? baseURL + "script/run" : baseURL + "/script/run")
    components?.queryItems = [URLQueryItem(name: "project", value: project.displayTitle)]
    guard let url = components?.url else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": "return figma.root.name"])
    var payload: Data?
    let semaphore = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { data, _, _ in
        payload = data
        semaphore.signal()
    }.resume()
    guard semaphore.wait(timeout: .now() + timeout + 1) == .success,
          let data = payload,
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          root["ok"] as? Bool == true,
          // `result` is the script's return value re-encoded as JSON, so a
          // string arrives quoted.
          let encoded = root["result"] as? String,
          let name = try? JSONSerialization.jsonObject(
              with: Data(encoded.utf8), options: [.fragmentsAllowed]
          ) as? String
    else { return nil }
    return name
}

// A relay that cannot answer is not evidence of a wrong document: an
// unreachable relay, a busy plugin, or a timeout all return nil, and treating
// those as failures would make the launcher flap. Only a name that came back
// and disagrees counts.
func documentMismatch(baseURL: String, project: Project) -> String? {
    guard let live = liveDocumentName(baseURL: baseURL, project: project) else { return nil }
    if live == project.displayTitle { return nil }
    if live.localizedCaseInsensitiveContains(project.title) { return nil }
    return live
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

// Make a design window key. The success test is "Figma's menu bar now has a
// Plugins menu", not "AXFocusedWindow points at the window": measured on
// macmini-1, AXRaise plus setting AXMain/AXFocusedWindow makes AX report the
// design window as focused while Figma keeps its file-browser (Recents) window
// key and keeps publishing the browser menu bar (Apple/Figma/File/Edit/View/
// Window/Help — no Plugins). Only Figma's own activation paths move it, so
// escalate through them until the menu proves it worked.
func pluginsMenuIsUp(_ appElement: AXUIElement) -> Bool {
    menuBarItem(appElement, named: "Plugins") != nil
}

// A Figma window whose renderer has crashed keeps its title, its position and
// its shell web area, so every check the launcher makes looks reasonable right
// up to the plugin handshake — which then times out. That is exactly how two
// projects sat offline for hours today: `connect_timeout` was reported and the
// run stopped, because re-running the plugin cannot help a window that has no
// document to run it in. What is actually on screen is Figma's "Something went
// wrong" page with a Reload button, and pressing it brings the document back.
func rendererIsUp(_ window: AXUIElement) -> Bool {
    descendants(window).contains { element in
        role(element) == "AXWebArea" && axText(element).localizedCaseInsensitiveContains("\u{2013} Figma")
    }
}

func reloadCrashedRenderer(
    _ app: NSRunningApplication,
    appElement: AXUIElement,
    window: AXUIElement,
    timeout: TimeInterval
) -> Bool {
    if rendererIsUp(window) { return true }
    guard let reload = descendants(window).first(where: {
        role($0) == "AXButton" && axText($0).localizedCaseInsensitiveContains("reload")
    }) else { return false }
    // Raise only this window. The other projects hold live plugin channels and
    // a repair of one of them must not disturb the rest.
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
    app.activate(options: [.activateAllWindows])
    _ = waitUntil(timeout: 2) { (axValue(window, kAXMainAttribute as CFString) as? Bool) ?? false }
    if !press(reload), !leftClick(reload) { return false }
    return waitUntil(timeout: timeout) { rendererIsUp(window) }
}

func focusWindow(_ app: NSRunningApplication, appElement: AXUIElement, project: Project, window: AXUIElement, timeout: TimeInterval) -> Bool {
    // 1. The cheap way: ask AX and the workspace.
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, window)
    app.activate(options: [.activateAllWindows])
    if waitUntil(timeout: 3, { pluginsMenuIsUp(appElement) }) { return true }

    // 2. Figma's own Window menu: picking the document there is the activation
    //    path Figma implements itself, so its menu bar follows.
    if let windowMenu = menuBarItem(appElement, named: "Window"), press(windowMenu) {
        if waitUntil(timeout: 2, { menuItem(appElement, where: { projectMatch($0, project: project) }) != nil }),
           let entry = menuItem(appElement, where: { projectMatch($0, project: project) }), press(entry) {
            if waitUntil(timeout: min(timeout, 6), { pluginsMenuIsUp(appElement) }) { return true }
        } else {
            dismissOpenMenus()
        }
    }

    // 3. Click the project's own tab inside that window — a real mouse event,
    //    which Figma cannot ignore. Selecting a tab it already shows is a no-op
    //    for the document.
    if let (tabWindow, tab) = projectTab(appElement, project: project), CFHash(tabWindow) == CFHash(window), leftClick(tab) {
        if waitUntil(timeout: min(timeout, 6), { pluginsMenuIsUp(appElement) }) { return true }
    }
    return false
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
    // Figma publishes a different menu bar per key window and the file-browser
    // one has no Plugins menu at all, so getting the design window key IS the
    // precondition; focusWindow escalates until the Plugins menu proves it.
    guard focusWindow(app, appElement: appElement, project: project, window: window, timeout: timeout) else {
        let titles = menuBarTitles(appElement)
        return .failed(
            step: "plugins_menu_missing",
            detail: "Could not make this design window key — Figma's menu bar still has no Plugins menu (\(titles.joined(separator: ", ")))",
            menuBar: titles
        )
    }
    guard let plugins = menuBarItem(appElement, named: "Plugins"), press(plugins) else {
        return .failed(step: "plugins_menu_press", detail: "Could not open Figma's Plugins menu", menuBar: menuBarTitles(appElement))
    }
    // A file the launcher just opened has not finished registering its
    // development plugins yet, and 3s was not enough for one: `--project
    // f-product` failed with this step, yet a dump showed the item present and
    // an immediate retry against the now-warm document connected. Nothing on
    // the healthy path waits longer — the item is already there — so this only
    // stops a cold open from being called a missing plugin.
    let menuItemWait = max(3, min(timeout, 12))
    guard waitUntil(timeout: menuItemWait, { menuItem(appElement, named: pluginTitle) != nil }),
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
                results[index].pluginVersion = version
                results[index].channel = channelName
                if let live = documentMismatch(baseURL: options.relayURL, project: project) {
                    results[index].detail = "channel answers from \(live) — not this file"
                    results[index].step = "wrong_document"
                } else {
                    results[index].detail = "connected"
                }
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
    // Tabs live in the renderer tree, so it must be up before separation is
    // attempted; otherwise every project fails as "separation_failed" for a
    // reason that has nothing to do with the tab or the window.
    let accessibilityReady = enableRendererAccessibility(root, timeout: options.timeout)
    for (index, project) in config.projects.enumerated() where results[index].status == "opened" {
        if !accessibilityReady {
            results[index].status = "separation_failed"
            results[index].step = "renderer_accessibility"
            results[index].detail = "Figma's renderer accessibility tree never populated, so no tab is visible to the launcher"
            continue
        }
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
            // Put a crashed renderer back before judging anything else, or the
            // run reports a plugin timeout for a window that never had a
            // document to begin with.
            if !rendererIsUp(window) {
                if reloadCrashedRenderer(app, appElement: root, window: window, timeout: options.timeout) {
                    // The reload replaces the renderer, so any channel this
                    // project held is gone — re-read before deciding.
                    snapshot = fetchRelaySnapshot(baseURL: options.relayURL) ?? snapshot
                } else {
                    results[index].status = "plugin_failed"
                    results[index].step = "renderer_crashed"
                    results[index].detail = "Window's renderer had crashed and Reload did not bring the document back"
                    continue
                }
            }
            // Already connected AND running the relay's own version: leave it
            // alone (re-running would drop a healthy channel). A stale plugin is
            // re-run without asking — that is the whole point of a deploy.
            // Leaving a healthy channel alone is only right when the channel is
            // in THIS file. A stale announce points at another document, and
            // skipping the re-run there would preserve exactly the wrong state.
            if case .current(let version, let channelName) = pluginState(snapshot, project: project, window: window),
               !options.forceReconnect,
               documentMismatch(baseURL: options.relayURL, project: project) == nil {
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
                results[index].pluginVersion = version
                results[index].channel = channelName ?? channel(in: window)
                // The panel says connected and the relay agrees, but both are
                // reading an announce. Ask the plugin itself before calling it
                // a success — a run that ends "connected" on the wrong file is
                // the one failure nobody notices until data lands in it.
                if let live = documentMismatch(baseURL: options.relayURL, project: project) {
                    results[index].status = "plugin_failed"
                    results[index].step = "wrong_document"
                    results[index].detail = "Plugin connected but answers from \(live) — this file shares a window with it"
                } else {
                    results[index].status = "connected"
                    results[index].detail = "Talk To Figma MCP is connected"
                }
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
