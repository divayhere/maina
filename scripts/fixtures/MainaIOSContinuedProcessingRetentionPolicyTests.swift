import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
  }
}

@main
enum MainaIOSContinuedProcessingRetentionPolicyTests {
  static func main() {
let now: TimeInterval = 10_000_000
var records = (0..<12).map {
  MainaIOSContinuedProcessingRetentionPolicy.Record(
    identifier: "active-\($0)", state: .pending,
    createdAt: now - TimeInterval($0), updatedAt: now - TimeInterval($0)
  )
}
records += (0..<80).map {
  MainaIOSContinuedProcessingRetentionPolicy.Record(
    identifier: "terminal-\($0)", state: .complete,
    createdAt: now - 100, updatedAt: now - TimeInterval($0)
  )
}
let pruned = MainaIOSContinuedProcessingRetentionPolicy.prune(records, now: now)
require(pruned.filter { !$0.state.isTerminal }.count == 8, "nonterminal registry must cap at eight")
require(pruned.filter { $0.state.isTerminal }.count == 64, "seven-day tombstones must cap at 64")
require(pruned.count == 72, "combined registry must remain bounded")

let old = MainaIOSContinuedProcessingRetentionPolicy.Record(
  identifier: "expired", state: .complete,
  createdAt: now - 9 * 24 * 60 * 60, updatedAt: now - 8 * 24 * 60 * 60
)
require(MainaIOSContinuedProcessingRetentionPolicy.prune([old], now: now).isEmpty,
        "tombstones older than seven days must expire")
require(MainaIOSContinuedProcessingRetentionPolicy.mayRegister(
  identifier: "existing", registered: Set(["existing"])
), "an existing exact registration remains reusable in-process")
require(!MainaIOSContinuedProcessingRetentionPolicy.mayRegister(
  identifier: "new", registered: Set((0..<64).map { "id-\($0)" })
), "new process registrations must stop at 64")

print("iOS continued-processing retention policy tests passed.")
  }
}
