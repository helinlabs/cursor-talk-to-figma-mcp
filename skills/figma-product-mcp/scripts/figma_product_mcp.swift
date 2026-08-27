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
}

struct Report: Codable {
    let ok: Bool
    let dryRun: Bool
    let timestamp: String
    let results: [ProjectResult]
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
    var timeout: TimeInterval = 25
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
        case "--dry-run": options.dryRun = true
        case "--open-only": options.openOnly = true
        case "--all": options.allProjects = true
        case "--prompt-accessibility": options.promptAccessibility = true
        case "--help", "-h":
            print("Usage: run.sh [--dry-run] [--open-only] [--all | --project ID] [--timeout SECONDS] [--prompt-accessibility]")
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

func activatePlugin(_ app: NSRunningApplication, appElement: AXUIElement, window: AXUIElement, pluginTitle: String, timeout: TimeInterval) -> Bool {
    if windowContains(window, text: "Disconnect") && windowContains(window, text: "Connected to server in channel") { return true }
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    app.activate(options: [.activateAllWindows])
    RunLoop.current.run(until: Date().addingTimeInterval(0.35))
    guard let plugins = descendants(appElement, maxDepth: 8).first(where: {
        role($0) == (kAXMenuBarItemRole as String) && axText($0) == "Plugins"
    }), press(plugins) else { return false }
    guard waitUntil(timeout: 3, { menuItem(appElement, named: pluginTitle) != nil }),
          let plugin = menuItem(appElement, named: pluginTitle), press(plugin) else { return false }
    return waitUntil(timeout: timeout) {
        windowContains(window, text: "Disconnect") && windowContains(window, text: "Connected to server in channel")
    }
}

func emitReport(_ report: Report) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(report), let text = String(data: data, encoding: .utf8) { print(text) }
}

do {
    let options = try parseOptions()
    let config = try loadConfig(path: options.configPath, selectedIDs: options.selectedIDs, allProjects: options.allProjects)
    var results = config.projects.map {
        ProjectResult(id: $0.id, title: $0.title, url: $0.url, status: options.dryRun ? "configured" : "pending", detail: "", channel: nil)
    }
    if options.dryRun {
        emitReport(Report(ok: true, dryRun: true, timestamp: ISO8601DateFormatter().string(from: Date()), results: results))
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
    if !options.openOnly {
        for (index, project) in config.projects.enumerated() where results[index].status == "separated" {
            guard let window = projectWindow(root, project: project) else {
                results[index].status = "window_missing"
                results[index].detail = "Project window disappeared before plugin launch"
                continue
            }
            if activatePlugin(app, appElement: root, window: window, pluginTitle: config.pluginMenuTitle, timeout: options.timeout) {
                results[index].status = "connected"
                results[index].detail = "Talk To Figma MCP is connected"
                results[index].channel = channel(in: window)
            } else {
                results[index].status = "plugin_failed"
                results[index].detail = "Cursor MCP Plugin did not reach connected state"
            }
        }
    }
    let expected = options.openOnly ? "opened" : "connected"
    let ok = results.allSatisfy { $0.status == expected }
    emitReport(Report(ok: ok, dryRun: false, timestamp: ISO8601DateFormatter().string(from: Date()), results: results))
    exit(ok ? 0 : 1)
} catch {
    let result = ProjectResult(id: "launcher", title: "launcher", url: "", status: "launcher_failed", detail: String(describing: error), channel: nil)
    emitReport(Report(ok: false, dryRun: false, timestamp: ISO8601DateFormatter().string(from: Date()), results: [result]))
    exit(error is LauncherError ? 2 : 70)
}
