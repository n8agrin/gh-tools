import Foundation

// Local state in one JSON file. GitHub stays the source of truth: the queue here is only a copy of
// the last fetch, so the app opens instantly and keeps working when GitHub errors.

public struct Saved: Codable, Sendable {
    public var queue: Queue?
    public var skipped: [String: Date] = [:]
    public var done: [String: DoneEntry] = [:]
    public var sort: SortOrder = .oldest
    public var directOnly = false

    public init() {}
}

public struct LocalStore: Sendable {
    public var file: URL

    public init(file: URL) { self.file = file }

    public static var standard: LocalStore {
        let dir = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return LocalStore(file: dir.appending(path: "gh-review.json"))
    }

    public func load() -> Saved {
        guard let data = try? Data(contentsOf: file) else { return Saved() }
        let d = JSONDecoder()
        d.dateDecodingStrategy = .flexibleISO8601
        return (try? d.decode(Saved.self, from: data)) ?? Saved()
    }

    public func save(_ s: Saved) {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        try? e.encode(s).write(to: file, options: .atomic)
    }
}

/// Record PRs you approved or asked changes on. A later review moves the entry; the PR info always refreshes.
public func mergeReviewed(_ list: [ReviewedPR], into done: inout [String: DoneEntry]) {
    let words = ["APPROVED": "approved", "CHANGES_REQUESTED": "changes requested"]
    for r in list {
        let reason = words[r.review] ?? r.review.lowercased()
        if let old = done[r.pr.url], old.doneAt >= r.at {
            done[r.pr.url] = DoneEntry(pr: r.pr, reason: old.reason, doneAt: old.doneAt)
        } else {
            done[r.pr.url] = DoneEntry(pr: r.pr, reason: reason, doneAt: r.at)
        }
    }
}

extension JSONDecoder.DateDecodingStrategy {
    /// GitHub sends whole seconds; test fixtures and JavaScript send milliseconds. Take both.
    static let flexibleISO8601 = custom { decoder in
        let s = try decoder.singleValueContainer().decode(String.self)
        if let d = try? Date(s, strategy: .iso8601) { return d }
        if let d = try? Date(s, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not an ISO 8601 date: \(s)"))
    }
}
