import Foundation

// Pure functions over the queue, ported from apps/gh-review/public/app.js and stacks.js.

/// The label that marks a PR as already bug-checked, like the web app's reviewedLabel setting. Empty turns it off.
public let reviewedLabel = ""

public enum SortOrder: String, CaseIterable, Codable, Sendable {
    case oldest, smallest, newest

    public var label: String {
        switch self {
        case .oldest: "Waiting longest"
        case .smallest: "Smallest"
        case .newest: "Newest"
        }
    }

    func before(_ a: ReviewPR, _ b: ReviewPR) -> Bool {
        switch self {
        case .oldest: a.requestedAt < b.requestedAt
        case .smallest: a.size < b.size
        case .newest: a.requestedAt > b.requestedAt
        }
    }
}

/// Where a PR sits in a stack. `entries` is nil for stacks found by branch names.
public struct StackInfo: Hashable, Sendable {
    public var id: String
    public var index: Int
    public var size: Int
    public var base: String?
    public var entries: [StackEntry]?
}

/// One block of the list: a loose PR, or a stack's members bottom first.
public struct ListSection: Identifiable, Sendable {
    public var stack: StackInfo?
    public var rows: [ReviewPR]
    public var id: String { stack?.id ?? rows.first?.url ?? "" }
}

/// Local state that decides where each PR shows.
public struct QueueState: Sendable {
    /// url -> the PR's updatedAt when you set it aside.
    public var skipped: [String: Date] = [:]
    /// url -> done entry.
    public var done: [String: DoneEntry] = [:]

    public init(skipped: [String: Date] = [:], done: [String: DoneEntry] = [:]) {
        self.skipped = skipped
        self.done = done
    }

    /// A PR you set aside stays aside until it changes on GitHub.
    public func isSkipped(_ p: ReviewPR) -> Bool {
        guard let at = skipped[p.url] else { return false }
        return at >= p.updatedAt
    }

    /// Done holds until someone asks for your review again after the time it went there.
    public func doneEntry(_ p: ReviewPR) -> DoneEntry? {
        guard let d = done[p.url], d.doneAt >= p.requestedAt else { return nil }
        return d
    }

    /// Done entries newest first, showing the live PR when it's still in the queue.
    public func doneRows(prs: [ReviewPR]) -> [(pr: ReviewPR, entry: DoneEntry)] {
        let live = Dictionary(prs.map { ($0.url, $0) }, uniquingKeysWith: { a, _ in a })
        return done.values
            .filter { d in live[d.pr.url].map { doneEntry($0) != nil } ?? true }
            .sorted { $0.doneAt > $1.doneAt }
            .map { (live[$0.pr.url] ?? $0.pr, $0) }
    }
}

public func matches(_ p: ReviewPR, filter: String) -> Bool {
    let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
    if q.isEmpty { return true }
    var fields = [p.title, p.repo, "#\(p.number)", p.author] + p.labels
    if case .teams(let t) = p.requestedVia { fields += t }
    return fields.contains { $0.lowercased().contains(q) }
}

/// The queue and the set-aside list, sorted, with stacks pulled together.
public func arrange(prs: [ReviewPR], state: QueueState, sort: SortOrder, directOnly: Bool, filter: String) -> (active: [ListSection], aside: [ListSection]) {
    // Drafts sink below ready PRs in every sort: they want early eyes, not a sign-off.
    let rows = prs
        .filter { state.doneEntry($0) == nil && matches($0, filter: filter) && (!directOnly || $0.requestedVia.isDirect) }
        .sorted { a, b in a.isDraft != b.isDraft ? !a.isDraft : sort.before(a, b) }
    // Stacks come from every PR, so a filter or a set-aside layer doesn't change what a stack is.
    let stacks = findStacks(prs)
    return (groupStacks(rows.filter { !state.isSkipped($0) }, stacks), groupStacks(rows.filter(state.isSkipped), stacks))
}

/// GitHub's own stacks come with every layer. For PRs stacked the old way, a PR whose base branch is
/// another PR's head branch sits on top of it.
public func findStacks(_ prs: [ReviewPR]) -> [String: StackInfo] {
    var out: [String: StackInfo] = [:]
    for p in prs {
        if let s = p.stack, s.size > 1 {
            out[p.url] = StackInfo(id: s.id, index: s.position - 1, size: s.size, base: s.base, entries: s.entries)
        }
    }
    for (url, s) in branchStacks(prs.filter { out[$0.url] == nil }) { out[url] = s }
    return out
}

func branchStacks(_ prs: [ReviewPR]) -> [String: StackInfo] {
    let byHead = Dictionary(prs.map { ("\($0.repo):\($0.headRef)", $0) }, uniquingKeysWith: { a, _ in a })
    func parent(_ p: ReviewPR) -> ReviewPR? {
        guard !p.baseRef.isEmpty, p.baseRef != p.defaultBranch, let up = byHead["\(p.repo):\(p.baseRef)"], up.url != p.url else { return nil }
        return up
    }
    var children: [String: [ReviewPR]] = [:]
    for p in prs { if let up = parent(p) { children[up.url, default: []].append(p) } }
    var out: [String: StackInfo] = [:]
    for root in prs where parent(root) == nil {
        // Walk bottom to top. A branch can have two PRs on it, so break ties by number.
        var order: [ReviewPR] = []
        var seen: Set<String> = []
        func walk(_ p: ReviewPR) {
            guard seen.insert(p.url).inserted else { return }
            order.append(p)
            for c in (children[p.url] ?? []).sorted(by: { $0.number < $1.number }) { walk(c) }
        }
        walk(root)
        guard order.count > 1 else { continue }
        let base = root.baseRef != root.defaultBranch ? root.baseRef : nil
        for (i, p) in order.enumerated() {
            out[p.url] = StackInfo(id: root.url, index: i, size: order.count, base: base, entries: nil)
        }
    }
    return out
}

/// Keeps the sorted order but pulls each stack together, bottom first, where its first member landed.
public func groupStacks(_ rows: [ReviewPR], _ stacks: [String: StackInfo]) -> [ListSection] {
    var sections: [ListSection] = []
    var seen: Set<String> = []
    for p in rows {
        guard let s = stacks[p.url] else {
            sections.append(ListSection(stack: nil, rows: [p]))
            continue
        }
        guard seen.insert(s.id).inserted else { continue }
        let members = rows.filter { stacks[$0.url]?.id == s.id }.sorted { stacks[$0.url]!.index < stacks[$1.url]!.index }
        sections.append(ListSection(stack: s, rows: members))
    }
    return sections
}

/// What's already happened on a PR, shortest first.
public func flags(_ p: ReviewPR, done: DoneEntry? = nil) -> [String] {
    if let done { return [done.reason] + (p.state != .open ? [p.state.rawValue.lowercased()] : []) }
    var out: [String] = []
    if p.reviewDecision == "APPROVED" { out.append("approved") }
    if p.reviewDecision == "CHANGES_REQUESTED" { out.append("changes requested") }
    if p.myReview == "COMMENTED" { out.append("you commented") }
    if !reviewedLabel.isEmpty, p.labels.contains(reviewedLabel) { out.append("bug pass") }
    if case .teams(let t) = p.requestedVia { out.append("via \(t.isEmpty ? "a team" : t.joined(separator: ", "))") }
    return out
}

/// "feat(api): do a thing" shows as "do a thing", with "feat(api)" as its kind.
public func splitTitle(_ title: String) -> (kind: String, subject: String) {
    if let m = title.wholeMatch(of: /(\w+(?:\([^)]*\))?!?):\s*(.+)/) { return (String(m.1), String(m.2)) }
    return ("", title)
}

/// 5m, 3h, 2d, 4w.
public func age(_ date: Date, now: Date = .now) -> String {
    let m = now.timeIntervalSince(date) / 60
    if m < 60 { return "\(max(1, Int(m)))m" }
    if m < 1440 { return "\(Int(m / 60))h" }
    if m < 20160 { return "\(Int(m / 1440))d" }
    return "\(Int(m / 10080))w"
}
