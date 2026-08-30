import Foundation

enum MainaIOSContinuedProcessingRetentionPolicy {
  enum State: String, Equatable {
    case pending, attached, deferralRequested, deferred, complete

    var isTerminal: Bool { self == .deferred || self == .complete }
  }

  struct Record: Equatable {
    let identifier: String
    var state: State
    let createdAt: TimeInterval
    var updatedAt: TimeInterval
  }

  static let maximumNonterminal = 8
  static let maximumTombstones = 64
  static let maximumProcessRegistrations = 64
  static let nonterminalLifetime: TimeInterval = 24 * 60 * 60
  static let tombstoneLifetime: TimeInterval = 7 * 24 * 60 * 60

  static func prune(_ records: [Record], now: TimeInterval) -> [Record] {
    var active = records.filter {
      !$0.state.isTerminal && now - $0.createdAt < nonterminalLifetime
    }.sorted { $0.createdAt > $1.createdAt }
    var terminal = records.filter {
      $0.state.isTerminal && now - $0.updatedAt < tombstoneLifetime
    }.sorted { $0.updatedAt > $1.updatedAt }

    if active.count > maximumNonterminal {
      terminal.append(contentsOf: active.dropFirst(maximumNonterminal).map { item in
        var deferred = item
        deferred.state = .deferred
        deferred.updatedAt = now
        return deferred
      })
      active = Array(active.prefix(maximumNonterminal))
    }
    terminal = Array(terminal.sorted { $0.updatedAt > $1.updatedAt }.prefix(maximumTombstones))
    return Array(terminal.reversed()) + Array(active.reversed())
  }

  static func mayRegister(identifier: String, registered: Set<String>) -> Bool {
    registered.contains(identifier) || registered.count < maximumProcessRegistrations
  }
}
