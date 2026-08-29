// swift-tools-version: 6.0
import PackageDescription

// ADR 0013: SwiftPM compiles, `scripts/build-app.sh` assembles the bundle.
// `path:` keeps the layout MACOS_APP.md prescribes instead of SwiftPM's
// default `Sources/`.
let package = Package(
    name: "Jarvis",
    // MVP target: Apple Silicon, macOS 15+ (docs/product/MVP_SPEC.md).
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Jarvis", targets: ["JarvisApp"]),
        .library(name: "JarvisCore", targets: ["JarvisCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.10.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.8.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
    ],
    targets: [
        // Generated at build time from the OpenAPI contract, so no hand-written
        // DTO can drift from it.
        .target(
            name: "JarvisAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            path: "JarvisAPI",
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        // A library, not the executable: an executable target cannot be
        // imported by a test target.
        .target(name: "JarvisCore", dependencies: ["JarvisAPI"], path: "JarvisCore"),
        .executableTarget(name: "JarvisApp", dependencies: ["JarvisCore"], path: "JarvisApp"),
        .testTarget(name: "JarvisAppTests", dependencies: ["JarvisCore"], path: "JarvisAppTests"),
    ]
)
