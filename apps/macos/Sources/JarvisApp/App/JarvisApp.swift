import JarvisCore
import SwiftUI

@main
struct JarvisApp: App {
    @State private var session = EngineSessionModel(resources: resolveEngineResources())

    var body: some Scene {
        WindowGroup("Jarvis") {
            RootView(session: session)
                .frame(minWidth: 720, minHeight: 420)
                .task { await session.start() }
        }
        .windowResizability(.contentSize)
    }
}

/// Prefers the app bundle, but `Bundle.main.resourceURL` is non-nil even for a
/// bare SwiftPM executable, so selection must test for the files themselves.
private func resolveEngineResources() -> EngineResources {
    if let bundled = EngineResources.inAppBundle(), bundled.isPresent { return bundled }
    return EngineResources.inDevelopmentTree(repositoryRoot: developmentRepositoryRoot())
}

/// Development builds run from `.build/`, not from `Jarvis.app`.
private func developmentRepositoryRoot() -> URL {
    var url = URL(filePath: Bundle.main.bundlePath)
    while url.path != "/" {
        if FileManager.default.fileExists(atPath: url.appending(path: "pnpm-workspace.yaml").path) {
            return url
        }
        url.deleteLastPathComponent()
    }
    return URL(filePath: FileManager.default.currentDirectoryPath)
}
