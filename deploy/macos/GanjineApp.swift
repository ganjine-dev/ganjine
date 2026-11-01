// The Ganjine window: a thin view over `ganjine status`. It holds no key and no logic of its own.
import AppKit
import SwiftUI

struct Service: Codable, Identifiable { let name: String; let ok: Bool; let detail: String; var id: String { name } }
struct Numbers: Codable { let records: Int; let pages: Int; let items: Int; let sessions: Int; let sealed: Int; let last_commit: String? }
struct Holder: Codable, Identifiable {
  let pid: Int; let role: String; let port: Int?; let command: String; let user: String; let started: String; let cwd: String; let ours: Bool; let `protected`: Bool
  var id: String { "\(role)-\(pid)" }
}
struct Issue: Codable, Identifiable { let title: String; let why: String; let check: [String]; let fix: [String]; var id: String { title } }
struct Status: Codable { let state: String; let url: String; let services: [Service]; let numbers: Numbers?; let holders: [Holder]; let issues: [Issue]; let log: [String] }

let root = Bundle.main.object(forInfoDictionaryKey: "GanjineRoot") as? String ?? FileManager.default.currentDirectoryPath
let snapshot = CommandLine.arguments.firstIndex(of: "--snapshot").map { CommandLine.arguments[$0 + 1] }

/// Finder gives an app a bare PATH, so it comes from the login shell, once.
let shellPath: String = {
  let p = Process(), out = Pipe()
  p.executableURL = URL(fileURLWithPath: "/bin/zsh")
  p.arguments = ["-lc", "print -r -- $PATH"]
  p.standardOutput = out
  try? p.run()
  p.waitUntilExit()
  return String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}()

func ganjine(_ args: [String], detach: Bool = false) -> (Int32, Data) {
  let p = Process(), out = Pipe()
  p.executableURL = URL(fileURLWithPath: "\(root)/ganjine")
  p.currentDirectoryURL = URL(fileURLWithPath: root)
  p.arguments = args
  p.environment = ProcessInfo.processInfo.environment.merging(["PATH": shellPath]) { _, new in new }
  if detach {
    let path = "\(root)/.ganjine/up.log"
    FileManager.default.createFile(atPath: path, contents: nil, attributes: FileManager.default.fileExists(atPath: path) ? nil : [:])
    let log = FileHandle(forWritingAtPath: path)
    log?.seekToEndOfFile()
    p.standardOutput = log
    p.standardError = log
    try? p.run()
    return (0, Data())
  }
  p.standardOutput = out
  p.standardError = out
  guard (try? p.run()) != nil else { return (127, Data()) }
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, data)
}

@MainActor final class Model: ObservableObject {
  @Published var status: Status?
  @Published var notice: String?
  private var began = false
  private var ticking = false
  var onFirst: (() -> Void)?

  init() {
    Task { await tick() }
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in Task { @MainActor in await self.tick() } }
  }

  func tick() async {
    if ticking { return }
    ticking = true
    let (_, data) = await Task.detached { ganjine(["status"]) }.value
    ticking = false
    guard let s = try? JSONDecoder().decode(Status.self, from: data) else {
      notice = "Could not read ganjine status. Is Node on your login PATH?"
      return
    }
    status = s
    if !began {
      began = true
      if snapshot == nil, s.state == "stopped" { start() }
      onFirst?()
    }
  }

  func start(_ extra: [String] = []) {
    notice = "Starting. Approve Touch ID or your password if asked."
    _ = ganjine(["up", "--no-open"] + extra, detach: true)
  }
  func stop() { _ = ganjine(["down"]); notice = nil }
  func open() { if let u = status.flatMap({ URL(string: $0.url) }) { NSWorkspace.shared.open(u) } }

  /// Reads first: the operator sees what would stop, and the kill re-checks that pid is still a holder.
  func kill(_ h: Holder) {
    let alert = NSAlert()
    alert.messageText = "Stop process \(h.pid)?"
    alert.informativeText = "\(h.role)\n\nCommand: \(h.command)\nUser: \(h.user)\nStarted: \(h.started)\nFolder: \(h.cwd)\n\(h.ours ? "This is an earlier Ganjine process." : "This is not a Ganjine process.")"
    alert.alertStyle = h.ours ? .informational : .warning
    alert.addButton(withTitle: "Stop It")
    alert.addButton(withTitle: "Force Kill")
    alert.addButton(withTitle: "Cancel")
    let choice = alert.runModal()
    if choice == .alertThirdButtonReturn { return }
    let (code, data) = ganjine(["kill", String(h.pid)] + (choice == .alertSecondButtonReturn ? ["--force"] : []))
    notice = code == 0 ? "Sent stop to \(h.pid)." : String(decoding: data, as: UTF8.self)
  }
}

struct Numeral: View {
  let value: String, label: String
  var body: some View {
    VStack(spacing: 2) {
      Text(value).font(.system(size: 20, weight: .semibold, design: .rounded)).monospacedDigit()
      Text(label).font(.caption2).foregroundStyle(.secondary)
    }.frame(maxWidth: .infinity)
  }
}

struct CommandRow: View {
  let command: String
  var body: some View {
    HStack {
      Text(command).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).lineLimit(2)
      Spacer()
      Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string) } label: { Image(systemName: "doc.on.doc") }
        .buttonStyle(.borderless).help("Copy")
    }
  }
}

struct Root: View {
  @ObservedObject var model: Model
  @State private var showLog = false

  var label: (String, Color) {
    switch model.status?.state {
    case "running": return ("Running", .green)
    case "starting": return ("Starting", .orange)
    case "blocked": return ("Needs attention", .orange)
    case "alarm": return ("Ledger alarm", .red)
    case "stopped": return ("Stopped", .secondary)
    default: return ("Checking", .secondary)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 40, height: 40)
        VStack(alignment: .leading, spacing: 0) {
          Text("Ganjine").font(.system(size: 20, weight: .bold, design: .rounded))
          Text("Signed workspace for your agents").font(.caption).foregroundStyle(.secondary)
        }
        Spacer()
        HStack(spacing: 6) {
          Circle().fill(label.1).frame(width: 8, height: 8)
          Text(label.0).font(.callout.weight(.medium))
        }
      }
      if let s = model.status {
        GroupBox {
          VStack(spacing: 6) {
            ForEach(s.services) { x in
              HStack {
                Image(systemName: x.ok ? "checkmark.circle.fill" : "circle").foregroundStyle(x.ok ? .green : .secondary)
                Text(x.name)
                Spacer()
                Text(x.detail).foregroundStyle(.secondary).font(.callout)
              }
            }
          }.padding(2)
        }
        if let n = s.numbers {
          HStack {
            Numeral(value: "\(n.items)", label: "Items")
            Numeral(value: "\(n.pages)", label: "Pages")
            Numeral(value: "\(n.sessions)", label: "Sessions")
            Numeral(value: "\(n.records)", label: "Records")
            Numeral(value: "\(n.sealed)", label: "Signed")
          }
        }
        ForEach(s.issues) { issue in
          GroupBox {
            VStack(alignment: .leading, spacing: 6) {
              Text(issue.title).font(.callout.weight(.semibold))
              Text(issue.why).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
              if !issue.check.isEmpty { Text("Check").font(.caption2).foregroundStyle(.secondary); ForEach(issue.check, id: \.self) { CommandRow(command: $0) } }
              if !issue.fix.isEmpty { Text("Then run").font(.caption2).foregroundStyle(.secondary); ForEach(issue.fix, id: \.self) { CommandRow(command: $0) } }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(2)
          }
        }
        ForEach(s.holders.filter { ($0.role == "Dashboard port" && s.state != "running" && s.state != "starting") }) { h in
          HStack {
            Text("\(h.role): pid " + String(h.pid)).font(.caption)
            Text(h.ours ? "Ganjine" : URL(fileURLWithPath: String(h.command.split(separator: " ").first ?? "")).lastPathComponent).font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !h.protected { Button("Inspect and Stop…") { model.kill(h) }.controlSize(.small) }
          }
        }
        if let notice = model.notice { Text(notice).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        if showLog {
          ScrollView { Text(s.log.joined(separator: "\n")).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(height: 110)
        }
        HStack {
          Button(showLog ? "Hide Log" : "Log") { showLog.toggle() }.buttonStyle(.link)
          Spacer()
          if s.state == "running" || s.state == "alarm" {
            Button("Stop Ganjine") { model.stop() }
            Button("Open Dashboard") { model.open() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
          } else if s.state == "starting" {
            Button("Stop Ganjine") { model.stop() }
          } else {
            if s.holders.contains(where: { $0.role == "Dashboard port" }) {
              Button("Start on Another Port") { model.start(["--free-port"]) }
            } else {
              Button("Start Ganjine") { model.start() }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
            }
          }
        }
      } else {
        Text(model.notice ?? "Reading status…").foregroundStyle(.secondary)
      }
    }
    .padding(18)
    .frame(width: 440)
    .fixedSize(horizontal: false, vertical: true)
  }
}

@main struct GanjineApp: App {
  @NSApplicationDelegateAdaptor(Delegate.self) var delegate
  @StateObject private var model = Model()
  var body: some Scene {
    WindowGroup("Ganjine") {
      Root(model: model).onAppear {
        guard let path = snapshot else { return }
        model.onFirst = {
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            NSApp.activate(ignoringOtherApps: true)
            guard let window = NSApp.windows.first else { exit(1) }
            let shot = Process()
            shot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            shot.arguments = ["-x", "-o", "-l", String(window.windowNumber), path]
            try? shot.run()
            shot.waitUntilExit()
            exit(0)
          }
        }
      }
    }.windowResizability(.contentSize)
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}
