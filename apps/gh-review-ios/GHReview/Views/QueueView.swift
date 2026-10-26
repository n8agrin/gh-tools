import SwiftUI

struct QueueView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @Binding var selected: String?
    @State private var showAside = false

    var body: some View {
        @Bindable var model = model
        let (active, aside) = model.sections
        let rows = active.flatMap(\.rows) + (showAside ? aside.flatMap(\.rows) : [])
        List(selection: $selected) {
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.footnote)
            }
            sections(active)
            if !aside.isEmpty {
                Section {
                    if showAside { sections(aside) }
                } header: {
                    Button(showAside ? "Hide \(aside.count) set aside" : "\(aside.count) set aside") { showAside.toggle() }
                        .font(.footnote)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.queue == nil && model.loading {
                ProgressView("Loading your review requests…")
            } else if rows.isEmpty && model.queue != nil {
                ContentUnavailableView(
                    model.filter.isEmpty ? "Nothing waiting on your review" : "Nothing matches",
                    systemImage: "checkmark.circle")
            }
        }
        .navigationTitle("\(model.waiting) waiting")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.filter, prompt: "Title, repo, #number, author, label")
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if model.canUndo {
                    Button("Undo", systemImage: "arrow.uturn.backward") { model.undo() }
                        .keyboardShortcut("u", modifiers: [])
                }
                Menu("Sort", systemImage: "line.3.horizontal.decrease.circle") {
                    Picker("Sort", selection: $model.sort) {
                        ForEach(SortOrder.allCases, id: \.self) { Text($0.label) }
                    }
                    Toggle("Asked me by name", isOn: $model.directOnly)
                }
            }
        }
        // j/k walk the rows in the order they're drawn, stacks included. Arrow keys work through List.
        .onKeyPress(characters: .init(charactersIn: "jkexo")) { press in
            let urls = rows.map(\.url)
            let i = selected.flatMap { urls.firstIndex(of: $0) }
            let current = i.map { rows[$0] }
            switch press.characters {
            case "j": selected = urls[safe: (i ?? -1) + 1] ?? selected
            case "k": selected = urls[safe: (i ?? urls.count) - 1] ?? selected
            case "e": if let current { advance(from: current, in: urls); model.toggleDone(current) }
            case "x": if let current { advance(from: current, in: urls); model.toggleAside(current) }
            case "o": if let current, let u = URL(string: current.url) { openURL(u) }
            default: return .ignored
            }
            return .handled
        }
    }

    /// Moves the selection to the next row before the current one leaves the list.
    private func advance(from p: ReviewPR, in urls: [String]) {
        guard selected == p.url, let i = urls.firstIndex(of: p.url) else { return }
        selected = urls[safe: i + 1] ?? urls[safe: i - 1]
    }

    @ViewBuilder
    private func sections(_ list: [ListSection]) -> some View {
        ForEach(list) { section in
            if let stack = section.stack {
                StackBlock(stack: stack, rows: section.rows)
            } else if let p = section.rows.first {
                row(p, stack: nil)
            }
        }
    }

    private func row(_ p: ReviewPR, stack: StackInfo?) -> some View {
        PRRow(pr: p, stack: stack, aside: model.isSkipped(p))
            .tag(p.url)
            .swipeActions(edge: .leading) {
                Button("Done", systemImage: "checkmark") { model.toggleDone(p) }.tint(.green)
            }
            .swipeActions(edge: .trailing) {
                Button(model.isSkipped(p) ? "Bring back" : "Set aside", systemImage: "clock") { model.toggleAside(p) }.tint(.orange)
            }
            .contextMenu { PRMenu(pr: p) }
    }

    /// A stack, bottom first. GitHub's own stacks list every layer, so the ones not asking you show as quiet lines.
    @ViewBuilder
    private func StackBlock(stack: StackInfo, rows: [ReviewPR]) -> some View {
        let byURL = Dictionary(rows.map { ($0.url, $0) }, uniquingKeysWith: { a, _ in a })
        let all = model.stacks
        Section {
            if let entries = stack.entries {
                ForEach(entries.sorted { $0.position < $1.position }, id: \.url) { e in
                    if let p = byURL[e.url] { row(p, stack: all[p.url]) } else { LayerLine(entry: e, size: stack.size) }
                }
            } else {
                ForEach(rows) { row($0, stack: all[$0.url]) }
            }
        } header: {
            Text(verbatim: "Stack of \(stack.size) · bottom first\(stack.base.map { $0.isEmpty ? "" : " · on \($0)" } ?? "")")
        }
    }
}

/// A layer of a stack that isn't in the list right now: one quiet line saying why.
struct LayerLine: View {
    @Environment(AppModel.self) private var model
    let entry: StackEntry
    let size: Int

    private var why: String {
        let live = model.prs.first { $0.url == entry.url }
        switch true {
        case entry.state == .merged: return "merged"
        case entry.state == .closed: return "closed"
        case live.map(model.isSkipped) == true: return "set aside"
        case live.map { model.doneEntry($0) != nil } == true: return "done"
        case live != nil: return "hidden by the filter"
        default:
            let words = ["APPROVED": "you approved", "CHANGES_REQUESTED": "you requested changes", "COMMENTED": "you commented", "DISMISSED": "your review was dismissed"]
            return entry.myReview.flatMap { words[$0] } ?? "not asking you"
        }
    }

    var body: some View {
        if let url = URL(string: entry.url) {
            Link(destination: url) {
                HStack {
                    Text(verbatim: "\(entry.position)/\(size)").monospacedDigit()
                    Text(verbatim: "#\(entry.number) \(entry.title)").lineLimit(1)
                    Spacer()
                    Text(why + (entry.isDraft ? " · draft" : ""))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }
}

struct PRMenu: View {
    @Environment(AppModel.self) private var model
    let pr: ReviewPR

    var body: some View {
        if let url = URL(string: pr.url) {
            Link(destination: url) { Label("Open on GitHub", systemImage: "safari") }
            ShareLink(item: url)
        }
        Button(model.doneEntry(pr) == nil ? "Mark done" : "Back to the queue", systemImage: "checkmark") { model.toggleDone(pr) }
        if model.doneEntry(pr) == nil {
            Button(model.isSkipped(pr) ? "Bring back" : "Set aside until it changes", systemImage: "clock") { model.toggleAside(pr) }
        }
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
