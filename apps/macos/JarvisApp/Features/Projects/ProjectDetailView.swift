import AppKit
import JarvisCore
import SwiftUI

/// Project composition editor. All repeated controls are driven by the module
/// catalogue, configuration schemas, Project slots and eligible candidate arrays.
public struct ProjectDetailView: View {
    let projects: ProjectsModel
    let projectConfiguration: ProjectConfigurationModel
    let moduleCatalog: ModuleCatalogModel
    let project: Project

    @State private var isDeleteConfirmationPresented = false

    public init(
        projects: ProjectsModel,
        projectConfiguration: ProjectConfigurationModel,
        moduleCatalog: ModuleCatalogModel,
        project: Project
    ) {
        self.projects = projects
        self.projectConfiguration = projectConfiguration
        self.moduleCatalog = moduleCatalog
        self.project = project
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if let detail = state.detail {
                    repositorySection(detail)
                    if state.draft != nil {
                        portableConfigurationEditor(detail)
                        localBindingsEditor
                        saveActions
                    } else {
                        Label(
                            "Complete the imported draft before configuring Module Instances.",
                            systemImage: "info.circle"
                        )
                        .foregroundStyle(.secondary)
                    }
                } else if state.isLoading {
                    ProgressView("Loading Project Configuration…")
                }
                if let message = state.errorMessage {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
                if let message = projects.deletionMessages[project.id] {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
                deleteAction
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .disabled(state.isSaving || isDeleting)
        }
        .task(id: refreshID) {
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
        .alert(
            presentation.deletionConfirmation.title,
            isPresented: $isDeleteConfirmationPresented
        ) {
            Button(presentation.deletionConfirmation.cancelAction.label, role: .cancel) {
                perform(.noOp(presentation.deletionConfirmation.cancelAction))
            }
            Button(presentation.deletionConfirmation.confirmAction.label, role: .destructive) {
                perform(.asynchronous(presentation.deletionConfirmation.confirmAction))
            }
        } message: {
            Text(presentation.deletionConfirmation.message)
        }
    }

    private var refreshID: String {
        ([project.id] + moduleCatalog.packages.map(\.id)).joined(separator: "|")
    }

    private var state: ProjectConfigurationState {
        projectConfiguration.state(for: project.id)
    }

    private var presentation: ProjectDetailPresentation {
        ProjectDetailPresentation(
            project: project,
            detail: state.detail,
            state: state,
            packages: moduleCatalog.packages,
            isDeleting: isDeleting)
    }

    private var isDeleting: Bool {
        projects.isDeletionInProgress(projectId: project.id)
    }

    private var addModuleActions: [ProjectDetailPresentation.Action.Edit] {
        presentation.actions.compactMap { action in
            guard case .edit(let edit) = action,
                case .addModule = edit.operation
            else { return nil }
            return edit
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(project.name).font(.title2.bold())
            Text(project.status.rawValue)
                .font(.callout.weight(.medium))
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())
            Spacer()
            if state.isSaving { ProgressView().controlSize(.small) }
            if isDeleting {
                ProgressView("Deleting Project…")
                    .controlSize(.small)
            }
        }
    }

    private func repositorySection(_ detail: ProjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Repository").sectionLabel()
            ForEach(presentation.repositories) { binding in
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    row(binding.repositoryId, binding.path)
                    row("Access", binding.accessible ? "reachable" : "not reachable")
                }
                .font(.callout)
                if !binding.accessible || projects.repositoryGrantMessages[project.id] != nil {
                    let picker = ProjectDetailPresentation.Action.RepositoryPicker
                        .chooseRepository(binding.repositoryId)
                    Button(picker.label) { perform(.repositoryPicker(picker)) }
                }
            }
            if let message = projects.repositoryGrantMessages[project.id] {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func portableConfigurationEditor(_ detail: ProjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Portable Configuration").sectionLabel()
            TextField("Project name", text: projectNameBinding)
                .textFieldStyle(.roundedBorder)

            slotRequirementsEditor

            HStack {
                Text("Module Instances").font(.headline)
                Spacer()
                Menu("Add Module Instance") {
                    ForEach(addModuleActions, id: \.self) { edit in
                        if case .addModule(let packageId) = edit.operation,
                            let package = moduleCatalog.packages.first(where: {
                                $0.moduleId == packageId
                            })
                        {
                            Button(package.displayName) { perform(.edit(edit)) }
                        }
                    }
                }
            }

            ForEach(presentation.modules) { module in
                moduleEditor(
                    module,
                    projectSlots: state.draft?.slotRequirements.keys.sorted() ?? [])
            }
        }
    }

    private var slotRequirementsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Project slots").font(.headline)
            ForEach(presentation.slots) { slotPresentation in
                let slot = slotPresentation.id
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        TextField("Slot", text: slotNameBinding(slot))
                        TextField("Required capability", text: slotRequirementBinding(slot))
                        Toggle("Optional", isOn: slotOptionalBinding(slot))
                        Button(role: .destructive) {
                            perform(.edit(.removeSlot(slot)))
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                    TextField("Description", text: slotDescriptionBinding(slot))
                }
            }
            let edit = ProjectDetailPresentation.Action.Edit.addSlot
            Button(edit.label) { perform(.edit(edit)) }
        }
    }

    private func moduleEditor(_ module: ProjectModuleDraft, projectSlots: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Picker(
                    "Module Package", selection: modulePackageBinding(module.id, module.moduleId)
                ) {
                    ForEach(moduleCatalog.packages) { package in
                        Text(package.displayName).tag(package.moduleId)
                    }
                }
                Toggle("Enabled", isOn: moduleEnabledBinding(module.id))
                Button(role: .destructive) {
                    perform(.edit(.removeModule(module.id)))
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }
            TextField(
                "Unique Instance ID",
                text: moduleInstanceIDBinding(module.id)
            )
            .textFieldStyle(.roundedBorder)

            Picker("Runtime slot", selection: moduleRuntimeSlotBinding(module.id))
            {
                Text("None").tag("")
                ForEach(projectSlots, id: \.self) { Text($0).tag($0) }
            }

            bindingRows(module, options: ["main"] + projectSlots)
            configurationFields(module)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private func bindingRows(_ module: ProjectModuleDraft, options: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Module bindings").font(.subheadline.weight(.semibold))
            ForEach(module.bindings.keys.sorted(), id: \.self) { key in
                HStack {
                    TextField("Binding name", text: moduleBindingName(module.id, key))
                    Picker("Target", selection: moduleBindingValue(module.id, key)) {
                        ForEach(options, id: \.self) { Text($0).tag($0) }
                    }
                    Button(role: .destructive) {
                        perform(.edit(.removeModuleBinding(module.id, key)))
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
            let edit = ProjectDetailPresentation.Action.Edit.addModuleBinding(module.id)
            Button(edit.label) { perform(.edit(edit), bindingOptions: options) }
        }
    }

    @ViewBuilder
    private func configurationFields(_ module: ProjectModuleDraft) -> some View {
        if !module.configurationFields.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Schema-backed configuration").font(.subheadline.weight(.semibold))
                ForEach(module.configurationFields) { field in
                    switch field.kind {
                    case .boolean:
                        Toggle(
                            field.label,
                            isOn: Binding(
                                get: { module.configurationValues[field.key] == "true" },
                                set: { value in
                                    perform(
                                        .edit(
                                            .setModuleConfiguration(
                                                module.id, field.key, value ? "true" : "false")))
                                }))
                    case .choice(let choices):
                        Picker(
                            field.label,
                            selection: configurationBinding(module.id, field.key)
                        ) {
                            if !field.required { Text("None").tag("") }
                            ForEach(choices, id: \.self) { Text($0).tag($0) }
                        }
                    case .json:
                        LabeledContent(field.label) {
                            TextEditor(text: configurationBinding(module.id, field.key))
                                .font(.body.monospaced())
                                .frame(minHeight: 54)
                                .overlay(RoundedRectangle(cornerRadius: 5).stroke(.separator))
                        }
                    case .integer, .number, .string:
                        TextField(
                            field.label + (field.required ? " *" : ""),
                            text: configurationBinding(module.id, field.key))
                    }
                    if let description = field.description {
                        Text(description).font(.caption).foregroundStyle(.secondary)
                    }
                    if let issue = field.validationIssue(
                        for: module.configurationValues[field.key, default: ""])
                    {
                        Text(issue).font(.caption).foregroundStyle(.red)
                    }
                }
            }
        }
    }

    private var localBindingsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Local Bindings").sectionLabel()
            ForEach(presentation.slots) { slotPresentation in
                let slot = slotPresentation.id
                Picker(slot, selection: localBindingSelection(slot)) {
                    Text("Unbound").tag("")
                    ForEach(slotPresentation.candidates) { candidate in
                        Text("\(candidate.displayName) · \(candidate.kind.rawValue)")
                            .tag(candidate.id)
                    }
                }
            }
            if state.candidates.isEmpty {
                Text(
                    "No connection, runtime or MCP candidate is explicitly granted to this Project."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var deleteAction: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            let confirmation = ProjectDetailPresentation.Action.Confirmation.deleteProject
            Button(confirmation.label, role: .destructive) {
                perform(.confirmation(confirmation))
            }
            .disabled(!presentation.deletionConfirmation.isEnabled)
            if project.status == .active {
                Text("Pause this Project before deleting it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var saveActions: some View {
        HStack {
            let saveLocal = ProjectDetailPresentation.Action.Asynchronous.saveLocal
            Button(saveLocal.label) { perform(.asynchronous(saveLocal)) }
            .keyboardShortcut("s", modifiers: [.command])
            let saveRepository = ProjectDetailPresentation.Action.Asynchronous.saveRepository
            Button(saveRepository.label) { perform(.asynchronous(saveRepository)) }
        }
        .disabled(!presentation.isSaveEnabled)
    }

    private func perform(
        _ action: ProjectDetailPresentation.Action,
        bindingOptions: [String] = []
    ) {
        switch action {
        case .repositoryPicker(let picker):
            switch picker.operation {
            case .chooseRepository(let repositoryId):
                guard let binding = presentation.repositories.first(where: {
                    $0.repositoryId == repositoryId
                }) else { return }
                chooseRepository(for: binding)
            }
        case .confirmation:
            isDeleteConfirmationPresented = true
        case .asynchronous(let asynchronous):
            Task {
                await projectConfiguration.perform(asynchronous, projectId: project.id)
            }
        case .edit(let edit):
            projectConfiguration.apply(
                edit,
                projectId: project.id,
                packages: moduleCatalog.packages,
                bindingOptions: bindingOptions)
        case .noOp:
            return
        }
    }

    private var projectNameBinding: Binding<String> {
        Binding(
            get: { state.draft?.name ?? "" },
            set: { perform(.edit(.setProjectName($0))) })
    }

    private func moduleInstanceIDBinding(_ id: UUID) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.instanceId ?? "" },
            set: { perform(.edit(.setModuleInstanceID(id, $0))) })
    }

    private func moduleEnabledBinding(_ id: UUID) -> Binding<Bool> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.enabled ?? false },
            set: { perform(.edit(.setModuleEnabled(id, $0))) })
    }

    private func moduleRuntimeSlotBinding(_ id: UUID) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.runtimeSlot ?? "" },
            set: { perform(.edit(.setModuleRuntimeSlot(id, $0))) })
    }

    private func modulePackageBinding(_ id: UUID, _ fallback: String) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.moduleId ?? fallback },
            set: { perform(.edit(.setModulePackage(id, $0))) })
    }

    private func configurationBinding(_ id: UUID, _ key: String) -> Binding<String> {
        Binding(
            get: {
                state.draft?.modules.first(where: { $0.id == id })?.configurationValues[key] ?? ""
            },
            set: { perform(.edit(.setModuleConfiguration(id, key, $0))) })
    }

    private func moduleBindingValue(_ id: UUID, _ key: String) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.bindings[key] ?? "" },
            set: { perform(.edit(.setModuleBinding(id, key, $0))) })
    }

    private func moduleBindingName(_ id: UUID, _ oldKey: String) -> Binding<String> {
        Binding(
            get: { oldKey },
            set: { perform(.edit(.renameModuleBinding(id, oldKey, $0))) })
    }

    private func slotRequirementBinding(_ slot: String) -> Binding<String> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.requires ?? "" },
            set: { perform(.edit(.setSlotRequirement(slot, $0))) })
    }

    private func slotOptionalBinding(_ slot: String) -> Binding<Bool> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.optional ?? false },
            set: { perform(.edit(.setSlotOptional(slot, $0))) })
    }

    private func slotDescriptionBinding(_ slot: String) -> Binding<String> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.description ?? "" },
            set: { perform(.edit(.setSlotDescription(slot, $0))) })
    }

    private func slotNameBinding(_ oldName: String) -> Binding<String> {
        Binding(
            get: { oldName },
            set: { perform(.edit(.renameSlot(oldName, $0))) })
    }

    private func localBindingSelection(_ slot: String) -> Binding<String> {
        Binding(
            get: {
                guard let binding = state.localBindings?.slots.first(where: { $0.slotId == slot })
                else { return "" }
                return "\(binding.kind.rawValue)/\(binding.ref)"
            },
            set: { selection in
                perform(
                    .asynchronous(
                        .setLocalBinding(slot, selection.isEmpty ? nil : selection)))
            })
    }

    private func chooseRepository(for binding: ProjectBinding) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Restore Access"
        panel.message = "Choose the repository for \(project.name)."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            if await projects.reauthorize(
                projectId: project.id,
                repositoryId: binding.repositoryId,
                replacing: binding.bookmarkRef,
                with: url
            ) {
                await projectConfiguration.refresh(
                    projectId: project.id, packages: moduleCatalog.packages)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
        }
    }
}

extension View {
    fileprivate func sectionLabel() -> some View {
        font(.callout.weight(.semibold)).foregroundStyle(.secondary)
    }
}
