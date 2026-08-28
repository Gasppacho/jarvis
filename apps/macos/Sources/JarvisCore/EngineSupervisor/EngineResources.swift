import Foundation

/// The embedded engine payload: a bundled Node runtime and the engine bundle.
///
/// Paths are always derived from the app bundle or an explicit development
/// tree, never from the current working directory.
public struct EngineResources: Sendable {
    public let nodeExecutable: URL
    public let engineBundle: URL

    public init(nodeExecutable: URL, engineBundle: URL) {
        self.nodeExecutable = nodeExecutable
        self.engineBundle = engineBundle
    }

    /// Resources shipped in `Jarvis.app/Contents/Resources/engine`.
    public static func inAppBundle(_ bundle: Bundle = .main) -> EngineResources? {
        guard let root = bundle.resourceURL?.appending(path: "engine", directoryHint: .isDirectory)
        else { return nil }
        return EngineResources(
            nodeExecutable: root.appending(path: "node"),
            engineBundle: root.appending(path: "engine.bundle.mjs")
        )
    }

    /// Resources produced by `pnpm build:engine` in a development checkout.
    public static func inDevelopmentTree(repositoryRoot: URL) -> EngineResources {
        let root = repositoryRoot.appending(path: "dist/engine", directoryHint: .isDirectory)
        return EngineResources(
            nodeExecutable: root.appending(path: "node"),
            engineBundle: root.appending(path: "engine.bundle.mjs")
        )
    }

    public var isPresent: Bool {
        let fileManager = FileManager.default
        return fileManager.isExecutableFile(atPath: nodeExecutable.path(percentEncoded: false))
            && fileManager.fileExists(atPath: engineBundle.path(percentEncoded: false))
    }
}
