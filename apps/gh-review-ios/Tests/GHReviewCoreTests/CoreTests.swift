import Foundation
import Testing
@testable import GHReviewCore

func fixture() throws -> SearchData {
    struct Wrapper: Decodable { var data: SearchData }
    let url = try #require(Bundle.module.url(forResource: "fixture", withExtension: "json"))
    return try GitHubClient.decoder.decode(Wrapper.self, from: Data(contentsOf: url)).data
}

func pr(_ number: Int, _ head: String, _ base: String, repo: String = "o/app") -> ReviewPR {
    let t = Date(timeIntervalSince1970: 0)
    return ReviewPR(
        id: "\(number)", repo: repo, number: number, title: "PR \(number)", url: "\(repo)/\(number)", author: "a",
        isDraft: false, additions: number, deletions: 0, changedFiles: 1, labels: [], ci: nil, reviewDecision: nil,
        requestedVia: .direct, requestedAt: t.addingTimeInterval(Double(number)), createdAt: t, updatedAt: t,
        comments: 0, baseRef: base, headRef: head, headSha: "", defaultBranch: "main", stack: nil, myReview: nil, state: .open)
}

@Test func readsTheFixture() throws {
    let (q, reviewed) = GitHubClient.build(try fixture(), nil, fetchedAt: .now)
    #expect(q.viewer == "n8agrin")
    #expect(!q.prs.isEmpty)
    #expect(reviewed.isEmpty)
    let first = try #require(q.prs.first { $0.number == 63901 })
    #expect(first.requestedVia == .direct)
    #expect(first.ci == .success)
    #expect(first.comments == 2)
}

@Test func ordersAStackBottomFirst() {
    let prs = [pr(3, "c", "b"), pr(1, "a", "decision"), pr(9, "z", "main"), pr(2, "b", "a")]
    let stacks = findStacks(prs)
    #expect(stacks.values.allSatisfy { $0.size == 3 && $0.base == "decision" })
    #expect(stacks["o/app/9"] == nil)
    #expect(groupStacks(prs, stacks).map { $0.rows.map(\.number) } == [[1, 2, 3], [9]])
}

@Test func aStackKeepsThePlaceOfItsFirstMember() {
    let prs = [pr(9, "z", "main"), pr(2, "b", "a"), pr(8, "y", "main"), pr(1, "a", "main")]
    #expect(groupStacks(prs, findStacks(prs)).map { $0.rows.map(\.number) } == [[9], [1, 2], [8]])
}

@Test func sameBranchInOtherReposIsNotAStack() {
    #expect(findStacks([pr(1, "a", "main", repo: "o/x"), pr(2, "b", "a", repo: "o/y")]).isEmpty)
}

@Test func setAsideHoldsUntilThePRChanges() {
    var p = pr(1, "a", "main")
    let state = QueueState(skipped: [p.url: p.updatedAt])
    #expect(state.isSkipped(p))
    p.updatedAt = p.updatedAt.addingTimeInterval(60)
    #expect(!state.isSkipped(p))
}

@Test func doneHoldsUntilANewRequest() {
    var p = pr(1, "a", "main")
    let state = QueueState(done: [p.url: DoneEntry(pr: p, reason: "marked", doneAt: p.requestedAt)])
    #expect(arrange(prs: [p], state: state, sort: .oldest, directOnly: false, filter: "").active.isEmpty)
    p.requestedAt = p.requestedAt.addingTimeInterval(60)
    #expect(arrange(prs: [p], state: state, sort: .oldest, directOnly: false, filter: "").active.count == 1)
}

@Test func draftsSinkBelowReadyPRs() {
    var draft = pr(1, "a", "main")
    draft.isDraft = true
    let rows = arrange(prs: [draft, pr(2, "b", "main")], state: QueueState(), sort: .oldest, directOnly: false, filter: "").active
    #expect(rows.map { $0.rows[0].number } == [2, 1])
}

@Test func aLaterReviewMovesTheDoneEntry() {
    let p = pr(1, "a", "main")
    var done: [String: DoneEntry] = [:]
    mergeReviewed([ReviewedPR(pr: p, review: "CHANGES_REQUESTED", at: Date(timeIntervalSince1970: 10))], into: &done)
    mergeReviewed([ReviewedPR(pr: p, review: "APPROVED", at: Date(timeIntervalSince1970: 5))], into: &done)
    #expect(done[p.url]?.reason == "changes requested")
    mergeReviewed([ReviewedPR(pr: p, review: "APPROVED", at: Date(timeIntervalSince1970: 20))], into: &done)
    #expect(done[p.url]?.reason == "approved")
}

@Test func splitsConventionalTitles() {
    #expect(splitTitle("feat(api): do a thing") == ("feat(api)", "do a thing"))
    #expect(splitTitle("Fix it") == ("", "Fix it"))
}

@Test(.enabled(if: ProcessInfo.processInfo.environment["GH_TOKEN"] != nil))
func readsTheLiveQueue() async throws {
    let client = GitHubClient(token: ProcessInfo.processInfo.environment["GH_TOKEN"]!)
    let (q, reviewed) = try await client.fetchQueue()
    print("live: \(q.viewer), \(q.prs.count) asking, \(reviewed.count) reviewed")
    #expect(!q.viewer.isEmpty)
    if let first = q.prs.first {
        let detail = try await client.fetchPR(url: first.url)
        print("live: \(first.url) has \(detail.files.count) files")
        #expect(detail.title == first.title)
    }
}
