import Foundation

/// Where the embedded engine lives. MACOS_APP.md: paths derive from the bundle,
/// never from the current working directory, and never from PATH.
public struct EngineResources: Sendable {
    public let nodeExecutable: URL
    public let bundle: URL

    public init(nodeExecutable: URL, bundle: URL) {
        self.nodeExecutable = nodeExecutable
        self.bundle = bundle
    }

    /// `Jarvis.app/Contents/Resources/engine/`, assembled by scripts/build-app.sh.
    public static func bundled(in bundle: Bundle = .main) -> EngineResources? {
        guard let resources = bundle.resourceURL else { return nil }
        let candidate = inDirectory(resources.appending(path: "engine"))
        // For a plain SwiftPM executable `resourceURL` is just the binary's
        // directory, so the URL always exists; only the file does not. Without
        // this check `swift run Jarvis` reports a missing engine instead of
        // falling back to dist/engine.
        let bundlePath = candidate.bundle.path(percentEncoded: false)
        guard FileManager.default.fileExists(atPath: bundlePath) else { return nil }
        return candidate
    }

    /// `dist/engine/`, produced by `pnpm build:engine`. Used by the test seam,
    /// which drives the same layout the app ships.
    public static func developmentBuild(file: StaticString = #filePath) -> EngineResources {
        let root = repositoryRoot(from: URL(filePath: String(describing: file)))
        return inDirectory(root.appending(path: "dist/engine"))
    }

    /// Walks up to the directory holding `pnpm-workspace.yaml`. Counting path
    /// components instead is silently wrong the moment the file moves — and was.
    private static func repositoryRoot(from file: URL) -> URL {
        var directory = file.deletingLastPathComponent()
        while directory.path(percentEncoded: false) != "/" {
            let marker = directory.appending(path: "pnpm-workspace.yaml")
            if FileManager.default.fileExists(atPath: marker.path(percentEncoded: false)) {
                return directory
            }
            directory = directory.deletingLastPathComponent()
        }
        return file.deletingLastPathComponent()
    }

    private static func inDirectory(_ directory: URL) -> EngineResources {
        EngineResources(
            nodeExecutable: directory.appending(path: "node"),
            bundle: directory.appending(path: "engine.bundle.mjs")
        )
    }
}
