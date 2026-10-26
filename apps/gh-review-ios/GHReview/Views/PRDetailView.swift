import SwiftUI

/// The PR page: what it is, where it stands, the description and the files. Fresh from GitHub on open.
struct PRDetailView: View {
    @Environment(AppModel.self) private var model
    let url: String
    @State private var detail: PRDetail?
    @State private var error: String?

    /// The queue's copy, or Done's when the PR has left the queue.
    private var pr: ReviewPR? {
        model.prs.first { $0.url == url } ?? model.state.done[url]?.pr
    }

    var body: some View {
        List {
            if let pr { header(pr) }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            if let detail {
                if !detail.body.isEmpty {
                    Section("Description") {
                        Text(markdown(detail.body)).font(.callout).textSelection(.enabled)
                    }
                }
                Section("\(detail.files.count) files") {
                    ForEach(detail.files.sorted { $0.additions + $0.deletions > $1.additions + $1.deletions }, id: \.path) { f in
                        HStack {
                            Text(f.path).font(.caption.monospaced()).lineLimit(2).truncationMode(.head)
                            Spacer()
                            Text(verbatim: "+\(f.additions)").foregroundStyle(.green).font(.caption.monospacedDigit())
                            Text(verbatim: "−\(f.deletions)").foregroundStyle(.red).font(.caption.monospacedDigit())
                        }
                    }
                }
            } else if error == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(pr.map { String("\($0.repo.split(separator: "/").last ?? "")#\($0.number)") } ?? "PR")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let pr {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if let u = URL(string: url) {
                        Link(destination: u) { Label("Open on GitHub", systemImage: "safari") }
                            .keyboardShortcut("o", modifiers: [])
                    }
                    Menu("More", systemImage: "ellipsis.circle") { PRMenu(pr: pr) }
                }
            }
        }
        .task(id: url) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            detail = try await model.fetchPR(url)
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
            // The page went away mid-load; the next appearance loads again.
        } catch {
            self.error = error.localizedDescription
        }
    }

    @ViewBuilder
    private func header(_ pr: ReviewPR) -> some View {
        let (kind, subject) = splitTitle(pr.title)
        let done = model.doneEntry(pr)
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(subject).font(.title3.weight(.semibold))
                HStack(spacing: 6) {
                    Avatar(login: pr.author, size: 20)
                    Text(verbatim: "@\(pr.author)")
                    if !kind.isEmpty { Tag(text: kind) }
                    if pr.isDraft { Tag(text: "draft") }
                }
                .font(.subheadline)
            }
            .padding(.vertical, 4)
            fact(done == nil ? "Asked" : "Done", "\(age(done?.doneAt ?? pr.requestedAt)) ago")
            fact("Size", "+\(pr.additions) −\(pr.deletions) in \(pr.changedFiles) file\(pr.changedFiles == 1 ? "" : "s")")
            LabeledContent("CI") { CIDot(ci: pr.ci) }
            fact("Comments", "\(pr.comments)")
            let status = flags(pr, done: done)
            if !status.isEmpty { fact("Status", status.joined(separator: " · ")) }
            if let detail {
                // A Copilot review counts the same as the reviewed label.
                let passed = (!reviewedLabel.isEmpty && detail.labels.contains(reviewedLabel)) || detail.copilotReviewed
                fact("Bug pass", passed ? "done" : "not yet, send it back to the author")
                fact("Branch", "\(detail.headRef) → \(detail.baseRef)")
                if !detail.labels.isEmpty { fact("Labels", detail.labels.joined(separator: ", ")) }
            }
            if let stack = model.stacks[pr.url] { fact("Stack", "Part \(stack.index + 1) of \(stack.size)") }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        LabeledContent(label, value: value).font(.subheadline)
    }

    /// Inline markdown with the line breaks kept. Headings and lists show as plain lines.
    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}
