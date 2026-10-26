import Foundation

// Everything that talks to GitHub lives here. It only ever sends GraphQL queries, never mutations,
// so the app can't write to anyone's PR.

public enum GitHubError: LocalizedError {
    case noToken
    case http(Int, String)
    case graphQL(String)
    case notAPR(String)

    public var errorDescription: String? {
        switch self {
        case .noToken: "Add a GitHub token in Settings."
        case .http(401, _): "GitHub says the token is invalid. Paste a new one in Settings."
        case .http(let code, let body): "GitHub returned \(code): \(body.prefix(200))"
        case .graphQL(let msg): msg
        case .notAPR(let url): "Not a PR URL: \(url)"
        }
    }
}

let queueQuery = """
query($q: String!, $n: Int!) {
  viewer { login }
  search(type: ISSUE, query: $q, first: $n) {
    nodes {
      ... on PullRequest {
        id number title url isDraft createdAt updatedAt state
        additions deletions changedFiles reviewDecision
        author { login }
        viewerLatestReview { state submittedAt }
        baseRefName headRefName headRefOid
        repository { nameWithOwner defaultBranchRef { name } }
        labels(first: 10) { nodes { name } }
        comments { totalCount }
        stackEntry { position }
        stack {
          id size baseRefName
          entries(first: 50) { nodes { position pullRequest { number title url state isDraft viewerLatestReview { state } } } }
        }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewRequests(first: 30) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 30) {
          nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
        }
      }
    }
  }
}
"""

let prQuery = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title body isDraft state additions deletions baseRefName headRefName
      author { login }
      labels(first: 20) { nodes { name } }
      files(first: 100) { nodes { path additions deletions } }
      reviews(first: 50) { nodes { state author { login } } }
    }
  }
}
"""

public let searchQueue = "is:pr is:open archived:false review-requested:@me"
// GitHub clears your request once you leave any review, even comments only. Those still need you.
// Merged and closed ones too, so a PR you approved lands in Done even if it merged before the next fetch.
public let searchReviewed = "is:pr archived:false reviewed-by:@me -review-requested:@me -author:@me sort:updated-desc"

// MARK: - GraphQL response shapes

struct Login: Decodable { var login: String? }
struct Named: Decodable { var name: String }
struct Nodes<T: Decodable>: Decodable { var nodes: [T] }
struct Total: Decodable { var totalCount: Int }

struct Reviewer: Decodable {
    var __typename: String
    var login: String?
    var slug: String?

    var who: String {
        switch __typename {
        case "User": "@\(login ?? "")"
        case "Team": slug ?? ""
        default: ""
        }
    }
}

struct SearchNode: Decodable {
    struct LatestReview: Decodable { var state: String; var submittedAt: Date? }
    struct Repo: Decodable { var nameWithOwner: String; var defaultBranchRef: Named? }
    struct Position: Decodable { var position: Int }
    struct Stack: Decodable {
        struct Entry: Decodable {
            struct PR: Decodable {
                var number: Int
                var title: String
                var url: String
                var state: PRState
                var isDraft: Bool
                var viewerLatestReview: LatestReviewState?
            }
            var position: Int
            var pullRequest: PR
        }
        var id: String
        var size: Int
        var baseRefName: String
        var entries: Nodes<Entry>
    }
    struct LatestReviewState: Decodable { var state: String }
    struct Commit: Decodable {
        struct Inner: Decodable { var statusCheckRollup: LatestReviewState? }
        var commit: Inner
    }
    struct Request: Decodable { var requestedReviewer: Reviewer? }
    struct Event: Decodable { var createdAt: Date?; var requestedReviewer: Reviewer? }

    // Search returns non-PR nodes as empty objects, so everything is optional until we know it's a PR.
    var id: String?
    var number: Int?
    var title: String?
    var url: String?
    var isDraft: Bool?
    var createdAt: Date?
    var updatedAt: Date?
    var state: PRState?
    var additions: Int?
    var deletions: Int?
    var changedFiles: Int?
    var reviewDecision: String?
    var author: Login?
    var viewerLatestReview: LatestReview?
    var baseRefName: String?
    var headRefName: String?
    var headRefOid: String?
    var repository: Repo?
    var labels: Nodes<Named>?
    var comments: Total?
    var stackEntry: Position?
    var stack: Stack?
    var commits: Nodes<Commit>?
    var reviewRequests: Nodes<Request>?
    var timelineItems: Nodes<Event>?

    var isPR: Bool { number != nil }

    /// You were asked by name and your latest review only commented, so GitHub's search dropped it.
    func commentedOnly(viewer: String) -> Bool {
        (state ?? .open) == .open && viewerLatestReview?.state == "COMMENTED"
            && (timelineItems?.nodes ?? []).contains { $0.requestedReviewer?.login == viewer }
    }

    /// Turns one search node into the row the app shows.
    func toPR(viewer: String) -> ReviewPR {
        let pending = (reviewRequests?.nodes ?? []).compactMap { $0.requestedReviewer?.who }.filter { !$0.isEmpty }
        let events = timelineItems?.nodes ?? []
        let direct = pending.contains("@\(viewer)") || commentedOnly(viewer: viewer)
        // review-requested:@me matched, so if you aren't named directly a team of yours was. We can't
        // tell which of the requested teams you're on without an extra call, so show all of them.
        let teams = pending.filter { !$0.hasPrefix("@") }
        let mine = direct ? ["@\(viewer)"] : teams
        let asked = events.last { mine.contains($0.requestedReviewer?.who ?? "") }
        let created = createdAt ?? .distantPast
        let ciMap: [String: CIState] = ["SUCCESS": .success, "FAILURE": .failure, "ERROR": .failure, "PENDING": .pending, "EXPECTED": .pending]
        return ReviewPR(
            id: id ?? url ?? "",
            repo: repository?.nameWithOwner ?? "",
            number: number ?? 0,
            title: title ?? "",
            url: url ?? "",
            author: author?.login ?? "ghost",
            isDraft: isDraft ?? false,
            additions: additions ?? 0,
            deletions: deletions ?? 0,
            changedFiles: changedFiles ?? 0,
            labels: labels?.nodes.map(\.name) ?? [],
            ci: commits?.nodes.first?.commit.statusCheckRollup.flatMap { ciMap[$0.state] },
            reviewDecision: reviewDecision,
            requestedVia: direct ? .direct : .teams(teams),
            requestedAt: asked?.createdAt ?? created,
            createdAt: created,
            updatedAt: updatedAt ?? created,
            comments: comments?.totalCount ?? 0,
            baseRef: baseRefName ?? "",
            headRef: headRefName ?? "",
            headSha: headRefOid ?? "",
            defaultBranch: repository?.defaultBranchRef?.name ?? "",
            stack: stack.map { s in
                NativeStack(
                    id: s.id, size: s.size, base: s.baseRefName, position: stackEntry?.position ?? 0,
                    entries: s.entries.nodes.map {
                        StackEntry(
                            position: $0.position, number: $0.pullRequest.number, title: $0.pullRequest.title,
                            url: $0.pullRequest.url, state: $0.pullRequest.state, isDraft: $0.pullRequest.isDraft,
                            myReview: $0.pullRequest.viewerLatestReview?.state)
                    })
            },
            myReview: viewerLatestReview?.state,
            state: state ?? .open)
    }
}

struct SearchData: Decodable {
    var viewer: Login
    var search: Nodes<SearchNode>
}

struct PRData: Decodable {
    struct Repo: Decodable { var pullRequest: Node? }
    struct Node: Decodable {
        struct Review: Decodable { var state: String; var author: Login? }
        var title: String
        var body: String?
        var isDraft: Bool
        var state: PRState
        var additions: Int
        var deletions: Int
        var baseRefName: String
        var headRefName: String
        var author: Login?
        var labels: Nodes<Named>
        var files: Nodes<PRFile>?
        var reviews: Nodes<Review>
    }
    var repository: Repo?
}

struct GraphQLResponse<T: Decodable>: Decodable {
    struct Message: Decodable { var message: String }
    var data: T?
    var errors: [Message]?
}

// MARK: - Client

public struct GitHubClient: Sendable {
    public var token: String
    public var session: URLSession = .shared

    public init(token: String) { self.token = token }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .flexibleISO8601
        return d
    }()

    func query<T: Decodable>(_ query: String, _ variables: [String: any Sendable], as: T.Type) async throws -> T {
        precondition(!query.contains("mutation"), "gh-review only reads from GitHub")
        guard !token.isEmpty else { throw GitHubError.noToken }
        var req = URLRequest(url: URL(string: "https://api.github.com/graphql")!)
        req.httpMethod = "POST"
        req.setValue("bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])
        let (data, res) = try await session.data(for: req)
        let code = (res as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw GitHubError.http(code, String(decoding: data, as: UTF8.self)) }
        let body = try Self.decoder.decode(GraphQLResponse<T>.self, from: data)
        if let out = body.data { return out }
        throw GitHubError.graphQL(body.errors?.map(\.message).joined(separator: "\n") ?? "GitHub returned no data")
    }

    /// The queue plus the PRs you've approved or asked changes on, which go to Done.
    public func fetchQueue() async throws -> (Queue, [ReviewedPR]) {
        async let asked = query(queueQuery, ["q": searchQueue, "n": 100], as: SearchData.self)
        async let byMe = try? query(queueQuery, ["q": searchReviewed, "n": 40], as: SearchData.self)
        let (data, mine) = try await (asked, byMe)
        return Self.build(data, mine, fetchedAt: .now)
    }

    static func build(_ data: SearchData, _ byMe: SearchData?, fetchedAt: Date) -> (Queue, [ReviewedPR]) {
        let viewer = data.viewer.login ?? ""
        let mine = (byMe?.search.nodes ?? []).filter(\.isPR)
        let nodes = data.search.nodes.filter(\.isPR) + mine.filter { $0.commentedOnly(viewer: viewer) }
        let reviewed = mine.compactMap { n -> ReviewedPR? in
            guard let r = n.viewerLatestReview, ["APPROVED", "CHANGES_REQUESTED"].contains(r.state) else { return nil }
            return ReviewedPR(pr: n.toPR(viewer: viewer), review: r.state, at: r.submittedAt ?? fetchedAt)
        }
        return (Queue(viewer: viewer, fetchedAt: fetchedAt, prs: nodes.map { $0.toPR(viewer: viewer) }), reviewed)
    }

    /// One PR, fresh from GitHub, for its page.
    public func fetchPR(url: String) async throws -> PRDetail {
        guard let m = url.wholeMatch(of: /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/), let number = Int(m.3) else {
            throw GitHubError.notAPR(url)
        }
        let data = try await query(prQuery, ["owner": String(m.1), "name": String(m.2), "number": number], as: PRData.self)
        guard let n = data.repository?.pullRequest else { throw GitHubError.graphQL("PR not found") }
        return PRDetail(
            url: url, title: n.title, body: n.body ?? "", author: n.author?.login ?? "ghost", isDraft: n.isDraft,
            labels: n.labels.nodes.map(\.name), baseRef: n.baseRefName, headRef: n.headRefName,
            additions: n.additions, deletions: n.deletions, files: n.files?.nodes ?? [],
            copilotReviewed: n.reviews.nodes.contains { ($0.author?.login ?? "").localizedCaseInsensitiveContains("copilot") && $0.state != "PENDING" },
            state: n.state)
    }
}
