import AppKit
import CoreGraphics
import Foundation
import Vision

// Helper for wechat_ocr.py. Build: swiftc -O wxvision.swift -o wxvision
//   wxvision window        -> JSON: the main WeChat window {id, x, y, w, h, onscreen}
//   wxvision ocr <png> [--crop x,y,w,h] [--scale N]
//                          -> JSON: {w, h, lines:[{text, conf, x, y, w, h}], reds:[{x, y, w, h}]}
// Coordinates are original-image pixels, origin top-left, even with --crop/--scale. Cropping to a narrow
// strip and upscaling makes Vision read small gray text (chat timestamps) far better than the full window.
// reds = red blobs (unread badges) in the left 20% of the full image.
//
// Real input, for reading chats while the user is away (needs Accessibility permission):
//   wxvision input             -> JSON: {idle, key, x, y} seconds since any / key input, pointer position
//   wxvision front             -> bundle id of the frontmost app
//   wxvision move x y          -> put the pointer back (no click); x y are global points, origin top-left
//   wxvision click x y         -> left click
//   wxvision scroll x y dy     -> scroll wheel at x y, dy in pixels
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

func redBoxes(_ img: CGImage) -> [[String: Int]] {
    let w = img.width, h = img.height
    let regionW = Int(Double(w) * 0.2)
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    guard let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return [] }
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
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
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let b = obs.boundingBox
        lines.append([
            "text": cand.string, "conf": Double(cand.confidence),
            "x": cropX + Int(b.minX * W), "y": cropY + Int((1 - b.maxY) * H), "w": Int(b.width * W), "h": Int(b.height * H),
        ])
    }
    emit(["w": fullW, "h": fullH, "lines": lines, "reds": redBoxes(cg)])
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
default:
    fail("unknown command \(args[1])")
}
