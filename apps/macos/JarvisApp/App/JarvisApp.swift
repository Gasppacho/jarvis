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

    override init() {
        session = EngineSessionModel.bundled()
        projects = ProjectsModel(session: session)
        projectConfiguration = ProjectConfigurationModel(session: session, projects: projects)
        moduleCatalog = ModuleCatalogModel(session: session)
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
                moduleCatalog: delegate.moduleCatalog)
                .frame(minWidth: 520, minHeight: 320)
                .task { await delegate.session.start() }
        }
    }
}
