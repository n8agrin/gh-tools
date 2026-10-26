import SwiftUI

@main
struct GHReviewApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

enum Mode: String, CaseIterable {
    case queue = "Queue", done = "Done"
}

/// The list on the left (or alone on iPhone), the PR page on the right.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var mode = Mode.queue
    @State private var selected: String?
    @State private var settings = false
    @Environment(\.scenePhase) private var phase

    var body: some View {
        NavigationSplitView {
            Group {
                switch mode {
                case .queue: QueueView(selected: $selected)
                case .done: DoneView(selected: $selected)
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Picker("View", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { m in
                            Text(verbatim: "\(m.rawValue) \(m == .queue ? model.waiting : model.doneRows.count)")
                        }
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Settings", systemImage: "gearshape") { settings = true }
                }
            }
        } detail: {
            if let url = selected {
                PRDetailView(url: url).id(url)
            } else {
                ContentUnavailableView("Pick a PR", systemImage: "arrow.triangle.pull")
            }
        }
        .sheet(isPresented: $settings) { SettingsView() }
        .task {
            if model.token.isEmpty { settings = true } else { await model.refresh() }
        }
        .onChange(of: phase) { _, now in
            if now == .active, !model.loading { Task { await model.refresh() } }
        }
        // v and esc work the same as on the web page when a keyboard is attached.
        .onKeyPress("v") {
            mode = mode == .queue ? .done : .queue
            return .handled
        }
    }
}
