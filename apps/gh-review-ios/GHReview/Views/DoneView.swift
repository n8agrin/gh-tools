import SwiftUI

/// PRs you approved, asked changes on, or marked done, newest first.
struct DoneView: View {
    @Environment(AppModel.self) private var model
    @Binding var selected: String?

    var body: some View {
        @Bindable var model = model
        let rows = model.doneRows
        List(selection: $selected) {
            ForEach(rows, id: \.pr.url) { row in
                PRRow(pr: row.pr, done: row.entry)
                    .tag(row.pr.url)
                    .swipeActions(edge: .trailing) {
                        if row.entry.reason == "marked" {
                            Button("Back to the queue", systemImage: "arrow.uturn.backward") { model.toggleDone(row.pr) }.tint(.blue)
                        }
                    }
                    .contextMenu { PRMenu(pr: row.pr) }
            }
        }
        .listStyle(.plain)
        .overlay {
            if rows.isEmpty {
                ContentUnavailableView(
                    "Nothing done yet", systemImage: "tray",
                    description: Text("PRs you approve or request changes on land here. Swipe right on a PR to mark one done by hand."))
            }
        }
        .navigationTitle("\(rows.count) done")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $model.filter)
        .refreshable { await model.refresh() }
    }
}
