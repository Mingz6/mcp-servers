import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Vision

// Helper for wechat_ocr.py. Build: swiftc -O wxvision.swift -o wxvision
//   wxvision window        -> JSON: the main WeChat window {id, x, y, w, h, onscreen}
//   wxvision ocr <png> [--crop x,y,w,h] [--scale N] [--rows x0,x1]
//                          -> JSON: {w, h, paper, lines:[{text, conf, x, y, w, h, bgc}], reds:[{x, y, w, h}], rows}
// Coordinates are original-image pixels, origin top-left, even with --crop/--scale. Cropping to a narrow
// strip and upscaling makes Vision read small gray text (chat timestamps) far better than the full window.
// reds = red blobs (unread badges) in the left 20% of the full image.
// bgc = mean [r, g, b] of a thin strip just left and one just right of the line ([] where the strip falls off the
// image); paper = the most common colour of the whole image (the window background). Text on a chat bubble sits
// on a colour close to paper; text printed on a sticker, photo or video cover usually does not.
// rows (with --rows) = one hash per pixel row of columns x0..<x1 of the full image, 0 for a row of one colour.
// The same content scrolled to another height hashes the same, so matching rows of two screens measures the scroll.
//
// Real input, for reading chats while the user is away (needs Accessibility permission):
//   wxvision input             -> JSON: {idle, key, x, y} seconds since any / key input, pointer position
//   wxvision front             -> bundle id of the frontmost app
//   wxvision move x y          -> put the pointer back (no click); x y are global points, origin top-left
//   wxvision click x y         -> left click
//   wxvision scroll x y dy     -> scroll wheel at x y, dy in pixels
//   wxvision raise             -> un-minimize and raise the main WeChat window and make WeChat frontmost,
//                                 which also switches to the desktop (Space) the window is on
// click and scroll refuse unless a WeChat window is the topmost window at x y, so a stray event can never
// land in another app.

func emit(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func mainWindow() -> [String: Any]? {
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    var best: [String: Any]? = nil
    var bestArea = 0.0
    for w in list {
        guard let owner = w[kCGWindowOwnerName as String] as? String,
              ["WeChat", "微信", "Weixin"].contains(owner),
              (w[kCGWindowLayer as String] as? Int) == 0,
              let b = w[kCGWindowBounds as String] as? [String: Any],
              let bw = b["Width"] as? Double, let bh = b["Height"] as? Double,
              bw >= 600, bh >= 400 else { continue }
        let area = bw * bh
        if area > bestArea {
            bestArea = area
            best = [
                "id": w[kCGWindowNumber as String] as? Int ?? 0,
                "x": b["X"] as? Double ?? 0, "y": b["Y"] as? Double ?? 0,
                "w": bw, "h": bh,
                "onscreen": w[kCGWindowIsOnscreen as String] as? Bool ?? false,
            ]
        }
    }
    return best
}

func rgba(_ img: CGImage) -> [UInt8] {
    let w = img.width, h = img.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return buf
}

func surround(_ buf: [UInt8], _ w: Int, _ h: Int, x: Int, y: Int, bw: Int, bh: Int) -> [[Int]] {
    guard !buf.isEmpty else { return [] }
    let gap = max(2, bh / 6), strip = max(4, bh / 2)
    return [(x - gap - strip, x - gap), (x + bw + gap, x + bw + gap + strip)].map { (x0, x1) -> [Int] in
        var sum = [0, 0, 0], n = 0
        for row in max(y + bh / 4, 0)..<max(min(y + bh * 3 / 4, h), 0) {
            for col in max(x0, 0)..<max(min(x1, w), 0) {
                let i = (row * w + col) * 4
                for c in 0..<3 { sum[c] += Int(buf[i + c]) }
                n += 1
            }
        }
        return n == 0 ? [] : sum.map { $0 / n }
    }
}

func paperColour(_ buf: [UInt8], _ w: Int, _ h: Int) -> [Int] {
    guard !buf.isEmpty else { return [] }
    var bins = [Int](repeating: 0, count: 1 << 15)
    for i in stride(from: 0, to: w * h * 4, by: 4 * 7) {
        bins[(Int(buf[i]) >> 3) << 10 | (Int(buf[i + 1]) >> 3) << 5 | Int(buf[i + 2]) >> 3] += 1
    }
    let top = bins.indices.max { bins[$0] < bins[$1] } ?? 0
    return [(top >> 10) << 3 | 4, ((top >> 5) & 31) << 3 | 4, (top & 31) << 3 | 4]
}

func rowHashes(_ buf: [UInt8], _ w: Int, _ h: Int, x0: Int, x1: Int) -> [UInt32] {
    let a = max(0, min(x0, w)), b = max(a, min(x1, w))
    guard !buf.isEmpty, b > a else { return [] }
    return (0..<h).map { row -> UInt32 in
        let first = (row * w + a) * 4
        var hash: UInt32 = 2166136261
        var flat = true
        for col in a..<b {
            let i = (row * w + col) * 4
            for c in 0..<3 {
                hash = (hash ^ UInt32(buf[i + c])) &* 16777619
                if abs(Int(buf[i + c]) - Int(buf[first + c])) > 3 { flat = false }
            }
        }
        return flat ? 0 : max(hash, 1)
    }
}

func redBoxes(_ buf: [UInt8], _ w: Int, _ h: Int) -> [[String: Int]] {
    guard !buf.isEmpty else { return [] }
    let regionW = Int(Double(w) * 0.2)
    let cell = 4
    let gw = regionW / cell + 1, gh = h / cell + 1
    var grid = [Bool](repeating: false, count: gw * gh)
    for y in 0..<h {
        for x in 0..<regionW {
            let i = (y * w + x) * 4
            if buf[i] > 200 && buf[i + 1] < 90 && buf[i + 2] < 90 { grid[(y / cell) * gw + x / cell] = true }
        }
    }
    var seen = [Bool](repeating: false, count: gw * gh)
    var out: [[String: Int]] = []
    for start in 0..<(gw * gh) where grid[start] && !seen[start] {
        var stack = [start]
        seen[start] = true
        var minX = gw, minY = gh, maxX = 0, maxY = 0, n = 0
        while let c = stack.popLast() {
            let cx = c % gw, cy = c / gw
            minX = min(minX, cx); maxX = max(maxX, cx); minY = min(minY, cy); maxY = max(maxY, cy); n += 1
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = cx + dx, ny = cy + dy
                if nx < 0 || ny < 0 || nx >= gw || ny >= gh { continue }
                let ni = ny * gw + nx
                if grid[ni] && !seen[ni] { seen[ni] = true; stack.append(ni) }
            }
        }
        if n >= 3 {
            out.append(["x": minX * cell, "y": minY * cell, "w": (maxX - minX + 1) * cell, "h": (maxY - minY + 1) * cell])
        }
    }
    return out
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: wxvision window | ocr <png> | input | front | move | click | scroll") }

func pointArg(_ i: Int) -> CGPoint {
    guard args.count > i + 1, let x = Double(args[i]), let y = Double(args[i + 1]) else { fail("need x y") }
    return CGPoint(x: x, y: y)
}

// Topmost normal window under the point (the on-screen list is ordered front to back).
func topOwner(at p: CGPoint) -> String? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let b = w[kCGWindowBounds as String] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let bw = b["Width"] as? Double, let bh = b["Height"] as? Double,
              CGRect(x: x, y: y, width: bw, height: bh).contains(p) else { continue }
        return w[kCGWindowOwnerName as String] as? String
    }
    return nil
}

func requireWeChat(at p: CGPoint) {
    guard let owner = topOwner(at: p), ["WeChat", "微信", "Weixin"].contains(owner) else {
        fail("refusing: WeChat is not the topmost window at \(Int(p.x)),\(Int(p.y))")
    }
}

func post(_ type: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func moveCursor(_ p: CGPoint) {
    CGWarpMouseCursorPosition(p)
    post(.mouseMoved, p)
    usleep(90_000)
}

switch args[1] {
case "window":
    guard let w = mainWindow() else { fail("no WeChat window found") }
    emit(w)
case "ocr":
    guard args.count >= 3, let image = NSImage(contentsOfFile: args[2]),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot load image") }
    let fullW = cg.width, fullH = cg.height
    var cropX = 0, cropY = 0
    var target = cg
    if let i = args.firstIndex(of: "--crop"), i + 1 < args.count {
        let p = args[i + 1].split(separator: ",").compactMap { Int($0) }
        guard p.count == 4, let c = cg.cropping(to: CGRect(x: p[0], y: p[1], width: p[2], height: p[3])) else { fail("bad --crop") }
        target = c; cropX = p[0]; cropY = p[1]
    }
    var scale = 1
    if let i = args.firstIndex(of: "--scale"), i + 1 < args.count, let n = Int(args[i + 1]), n > 1 {
        scale = n
        guard let up = CGContext(data: nil, width: target.width * n, height: target.height * n, bitsPerComponent: 8,
                                 bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("scale failed") }
        up.interpolationQuality = .high
        up.draw(target, in: CGRect(x: 0, y: 0, width: target.width * n, height: target.height * n))
        guard let big = up.makeImage() else { fail("scale failed") }
        target = big
    }
    let W = Double(target.width) / Double(scale), H = Double(target.height) / Double(scale)
    var lines: [[String: Any]] = []
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    do { try VNImageRequestHandler(cgImage: target, options: [:]).perform([request]) } catch { fail("OCR failed: \(error)") }
    let pixels = rgba(cg)
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        let lx = cropX + Int(b.minX * W), ly = cropY + Int((1 - b.maxY) * H), lw = Int(b.width * W), lh = Int(b.height * H)
        lines.append([
            "text": cand.string, "conf": Double(cand.confidence), "x": lx, "y": ly, "w": lw, "h": lh,
            "bgc": surround(pixels, fullW, fullH, x: lx, y: ly, bw: lw, bh: lh),
        ])
    }
    var out: [String: Any] = ["w": fullW, "h": fullH, "paper": paperColour(pixels, fullW, fullH), "lines": lines,
                              "reds": redBoxes(pixels, fullW, fullH)]
    if let i = args.firstIndex(of: "--rows"), i + 1 < args.count {
        let p = args[i + 1].split(separator: ",").compactMap { Int($0) }
        guard p.count == 2 else { fail("bad --rows") }
        out["rows"] = rowHashes(pixels, fullW, fullH, x0: p[0], x1: p[1]).map { Int($0) }
    }
    emit(out)
case "input":
    let src = CGEventSourceStateID.combinedSessionState
    let kinds: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .keyDown]
    let idle = kinds.map { CGEventSource.secondsSinceLastEventType(src, eventType: $0) }.min() ?? 0
    let key = CGEventSource.secondsSinceLastEventType(src, eventType: .keyDown)
    let loc = CGEvent(source: nil)?.location ?? .zero
    emit(["idle": idle, "key": key, "x": loc.x, "y": loc.y])
case "front":
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
case "move":
    moveCursor(pointArg(2))
case "click":
    let p = pointArg(2)
    requireWeChat(at: p)
    moveCursor(p)
    post(.leftMouseDown, p)
    usleep(60_000)
    post(.leftMouseUp, p)
case "scroll":
    let p = pointArg(2)
    guard args.count > 4, let dy = Int32(args[4]) else { fail("need dy") }
    requireWeChat(at: p)
    moveCursor(p)
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: dy, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
case "raise":
    guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.tencent.xinWeChat").first else {
        fail("WeChat is not running")
    }
    let ax = AXUIElementCreateApplication(app.processIdentifier)
    var raised = false
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
       let wins = value as? [AXUIElement] {
        var best: AXUIElement? = nil
        var bestArea: CGFloat = 0
        for w in wins {
            var sv: CFTypeRef?
            var size = CGSize.zero
            guard AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sv) == .success, let s = sv,
                  CFGetTypeID(s) == AXValueGetTypeID(), AXValueGetValue(s as! AXValue, .cgSize, &size) else { continue }
            if size.width * size.height > bestArea { bestArea = size.width * size.height; best = w }
        }
        if let w = best {
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            raised = AXUIElementPerformAction(w, kAXRaiseAction as CFString) == .success
        }
    }
    AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    emit(["raised": raised])
default:
    fail("unknown command \(args[1])")
}
