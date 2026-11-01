// Draws the app icon: a gold Persian arch on lapis, a treasury door. Usage: icon <out.iconset>
import AppKit

func draw(_ s: CGFloat) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(s), pixelsHigh: Int(s), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let u = s / 1024
  let p = { (x: CGFloat, y: CGFloat) in NSPoint(x: x * u, y: y * u) }
  let lapis = NSGradient(starting: NSColor(red: 0.09, green: 0.20, blue: 0.47, alpha: 1), ending: NSColor(red: 0.03, green: 0.08, blue: 0.24, alpha: 1))!
  let gold = NSGradient(starting: NSColor(red: 0.98, green: 0.84, blue: 0.50, alpha: 1), ending: NSColor(red: 0.80, green: 0.57, blue: 0.20, alpha: 1))!
  lapis.draw(in: NSBezierPath(roundedRect: NSRect(x: 100 * u, y: 100 * u, width: 824 * u, height: 824 * u), xRadius: 185 * u, yRadius: 185 * u), angle: -90)

  // Pointed arch, with the inner arch cut out by even-odd fill.
  func arch(_ w: CGFloat, _ bottom: CGFloat, _ spring: CGFloat, _ top: CGFloat) -> NSBezierPath {
    let (l, r, c) = (512 - w, 512 + w, CGFloat(512))
    let a = NSBezierPath()
    a.move(to: p(l, bottom))
    a.line(to: p(l, spring))
    a.curve(to: p(c, top), controlPoint1: p(l, spring + (top - spring) * 0.55), controlPoint2: p(c - w * 0.28, top - (top - spring) * 0.22))
    a.curve(to: p(r, spring), controlPoint1: p(c + w * 0.28, top - (top - spring) * 0.22), controlPoint2: p(r, spring + (top - spring) * 0.55))
    a.line(to: p(r, bottom))
    a.close()
    return a
  }
  let frame = arch(250, 225, 500, 815)
  frame.append(arch(185, 225, 490, 720))
  frame.windingRule = .evenOdd
  gold.draw(in: frame, angle: -90)
  gold.draw(in: NSBezierPath(rect: NSRect(x: 215 * u, y: 195 * u, width: 594 * u, height: 42 * u)), angle: -90)

  // The treasure: a diamond inside the arch.
  let gem = NSBezierPath()
  gem.move(to: p(512, 555)); gem.line(to: p(600, 430)); gem.line(to: p(512, 305)); gem.line(to: p(424, 430)); gem.close()
  gold.draw(in: gem, angle: -90)
  NSGraphicsContext.current = nil
  return rep
}

let out = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let name = "icon_\(base)x\(base)\(scale == 2 ? "@2x" : "").png"
    try draw(CGFloat(base * scale)).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
  }
}
