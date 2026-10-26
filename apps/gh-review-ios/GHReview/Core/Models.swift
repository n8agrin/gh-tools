import Foundation

// The same shapes as apps/gh-review/src/github.ts, so the two apps read GitHub the same way.

public enum CIState: String, Codable, Sendable {
    case success, failure, pending
}

public enum PRState: String, Codable, Sendable {
    case open = "OPEN", merged = "MERGED", closed = "CLOSED"
}

/// How you got asked: by name, or through one or more teams.
public enum RequestedVia: Codable, Hashable, Sendable {
    case direct
    case teams([String])

    public var isDirect: Bool { self == .direct }
}

public struct StackEntry: Codable, Hashable, Sendable {
    public var position: Int
    public var number: Int
    public var title: String
    public var url: String
    public var state: PRState
    public var isDraft: Bool
    /// Your latest review on that layer, e.g. COMMENTED or APPROVED.
    public var myReview: String?
}

/// GitHub's own stack, when the author made one. Holds every layer, not just the ones asking you.
public struct NativeStack: Codable, Hashable, Sendable {
    public var id: String
    public var size: Int
    public var base: String
    public var position: Int
    public var entries: [StackEntry]
}

public struct ReviewPR: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var repo: String
    public var number: Int
    public var title: String
    public var url: String
    public var author: String
    public var isDraft: Bool
    public var additions: Int
    public var deletions: Int
    public var changedFiles: Int
    public var labels: [String]
    public var ci: CIState?
    public var reviewDecision: String?
    public var requestedVia: RequestedVia
    /// When the request that put this in front of you was made; falls back to when the PR opened.
    public var requestedAt: Date
    public var createdAt: Date
    public var updatedAt: Date
    public var comments: Int
    public var baseRef: String
    public var headRef: String
    public var headSha: String
    public var defaultBranch: String
    public var stack: NativeStack?
    /// Your latest review. A PR you only commented on still waits on you.
    public var myReview: String?
    public var state: PRState

    public var size: Int { additions + deletions }
}

/// A PR your latest review approved or asked changes on, which goes to Done.
public struct ReviewedPR: Sendable {
    public var pr: ReviewPR
    public var review: String
    public var at: Date
}

public struct Queue: Codable, Sendable {
    public var viewer: String
    public var fetchedAt: Date
    public var prs: [ReviewPR]
}

public struct DoneEntry: Codable, Hashable, Sendable {
    public var pr: ReviewPR
    /// approved, changes requested, or marked (by hand).
    public var reason: String
    public var doneAt: Date
}

public struct PRFile: Codable, Hashable, Sendable {
    public var path: String
    public var additions: Int
    public var deletions: Int
}

/// One PR, fresh from GitHub, for the PR page.
public struct PRDetail: Sendable {
    public var url: String
    public var title: String
    public var body: String
    public var author: String
    public var isDraft: Bool
    public var labels: [String]
    public var baseRef: String
    public var headRef: String
    public var additions: Int
    public var deletions: Int
    public var files: [PRFile]
    /// Copilot has submitted a review. Nate counts that the same as the bug-pass label.
    public var copilotReviewed: Bool
    public var state: PRState
}
