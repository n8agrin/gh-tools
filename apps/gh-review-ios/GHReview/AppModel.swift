import Foundation
import Observation
import Security

/// Everything the screens read. Local state saves on every change; the queue refreshes from GitHub.
@MainActor @Observable
final class AppModel {
    private let store: LocalStore
    private var saved: Saved

    var token: String {
        didSet { Keychain.token = token }
    }
    var loading = false
    var error: String?
    var filter = ""

    var queue: Queue? { saved.queue }
    var state: QueueState { QueueState(skipped: saved.skipped, done: saved.done) }
    var sort: SortOrder {
        get { saved.sort }
        set { saved.sort = newValue; persist() }
    }
    var directOnly: Bool {
        get { saved.directOnly }
        set { saved.directOnly = newValue; persist() }
    }

    /// What u undoes, newest last.
    private var history: [(url: String, skipped: Date?, done: DoneEntry?)] = []

    init(store: LocalStore = .standard) {
        self.store = store
        saved = store.load()
        token = Keychain.token
        #if DEBUG
        // bin/sim passes your gh token in, so a simulator run needs no pasting. It isn't saved.
        if token.isEmpty, let env = ProcessInfo.processInfo.environment["GH_TOKEN"] { _token = env }
        #endif
    }

    var prs: [ReviewPR] { queue?.prs ?? [] }

    var sections: (active: [ListSection], aside: [ListSection]) {
        arrange(prs: prs, state: state, sort: sort, directOnly: directOnly, filter: filter)
    }

    var stacks: [String: StackInfo] { findStacks(prs) }

    var doneRows: [(pr: ReviewPR, entry: DoneEntry)] {
        state.doneRows(prs: prs).filter { matches($0.pr, filter: filter) }
    }

    var waiting: Int { prs.filter { state.doneEntry($0) == nil && !state.isSkipped($0) }.count }

    func refresh() async {
        guard !token.isEmpty else { error = GitHubError.noToken.errorDescription; return }
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let (q, reviewed) = try await GitHubClient(token: token).fetchQueue()
            saved.queue = q
            mergeReviewed(reviewed, into: &saved.done)
            error = nil
            persist()
        } catch {
            // Keep showing the last good list and say why it's stale.
            self.error = error.localizedDescription
        }
    }

    func fetchPR(_ url: String) async throws -> PRDetail {
        try await GitHubClient(token: token).fetchPR(url: url)
    }

    func doneEntry(_ p: ReviewPR) -> DoneEntry? { state.doneEntry(p) }
    func isSkipped(_ p: ReviewPR) -> Bool { state.isSkipped(p) }

    /// Set aside until the PR changes on GitHub, or bring it back.
    func toggleAside(_ p: ReviewPR) {
        remember(p.url)
        saved.skipped[p.url] = isSkipped(p) ? nil : p.updatedAt
        persist()
    }

    /// Mark done by hand, or bring it back to the queue.
    func toggleDone(_ p: ReviewPR) {
        remember(p.url)
        saved.done[p.url] = doneEntry(p) == nil ? DoneEntry(pr: p, reason: "marked", doneAt: .now) : nil
        persist()
    }

    var canUndo: Bool { !history.isEmpty }

    func undo() {
        guard let last = history.popLast() else { return }
        saved.skipped[last.url] = last.skipped
        saved.done[last.url] = last.done
        persist()
    }

    private func remember(_ url: String) {
        history.append((url, saved.skipped[url], saved.done[url]))
    }

    private func persist() { store.save(saved) }
}

/// The GitHub token lives in the Keychain, not in the JSON file.
enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "gh-review",
        kSecAttrAccount as String: "github-token",
    ] }

    static var token: String {
        get {
            var q = query
            q[kSecReturnData as String] = true
            var out: AnyObject?
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "" }
            return String(decoding: data, as: UTF8.self)
        }
        set {
            SecItemDelete(query as CFDictionary)
            let value = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            var q = query
            q[kSecValueData as String] = Data(value.utf8)
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(q as CFDictionary, nil)
        }
    }
}
