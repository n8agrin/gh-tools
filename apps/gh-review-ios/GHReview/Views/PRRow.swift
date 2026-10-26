import SwiftUI

/// One PR in the list: who, what, how big, CI, and how long it's waited.
struct PRRow: View {
    let pr: ReviewPR
    var stack: StackInfo?
    var aside = false
    var done: DoneEntry?

    var body: some View {
        let subject = splitTitle(pr.title).subject
        let status = flags(pr, done: done)
        HStack(alignment: .top, spacing: 10) {
            Avatar(login: pr.author, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(subject).font(.body.weight(.medium)).lineLimit(2)
                    if let stack { Tag(text: "\(stack.index + 1)/\(stack.size)") }
                    if pr.isDraft { Tag(text: "draft") }
                }
                Text(verbatim: "\(pr.repo.split(separator: "/").last ?? "")#\(pr.number) · @\(pr.author)")
                    .font(.caption).foregroundStyle(.secondary)
                if !status.isEmpty {
                    Text(status.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 3) {
                Text(age(done?.doneAt ?? pr.requestedAt)).font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 4) {
                    Text(verbatim: "+\(pr.additions)").foregroundStyle(.green)
                    Text(verbatim: "−\(pr.deletions)").foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit())
                CIDot(ci: pr.ci)
            }
        }
        .opacity(aside ? 0.55 : 1)
        .padding(.vertical, 2)
    }
}

struct Avatar: View {
    let login: String
    let size: CGFloat

    var body: some View {
        AsyncImage(url: URL(string: "https://github.com/\(login).png?size=\(Int(size * 3))")) { image in
            image.resizable()
        } placeholder: {
            Color.secondary.opacity(0.2)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

struct Tag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.monospaced())
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(.secondary.opacity(0.15), in: Capsule())
    }
}

struct CIDot: View {
    let ci: CIState?

    var body: some View {
        let (color, word): (Color, String) = switch ci {
        case .success: (.green, "pass")
        case .failure: (.red, "fail")
        case .pending: (.yellow, "run")
        case nil: (.secondary, "—")
        }
        HStack(spacing: 3) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(word)
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .accessibilityLabel("CI \(word)")
    }
}
