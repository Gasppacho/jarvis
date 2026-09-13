import AppKit
import JarvisCore
import SwiftUI

/// Owns the shutdown protocol for every way the app can be asked to quit.
///
/// A `CommandGroup` Quit button only covers the menu item: a Quit AppleEvent,
/// a logout or a Dock quit bypass it and would leave the engine running.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let session: EngineSessionModel
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let timeline: ProjectTimelineModel
    let overview: ProjectOverviewModel
    let executionDetail: ProjectExecutionDetailModel
    let projectGraph: ProjectGraphModel
    let deadLetters: ProjectDeadLettersModel
    let connections: ConnectionsModel

    override init() {
        let dataRoot: URL?
        let startupError: EngineStartError?
        switch EngineSessionModel.requestedDataRoot(arguments: CommandLine.arguments) {
        case .success(let root): dataRoot = root; startupError = nil
        case .failure(let error): dataRoot = nil; startupError = error
        }
        session = EngineSessionModel.bundled(dataRoot: dataRoot, startupError: startupError)
        projects = ProjectsModel(session: session, repositoryGrants: dataRoot.map {
            RepositoryGrantStore(storageDirectory: $0.appendingPathComponent("repository-grants"))
        } ?? RepositoryGrantStore(), preferenceNamespace: dataRoot.map {
            "isolated:\($0.resolvingSymlinksInPath().path()):"
        } ?? "")
        projectConfiguration = ProjectConfigurationModel(session: session, projects: projects)
        moduleCatalog = ModuleCatalogModel(session: session)
        timeline = ProjectTimelineModel(session: session)
        overview = ProjectOverviewModel(session: session)
        executionDetail = ProjectExecutionDetailModel(session: session)
        projectGraph = ProjectGraphModel(session: session)
        deadLetters = ProjectDeadLettersModel(session: session)
        connections = ConnectionsModel(session: session)
        super.init()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // SYSTEM.md: ask the engine to stop, then let AppKit finish quitting.
        Task {
            await session.shutdown()
            projects.releaseRepositoryAccess()
            NSApplication.shared.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct JarvisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        // `Window`, not `WindowGroup`: the latter adds File ▸ New Window, and
        // every window would run the `.task` that starts the engine.
        Window("Jarvis", id: "main") {
            ContentView(
                session: delegate.session,
                projects: delegate.projects,
                projectConfiguration: delegate.projectConfiguration,
                moduleCatalog: delegate.moduleCatalog,
                timeline: delegate.timeline,
                overview: delegate.overview,
                projectGraph: delegate.projectGraph,
                executionDetail: delegate.executionDetail,
                deadLetters: delegate.deadLetters,
                connections: delegate.connections)
                .frame(minWidth: 520, minHeight: 320)
                .task { await delegate.session.start() }
        }
    }
}
