import JarvisCore
import SwiftUI

/// The main window: a native sidebar, as described in docs/product/UX.md.
struct RootView: View {
    let session: EngineSessionModel

    private enum Section: String, CaseIterable, Identifiable {
        case projects = "Projects"
        case engine = "Engine"

        var id: String { rawValue }

        var symbol: String {
            switch self {
            case .projects: return "shippingbox"
            case .engine: return "bolt.horizontal"
            }
        }
    }

    @State private var selection: Section = .projects

    var body: some View {
        NavigationSplitView {
            List(Section.allCases, selection: $selection) { section in
                Label(section.rawValue, systemImage: section.symbol).tag(section)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
        } detail: {
            switch selection {
            case .projects:
                ProjectsView(session: session)
            case .engine:
                EngineHealthView(session: session)
            }
        }
    }
}
