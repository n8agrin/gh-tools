import SwiftUI

/// Where the GitHub token goes. The app only reads from GitHub, so a token that can read is enough.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""

    private let newToken = URL(string: "https://github.com/settings/tokens/new?scopes=repo,read:org&description=gh-review%20iOS")!

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("ghp_…", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("GitHub token")
                } footer: {
                    Text("A classic token with repo and read:org, so private repos and team requests show up. It stays in the Keychain on this device. The app never writes to GitHub.")
                }
                Section {
                    Link("Make a token on GitHub", destination: newToken)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.token = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                        dismiss()
                        Task { await model.refresh() }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { draft = model.token }
        }
    }
}
