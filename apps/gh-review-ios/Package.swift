// swift-tools-version: 6.0
// Builds the app's GitHub and queue code as a library so `swift test` can run without Xcode.
// The app itself is GHReview.xcodeproj, which compiles the same files.
import PackageDescription

let package = Package(
    name: "GHReviewCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "GHReviewCore", targets: ["GHReviewCore"])],
    targets: [
        .target(name: "GHReviewCore", path: "GHReview/Core"),
        .testTarget(name: "GHReviewCoreTests", dependencies: ["GHReviewCore"], resources: [.copy("fixture.json")]),
    ]
)
