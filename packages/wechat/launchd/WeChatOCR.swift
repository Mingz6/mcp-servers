// Launcher for the scheduled WeChat capture. A real (tiny) app so that macOS shows "WeChatOCR" in
// Screen Recording / Accessibility, and the grant covers this one program instead of every python3.
// It starts the Python script as a child process (not exec, which would make python3 the process macOS
// checks), waits, and passes the exit code on. The python and script paths are fixed when
// install_launchd.sh builds it, and only two modes are accepted, so it cannot be used to run anything else.
import Foundation

let python = "{{PYTHON}}"
let script = "{{SCRIPT}}"
let modes: Set<String> = ["snapshot", "auto-read"]

let args = CommandLine.arguments
guard args.count == 2, modes.contains(args[1]) else {
    FileHandle.standardError.write(Data("usage: WeChatOCR snapshot|auto-read\n".utf8))
    exit(2)
}

let child = Process()
child.executableURL = URL(fileURLWithPath: python)
child.arguments = [script, args[1]]
child.currentDirectoryURL = URL(fileURLWithPath: script).deletingLastPathComponent()

signal(SIGTERM, SIG_IGN)  // launchctl bootout: stop the child, then leave
let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
term.setEventHandler { child.terminate() }
term.resume()

do { try child.run() } catch {
    FileHandle.standardError.write(Data("error: cannot start \(python): \(error)\n".utf8))
    exit(1)
}
child.waitUntilExit()
exit(child.terminationStatus)
