// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Jarvis",
    // MVP target: Apple Silicon, macOS 15+ (docs/product/MVP_SPEC.md).
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "Jarvis", targets: ["JarvisApp"]),
        .library(name: "JarvisCore", targets: ["JarvisCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
    ],
    targets: [
        // The Local API client is generated from the OpenAPI contract at build
        // time, so no hand-written DTO can drift from it.
        .target(
            name: "JarvisAPI",
            dependencies: [
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(name: "JarvisCore", dependencies: ["JarvisAPI"]),
        .executableTarget(name: "JarvisApp", dependencies: ["JarvisCore"]),
        .testTarget(name: "JarvisCoreTests", dependencies: ["JarvisCore"]),
    ]
)
