// Asks macOS for the device owner, then hands over the ledger key. See docs/adr/0007.
import Foundation
import LocalAuthentication
import Security

let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: "ganjine", kSecAttrService as String: "ganjine-ledger-key"]

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("ganjine-unlock: \(message)\n".utf8))
  exit(1)
}

func owner() {
  let context = LAContext()
  var error: NSError?
  guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { fail(error?.localizedDescription ?? "no authentication available") }
  let done = DispatchSemaphore(value: 0)
  var allowed = false
  context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "unlock Ganjine") { ok, _ in
    allowed = ok
    done.signal()
  }
  done.wait()
  if !allowed { fail("not authenticated") }
}

switch CommandLine.arguments.dropFirst().first {
case "check":
  var error: NSError?
  if !LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { fail(error?.localizedDescription ?? "unavailable") }
  print("ok")
case "add":
  let seed = FileHandle.standardInput.readDataToEndOfFile()
  var item = query
  item[kSecValueData as String] = seed
  let status = SecItemAdd(item as CFDictionary, nil)
  if status != errSecSuccess { fail(SecCopyErrorMessageString(status, nil) as String? ?? "keychain error \(status)") }
case "read":
  owner()
  var item = query
  item[kSecReturnData as String] = true
  var out: CFTypeRef?
  let status = SecItemCopyMatching(item as CFDictionary, &out)
  guard status == errSecSuccess, let data = out as? Data else { fail(SecCopyErrorMessageString(status, nil) as String? ?? "keychain error \(status)") }
  FileHandle.standardOutput.write(data)
default:
  fail("usage: ganjine-unlock check|add|read")
}
