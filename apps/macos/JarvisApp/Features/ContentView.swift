import JarvisCore
import SwiftUI

/// The whole user-visible surface: the engine's state, and — ready — the
/// project sidebar. A failed or starting engine keeps the 01B health screen,
/// so a degraded engine (ticket 02) is explained, never blank.
struct ContentView: View {
    let session: EngineSessionModel
    let projects: ProjectsModel

    var body: some View {
        switch session.state {
        case .starting, .failed:
            EngineHealthView(session: session)

        case .ready:
            RootView(projects: projects)
        }
    }
}
