import JarvisCore
import SwiftUI

/// Active Project operations, with configuration delegated to the three-step wizard.
public struct ProjectDetailView: View {
    /// Three user journeys; technical tools stay available from Diagnostics.
    private enum Tab: Hashable {
        case configuration
        case overview
        case graph
        case timeline
        case execution
        case deadLetters
    }

    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let overview: ProjectOverviewModel
    let timeline: ProjectTimelineModel
    let executionDetail: ProjectExecutionDetailModel
    let projectGraph: ProjectGraphModel
    let deadLetters: ProjectDeadLettersModel
    let connections: ConnectionsModel
    let project: Project

    // Execution selection and navigation are reset when changing project.
    @State private var selectedTab: Tab = .overview
    @State private var selectedExecutionID: String?
    @State private var executionOrigin: Tab = .overview

    public init(
        projects: ProjectsModel,
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        overview: ProjectOverviewModel,
        timeline: ProjectTimelineModel,
        executionDetail: ProjectExecutionDetailModel,
        projectGraph: ProjectGraphModel,
        deadLetters: ProjectDeadLettersModel,
        connections: ConnectionsModel,
        project: Project
    ) {
        self.projects = projects
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.overview = overview
        self.timeline = timeline
        self.executionDetail = executionDetail
        self.projectGraph = projectGraph
        self.deadLetters = deadLetters
        self.connections = connections
        self.project = project
    }

    public var body: some View {
        VStack(spacing: 0) {
            if selectedTab != .configuration,
               let repositoryPath = projectConfiguration.state(for: project.id).detail?.bindings.first?.path {
                Label(
                    "Dépôt local · \(URL(fileURLWithPath: repositoryPath).lastPathComponent)",
                    systemImage: "externaldrive.connected.to.line.below")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 24)
                    .padding(.top, 10)
            }
            switch selectedTab {
            case .configuration:
                ProjectOnboardingView(
                    projects: projects,
                    projectConfiguration: projectConfiguration,
                    moduleCatalog: moduleCatalog,
                    connections: connections,
                    project: project)
                    .id(project.id)
            case .overview:
                ProjectOverviewView(
                    model: overview,
                    projects: projects,
                    executionDetail: executionDetail,
                    projectId: project.id,
                    onOpenExecution: { openExecution($0) },
                    onOpenComposition: { selectedTab = .configuration })
            case .graph:
                Button("Retour à la supervision") { selectedTab = .overview }
                    .padding(.bottom, 8)
                ProjectGraphView(model: projectGraph, projectId: project.id)
            case .timeline:
                // Timeline's own project-scoped state means switching to a
                // different Project can never show this Project's rows for
                // that other one, including while it is still loading
                // (ProjectTimelineModel keys state by projectId).
                ProjectTimelineView(timeline: timeline, projectId: project.id) { id in
                    openExecution(id)
                }
            case .execution:
                if let selectedExecutionID {
                    ProjectExecutionDetailView(
                        model: executionDetail,
                        timeline: timeline,
                        projectId: project.id,
                        executionId: selectedExecutionID,
                        backLabel: executionOrigin == .overview ? "Retour à la supervision" : "Retour à l’historique",
                        close: { selectedTab = executionOrigin })
                } else {
                    Text("Choisissez un travail à suivre").font(.title2.bold()).padding()
                    ProjectTimelineView(timeline: timeline, projectId: project.id) { id in
                        executionOrigin = .timeline
                        selectedExecutionID = id
                    }
                }
            case .deadLetters:
                Button("Retour à la supervision") { selectedTab = .overview }
                    .padding(.bottom, 8)
                ProjectDeadLettersView(model: deadLetters, projectId: project.id)
            }
        }
        .navigationTitle(project.name)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Parcours du projet", selection: Binding<Tab>(
                    get: {
                        switch selectedTab {
                        case .graph, .deadLetters: .overview
                        case .timeline: .execution
                        default: selectedTab
                        }
                    },
                    set: { destination in
                        if destination == .execution, selectedExecutionID == nil,
                           let snapshot = overview.state(for: project.id).overview,
                           let id = ProjectOverviewPresentation.focusedIssue(snapshot)?.executionId {
                            selectedExecutionID = id
                            executionOrigin = .overview
                        }
                        selectedTab = destination
                    }
                )) {
                    Text("Configurer").tag(Tab.configuration)
                    Text("Superviser").tag(Tab.overview)
                    Text("Suivre").tag(Tab.execution)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("project.journeys")
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("Schéma des événements") { selectedTab = .graph }
                    Button("Historique des événements") { selectedTab = .timeline }
                    Button("Livraisons en échec") { selectedTab = .deadLetters }
                } label: {
                    Label("Diagnostics", systemImage: "ellipsis.circle")
                }
                .accessibilityIdentifier("project.diagnostics")
            }
        }
        .task(id: refreshID) {
            await connections.refresh()
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
        .onChange(of: project.id) { _, _ in
            selectedExecutionID = nil
            selectedTab = .overview
            executionOrigin = .overview
        }
    }

    private func openExecution(_ executionID: String) {
        executionOrigin = selectedTab == .execution ? executionOrigin : selectedTab
        selectedExecutionID = executionID
        selectedTab = .execution
    }

    private var refreshID: String {
        ([project.id] + moduleCatalog.packages.map(\.id)).joined(separator: "|")
    }
}
