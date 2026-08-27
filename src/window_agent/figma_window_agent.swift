// ---------------------------------------------------------------------------
// figma-window-agent — one long-lived process per watched Figma window.
//
// Replaces the per-frame `screencapture` + `sips` pipeline, which spawned five
// processes and did two disk round-trips for every single frame and so could
// not go faster than one frame every 2-3 seconds. Here the window is captured
// by ScreenCaptureKit and encoded by VideoToolbox in-process, and only encoded
// H.264 crosses the wire: a mostly-static Figma window costs ~0.5 Mbps instead
// of the ~10 Mbps that JPEG frames at the same rate would push through the
// nexus tunnel.
//
// Capture and input live in the SAME binary on purpose. Both need a macOS
// privacy grant (Screen Recording, and Accessibility for synthetic events), and
// one binary means one grant to hand out and audit rather than two — and no
// process spawn per click.
//
// stdin   newline-delimited JSON commands (see handle() below)
// stdout  framed binary: <4-byte BE length><1-byte type><payload>
//           1 = JSON event (utf8)
//           4 = H.264 access unit, Annex-B, prefixed by <8-byte BE pts90k><1-byte keyframe>
// stderr  human-readable log
//
// Annex-B rather than a container: the relay packetizes these NALs straight
// into RTP (RFC 6184) for WebRTC, so any muxing here would only have to be
// undone. Encoding is VideoToolbox, i.e. the hardware encoder — Apple silicon
// has no VP8 encoder, which is why the WebRTC offer advertises H.264.
// ---------------------------------------------------------------------------
import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit
import VideoToolbox

// MARK: - Wire protocol

enum OutputType: UInt8 {
    case json = 1
    case accessUnit = 4
}

let stdoutLock = NSLock()

func emit(_ type: OutputType, _ payload: Data) {
    var header = Data(capacity: 5)
    let length = UInt32(payload.count + 1).bigEndian
    withUnsafeBytes(of: length) { header.append(contentsOf: $0) }
    header.append(type.rawValue)
    stdoutLock.lock()
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(payload)
    stdoutLock.unlock()
}

func emitEvent(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    emit(.json, data)
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[window-agent] \(message)\n".utf8))
}

// MARK: - Commands

struct Config: Codable {
    // Deliberately conservative defaults: this stream crosses a shared tunnel,
    // so the console opts UP into quality rather than starting expensive.
    var fps: Int = 12
    var maxWidth: Int = 1280
    var bitrate: Int = 800_000
    var showsCursor: Bool = true

    mutating func clamp() {
        fps = min(60, max(1, fps))
        maxWidth = min(2560, max(320, maxWidth))
        bitrate = min(12_000_000, max(100_000, bitrate))
    }
}

// MARK: - Window lookup

struct TargetWindow {
    let id: CGWindowID
    let title: String
    let bounds: CGRect   // screen points, top-left origin (CoreGraphics space)
}

func normalized(_ value: String) -> String {
    let scalars = value.unicodeScalars.drop { !CharacterSet.alphanumerics.contains($0) }
    return String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}

// Figma windows only, ordered front to back, so a title match cannot pick a
// menu, tooltip or shadow layer.
func figmaWindows() -> [TargetWindow] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
        guard (row[kCGWindowOwnerName as String] as? String) == "Figma",
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let boundsDict = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { return nil }
        return TargetWindow(id: number, title: row[kCGWindowName as String] as? String ?? "", bounds: bounds)
    }
}

func findWindow(match: String?, windowId: CGWindowID?) -> TargetWindow? {
    let windows = figmaWindows()
    if let windowId { return windows.first { $0.id == windowId } }
    guard let match, !match.isEmpty else { return windows.first }
    let wanted = normalized(match)
    if let hit = windows.first(where: { normalized($0.title) == wanted }) { return hit }
    if let hit = windows.first(where: { normalized($0.title).contains(wanted) || wanted.contains(normalized($0.title)) }) { return hit }
    // macOS withholds window titles until Screen Recording is granted; a single
    // Figma window is still unambiguous.
    return windows.count == 1 ? windows.first : nil
}

// MARK: - Synthetic input

// A hard allowlist, mirrored in the console. Free-form typing into a shared
// design file from a web page is a different risk class than clicking: one
// stray keystroke edits the document. These are the view-only shortcuts.
let allowedKeys: [String: CGKeyCode] = [
    "backslash": 0x2A,   // Figma's show/hide UI toggle (₩ on a Korean layout — same physical key)
    "escape": 0x35,
    "left": 0x7B,
    "right": 0x7C,
    "down": 0x7D,
    "up": 0x7E,
    "one": 0x12,         // shift+1 zoom to fit
    "two": 0x13,         // shift+2 zoom to selection
    "zero": 0x1D,        // shift+0 zoom to 100%
    "minus": 0x1B,
    "equal": 0x18,
    "n": 0x2D,           // shift+N zoom to fit selection in some builds
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for name in names {
        switch name {
        case "shift": flags.insert(.maskShift)
        case "command", "cmd": flags.insert(.maskCommand)
        case "option", "alt": flags.insert(.maskAlternate)
        case "control", "ctrl": flags.insert(.maskControl)
        default: break
        }
    }
    return flags
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          CFGetTypeID(positionValue!) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue!) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &origin),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

func frameMatches(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat = 4) -> Bool {
    abs(lhs.origin.x - rhs.origin.x) <= tolerance && abs(lhs.origin.y - rhs.origin.y) <= tolerance
        && abs(lhs.width - rhs.width) <= tolerance && abs(lhs.height - rhs.height) <= tolerance
}

func figmaApp() -> NSRunningApplication? {
    NSWorkspace.shared.runningApplications.first {
        $0.bundleIdentifier == "com.figma.Desktop" || $0.localizedName == "Figma"
    }
}

// ---------------------------------------------------------------------------
// Input delivery without hijacking the machine.
//
// Measured on macOS 26: posting to the global HID tap (CGEvent.post) warps the
// physical cursor to the click point and, together with activating the app,
// yanks the operator's focus away mid-work. Posting to Figma's process instead
// (CGEventPostToPid) never touches the cursor — but Figma ignores events while
// it is not the active app, so posting alone does nothing at all.
//
// So: activate Figma only long enough for it to accept events, deliver by pid
// so the cursor stays put, and hand focus back to whoever had it once the input
// stops. Focus is restored on an idle timer rather than per event, so a burst
// of clicks does not pay the activate/restore round trip each time.
// ---------------------------------------------------------------------------
final class InputSession {
    private let lock = NSLock()
    private var previousApp: NSRunningApplication?
    private var restoreWorkItem: DispatchWorkItem?
    private let idleRestore: TimeInterval = 0.8

    // Returns the Figma app once it is ready to accept synthetic events.
    func begin() -> NSRunningApplication? {
        guard let app = figmaApp() else { return nil }
        lock.lock()
        restoreWorkItem?.cancel()
        restoreWorkItem = nil
        let alreadyActive = app.isActive
        if !alreadyActive && previousApp == nil {
            previousApp = NSWorkspace.shared.frontmostApplication
        }
        lock.unlock()
        if !alreadyActive {
            app.activate(options: [])
            // Figma needs a beat to take key status before it will route events.
            for _ in 0..<25 where !app.isActive { usleep(20_000) }
        }
        return app
    }

    // Give focus back after the operator stops driving, not between clicks.
    func end() {
        lock.lock()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let previous = self.previousApp
            self.previousApp = nil
            self.restoreWorkItem = nil
            self.lock.unlock()
            previous?.activate(options: [])
        }
        restoreWorkItem?.cancel()
        restoreWorkItem = item
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + idleRestore, execute: item)
    }
}

let inputSession = InputSession()

// Raise the target window WITHIN Figma (z-order only — this is not an app
// activation), so a click meant for the streamed window cannot land on a
// sibling window stacked over the same point.
func raiseWindow(_ app: NSRunningApplication, _ window: TargetWindow) {
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success,
          let axWindows = value as? [AXUIElement] else { return }
    // There is no public way to read a CGWindowID off an AXUIElement, so match
    // on the frame instead: both APIs report the same screen rect.
    for axWindow in axWindows where axFrame(axWindow).map({ frameMatches($0, window.bounds) }) == true {
        AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(axWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
        break
    }
}

@discardableResult
func postClick(in window: TargetWindow, normX: Double, normY: Double, clickCount: Int, right: Bool) -> Bool {
    // Normalized coordinates keep the console honest: it never has to know the
    // capture scale, and a point outside the window cannot even be expressed.
    guard normX >= 0, normX <= 1, normY >= 0, normY <= 1 else { return false }
    guard let live = findWindow(match: nil, windowId: window.id), let app = inputSession.begin() else { return false }
    defer { inputSession.end() }
    raiseWindow(app, live)
    let point = CGPoint(x: live.bounds.origin.x + live.bounds.width * normX,
                        y: live.bounds.origin.y + live.bounds.height * normY)
    let pid = app.processIdentifier
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let button: CGMouseButton = right ? .right : .left
    // A move first so Figma hit-tests the right window before the press.
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)?.postToPid(pid)
    usleep(20_000)
    for index in 1...max(1, min(3, clickCount)) {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else { return false }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(index))
        down.postToPid(pid)
        usleep(20_000)
        up.postToPid(pid)
        usleep(20_000)
    }
    return true
}

@discardableResult
func postKey(in window: TargetWindow, key: String, modifiers: [String]) -> Bool {
    guard let code = allowedKeys[key] else { return false }
    guard let live = findWindow(match: nil, windowId: window.id), let app = inputSession.begin() else { return false }
    defer { inputSession.end() }
    raiseWindow(app, live)
    let flags = modifierFlags(modifiers)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
    down.flags = flags
    up.flags = flags
    let pid = app.processIdentifier
    down.postToPid(pid)
    usleep(20_000)
    up.postToPid(pid)
    return true
}

// MARK: - Capture + encode

final class WindowStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    private let queue = DispatchQueue(label: "figma-window-agent.capture")
    private var stream: SCStream?
    private var session: VTCompressionSession?
    private var forceKeyframe = true       // the first frame a viewer sees must be an IDR
    private var sentParameterSets = false
    private var ptsOrigin: Double?         // capture clock is mach-absolute; rebase to ~0

    var config = Config()
    private(set) var target: TargetWindow?

    func setTarget(_ window: TargetWindow) { target = window }

    // A browser sends PLI when it joins or loses packets; answer with an IDR
    // instead of leaving it on a grey frame until the next periodic keyframe.
    func requestKeyframe() { queue.async { self.forceKeyframe = true } }

    func start() async throws {
        guard let target else { throw AgentError.message("no target window selected") }
        await stop()

        // Measured failure mode on the fleet: without a Screen Recording grant
        // for THIS process chain, SCShareableContent never returns — no error,
        // no timeout, the stream just silently never starts. Preflight turns
        // that into an explicit, actionable error (and, in a GUI session,
        // CGRequestScreenCaptureAccess raises the system prompt once).
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            throw AgentError.message(
                "Screen Recording permission is missing for this process chain — "
                + "System Settings > Privacy & Security > Screen Recording에서 릴레이 런타임(bun 또는 bash)을 허용하고 릴레이를 재시작하세요"
            )
        }

        // Belt and braces: even with the grant, treat a shareable-content
        // lookup that takes >10s as failed rather than hanging the stream.
        let content = try await withThrowingTaskGroup(of: SCShareableContent.self) { group in
            group.addTask { try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
            group.addTask {
                try await Task.sleep(nanoseconds: 10_000_000_000)
                throw AgentError.message("SCShareableContent timed out after 10s — screen capture is blocked for this process")
            }
            let value = try await group.next()!
            group.cancelAll()
            return value
        }
        guard let scWindow = content.windows.first(where: { $0.windowID == target.id }) else {
            throw AgentError.message("window \(target.id) is no longer shareable — was it closed?")
        }

        let scale = min(1.0, Double(config.maxWidth) / max(1.0, Double(scWindow.frame.width)))
        // H.264 wants even dimensions.
        let width = max(2, Int((Double(scWindow.frame.width) * scale).rounded(.down)) & ~1)
        let height = max(2, Int((Double(scWindow.frame.height) * scale).rounded(.down)) & ~1)

        try makeEncoder(width: width, height: height)

        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(config.fps))
        configuration.showsCursor = config.showsCursor
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 5

        let filter = SCContentFilter(desktopIndependentWindow: scWindow)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
        emitEvent([
            "event": "started", "windowId": Int(target.id), "title": target.title,
            "width": width, "height": height, "fps": config.fps, "bitrate": config.bitrate,
        ])
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
            self.stream = nil
        }
        queue.sync {
            if let session {
                VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
                VTCompressionSessionInvalidate(session)
                self.session = nil
            }
            sentParameterSets = false
            forceKeyframe = true
            ptsOrigin = nil
        }
    }

    private func makeEncoder(width: Int, height: Int) throws {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: nil, refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw AgentError.message("VTCompressionSessionCreate failed (\(status))")
        }
        // Baseline + no reordering: every access unit is decodable on arrival,
        // which is what keeps WebRTC latency at one frame.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_ConstrainedBaseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: config.bitrate))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: config.fps))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 4))
        // A hard cap the encoder must not exceed even on a full-screen redraw,
        // so one scroll cannot blow out the viewer's link.
        let ceiling = [NSNumber(value: config.bitrate * 2 / 8), NSNumber(value: 1.0)] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: ceiling)
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), sampleBuffer.numSamples > 0 else { return }
        // SCStream also emits idle/blank frames; only complete ones carry pixels.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusValue = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusValue), status == .complete else { return }
        guard let session, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        var properties: CFDictionary?
        if forceKeyframe {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
            forceKeyframe = false
        }
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: presentationTime,
            duration: .invalid, frameProperties: properties, infoFlagsOut: nil
        ) { [weak self] status, _, buffer in
            guard status == noErr, let buffer else { return }
            self?.emitAccessUnit(buffer)
        }
    }

    // VideoToolbox hands back AVCC (4-byte length prefixes) with SPS/PPS living
    // in the format description. RTP wants Annex-B NALs, and a decoder that
    // joins mid-stream needs the parameter sets in-band, so re-emit them ahead
    // of every keyframe.
    private func emitAccessUnit(_ buffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(buffer) else { return }
        let isKeyframe = !((CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[CFString: Any]])?
            .first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)

        var payload = Data()
        let startCode = Data([0x00, 0x00, 0x00, 0x01])

        if isKeyframe, let format = CMSampleBufferGetFormatDescription(buffer) {
            var count = 0
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr {
                for index in 0..<count {
                    var pointer: UnsafePointer<UInt8>?
                    var size = 0
                    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let pointer {
                        payload.append(startCode)
                        payload.append(pointer, count: size)
                    }
                }
            }
            sentParameterSets = true
        }
        guard sentParameterSets else { return }   // never ship a P-frame before any SPS/PPS

        var lengthAtOffset = 0
        var totalLength = 0
        var rawPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset, totalLengthOut: &totalLength, dataPointerOut: &rawPointer) == noErr,
              let rawPointer else { return }
        rawPointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
            var offset = 0
            while offset + 4 <= totalLength {
                let nalLength = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
                offset += 4
                guard nalLength > 0, offset + nalLength <= totalLength else { break }
                payload.append(startCode)
                payload.append(UnsafeBufferPointer(start: bytes + offset, count: nalLength))
                offset += nalLength
            }
        }
        guard payload.count > 4 else { return }

        // 90 kHz is the RTP clock for video, and the stream is rebased to its
        // own first frame — the capture clock is mach-absolute, far past what a
        // 32-bit RTP timestamp holds. Each peer still adds its own random
        // offset on top, as RFC 3550 wants.
        let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
        if ptsOrigin == nil { ptsOrigin = seconds }
        let pts90k = UInt64(max(0, (seconds - (ptsOrigin ?? seconds)) * 90_000))
        var framed = Data(capacity: payload.count + 9)
        withUnsafeBytes(of: pts90k.bigEndian) { framed.append(contentsOf: $0) }
        framed.append(isKeyframe ? 1 : 0)
        framed.append(payload)
        emit(.accessUnit, framed)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emitEvent(["event": "error", "message": error.localizedDescription])
    }
}

enum AgentError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let text): return text }
    }
}

// MARK: - Main loop

let streamer = WindowStreamer()

func handle(_ line: String) async {
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = object["cmd"] as? String else { return }
    do {
        switch cmd {
        case "target":
            let windowId = (object["windowId"] as? NSNumber)?.uint32Value
            guard let window = findWindow(match: object["match"] as? String, windowId: windowId) else {
                emitEvent(["event": "error", "message": "no Figma window matches \(object["match"] as? String ?? "(any)")"])
                return
            }
            streamer.setTarget(window)
            emitEvent(["event": "target", "windowId": Int(window.id), "title": window.title,
                       "width": window.bounds.width, "height": window.bounds.height])
        case "config":
            var config = streamer.config
            if let fps = object["fps"] as? Int { config.fps = fps }
            if let maxWidth = object["maxWidth"] as? Int { config.maxWidth = maxWidth }
            if let bitrate = object["bitrate"] as? Int { config.bitrate = bitrate }
            if let showsCursor = object["showsCursor"] as? Bool { config.showsCursor = showsCursor }
            config.clamp()
            streamer.config = config
            emitEvent(["event": "config", "fps": config.fps, "maxWidth": config.maxWidth, "bitrate": config.bitrate])
            if streamer.target != nil { try await streamer.start() }   // re-encode at the new settings
        case "start":
            try await streamer.start()
        case "stop":
            await streamer.stop()
            emitEvent(["event": "stopped"])
        case "click":
            guard let window = streamer.target else { return }
            let ok = postClick(in: window,
                               normX: object["x"] as? Double ?? -1,
                               normY: object["y"] as? Double ?? -1,
                               clickCount: object["clickCount"] as? Int ?? 1,
                               right: (object["button"] as? String) == "right")
            emitEvent(["event": "click", "ok": ok])
        case "key":
            guard let window = streamer.target, let key = object["key"] as? String else { return }
            let ok = postKey(in: window, key: key, modifiers: object["modifiers"] as? [String] ?? [])
            emitEvent(["event": "key", "ok": ok, "key": key])
        case "keyframe":
            streamer.requestKeyframe()
        case "ping":
            emitEvent(["event": "pong"])
        default:
            emitEvent(["event": "error", "message": "unknown command: \(cmd)"])
        }
    } catch {
        emitEvent(["event": "error", "message": String(describing: error)])
    }
}

let semaphore = DispatchSemaphore(value: 0)

Task.detached {
    emitEvent(["event": "ready", "pid": ProcessInfo.processInfo.processIdentifier])
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        await handle(line)
    }
    await streamer.stop()
    semaphore.signal()
}

semaphore.wait()
