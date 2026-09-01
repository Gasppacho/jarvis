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
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .disabled(state.isSaving)
        }
        .task(id: refreshID) {
            await projectConfiguration.refresh(
                projectId: project.id, packages: moduleCatalog.packages)
        }
    }

    private var refreshID: String {
        ([project.id] + moduleCatalog.packages.map(\.id)).joined(separator: "|")
    }

    private var state: ProjectConfigurationState {
        projectConfiguration.state(for: project.id)
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
        }
    }

    private func repositorySection(_ detail: ProjectDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Repository").sectionLabel()
            ForEach(detail.bindings) { binding in
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 4) {
                    row(binding.repositoryId, binding.path)
                    row("Access", binding.accessible ? "reachable" : "not reachable")
                }
                .font(.callout)
                if !binding.accessible || projects.repositoryGrantMessages[project.id] != nil {
                    Button("Choose repository…") { chooseRepository(for: binding) }
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
            TextField("Project name", text: draftBinding(\.name, default: ""))
                .textFieldStyle(.roundedBorder)

            slotRequirementsEditor

            HStack {
                Text("Module Instances").font(.headline)
                Spacer()
                Menu("Add Module Instance") {
                    ForEach(moduleCatalog.packages) { package in
                        Button(package.displayName) {
                            projectConfiguration.addModule(projectId: project.id, package: package)
                        }
                    }
                }
            }

            ForEach(state.draft?.modules ?? []) { module in
                moduleEditor(
                    module,
                    projectSlots: state.draft?.slotRequirements.keys.sorted() ?? [])
            }
        }
    }

    private var slotRequirementsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Project slots").font(.headline)
            ForEach((state.draft?.slotRequirements.keys.sorted() ?? []), id: \.self) { slot in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        TextField("Slot", text: slotNameBinding(slot))
                        TextField("Required capability", text: slotRequirementBinding(slot))
                        Toggle("Optional", isOn: slotOptionalBinding(slot))
                        Button(role: .destructive) {
                            projectConfiguration.removeSlot(projectId: project.id, slotId: slot)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                    TextField("Description", text: slotDescriptionBinding(slot))
                }
            }
            Button("Add slot") {
                projectConfiguration.addSlot(projectId: project.id)
            }
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
                Toggle("Enabled", isOn: moduleBinding(module.id, \.enabled, default: false))
                Button(role: .destructive) {
                    projectConfiguration.removeModule(projectId: project.id, moduleId: module.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }
            TextField(
                "Unique Instance ID",
                text: moduleBinding(module.id, \.instanceId, default: "")
            )
            .textFieldStyle(.roundedBorder)

            Picker("Runtime slot", selection: moduleBinding(module.id, \.runtimeSlot, default: ""))
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
                        editModule(module.id) { $0.bindings[key] = nil }
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
            Button("Add module binding") {
                editModule(module.id) { draft in
                    var index = draft.bindings.count + 1
                    var key = "binding\(index)"
                    while draft.bindings[key] != nil {
                        index += 1
                        key = "binding\(index)"
                    }
                    draft.bindings[key] = options.first ?? "main"
                }
            }
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
                                    setConfiguration(module.id, field.key, value ? "true" : "false")
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
                    case .integer, .string:
                        TextField(
                            field.label + (field.required ? " *" : ""),
                            text: configurationBinding(module.id, field.key))
                    }
                }
            }
        }
    }

    private var localBindingsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Local Bindings").sectionLabel()
            ForEach(state.draft?.slotRequirements.keys.sorted() ?? [], id: \.self) { slot in
                let requirement = state.draft?.slotRequirements[slot]?.requires ?? ""
                let candidates = state.candidates.filter { $0.capabilities.contains(requirement) }
                Picker(slot, selection: localBindingSelection(slot)) {
                    Text("Unbound").tag("")
                    ForEach(candidates) { candidate in
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

    private var saveActions: some View {
        HStack {
            Button("Save locally") {
                Task {
                    await projectConfiguration.saveDraft(
                        projectId: project.id, writeToRepository: false)
                }
            }
            .keyboardShortcut("s", modifiers: [.command])
            Button("Save and write .jarvis/project.yaml") {
                Task {
                    await projectConfiguration.saveDraft(
                        projectId: project.id, writeToRepository: true)
                }
            }
            .disabled(state.isSaving)
        }
    }

    private func editModule(_ id: UUID, _ edit: (inout ProjectModuleDraft) -> Void) {
        projectConfiguration.editDraft(projectId: project.id) { draft in
            guard let index = draft.modules.firstIndex(where: { $0.id == id }) else { return }
            edit(&draft.modules[index])
        }
    }

    private func draftBinding<Value>(
        _ keyPath: WritableKeyPath<ProjectConfigurationDraft, Value>, default fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: { state.draft?[keyPath: keyPath] ?? fallback },
            set: { value in
                projectConfiguration.editDraft(projectId: project.id) {
                    $0[keyPath: keyPath] = value
                }
            })
    }

    private func moduleBinding<Value>(
        _ id: UUID,
        _ keyPath: WritableKeyPath<ProjectModuleDraft, Value>,
        default fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: {
                state.draft?.modules.first(where: { $0.id == id })?[keyPath: keyPath] ?? fallback
            },
            set: { value in editModule(id) { $0[keyPath: keyPath] = value } })
    }

    private func modulePackageBinding(_ id: UUID, _ fallback: String) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.moduleId ?? fallback },
            set: { moduleId in
                guard let package = moduleCatalog.packages.first(where: { $0.moduleId == moduleId })
                else { return }
                projectConfiguration.editDraft(projectId: project.id) {
                    $0.select(package: package, for: id)
                }
            })
    }

    private func configurationBinding(_ id: UUID, _ key: String) -> Binding<String> {
        Binding(
            get: {
                state.draft?.modules.first(where: { $0.id == id })?.configurationValues[key] ?? ""
            },
            set: { setConfiguration(id, key, $0) })
    }

    private func setConfiguration(_ id: UUID, _ key: String, _ value: String) {
        editModule(id) { $0.configurationValues[key] = value }
    }

    private func moduleBindingValue(_ id: UUID, _ key: String) -> Binding<String> {
        Binding(
            get: { state.draft?.modules.first(where: { $0.id == id })?.bindings[key] ?? "" },
            set: { value in editModule(id) { $0.bindings[key] = value } })
    }

    private func moduleBindingName(_ id: UUID, _ oldKey: String) -> Binding<String> {
        Binding(
            get: { oldKey },
            set: { newKey in
                guard !newKey.isEmpty, newKey != oldKey else { return }
                editModule(id) { module in
                    let value = module.bindings.removeValue(forKey: oldKey)
                    module.bindings[newKey] = value
                }
            })
    }

    private func slotRequirementBinding(_ slot: String) -> Binding<String> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.requires ?? "" },
            set: { value in
                projectConfiguration.editDraft(projectId: project.id) {
                    $0.slotRequirements[slot]?.requires = value
                }
            })
    }

    private func slotOptionalBinding(_ slot: String) -> Binding<Bool> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.optional ?? false },
            set: { value in
                projectConfiguration.editDraft(projectId: project.id) {
                    $0.slotRequirements[slot]?.optional = value
                }
            })
    }

    private func slotDescriptionBinding(_ slot: String) -> Binding<String> {
        Binding(
            get: { state.draft?.slotRequirements[slot]?.description ?? "" },
            set: { value in
                projectConfiguration.editDraft(projectId: project.id) {
                    $0.slotRequirements[slot]?.description = value.isEmpty ? nil : value
                }
            })
    }

    private func slotNameBinding(_ oldName: String) -> Binding<String> {
        Binding(
            get: { oldName },
            set: { newName in
                guard !newName.isEmpty, newName != oldName else { return }
                projectConfiguration.renameSlot(
                    projectId: project.id, from: oldName, to: newName)
            })
    }

    private func localBindingSelection(_ slot: String) -> Binding<String> {
        Binding(
            get: {
                guard let binding = state.localBindings?.slots.first(where: { $0.slotId == slot })
                else { return "" }
                return "\(binding.kind.rawValue)/\(binding.ref)"
            },
            set: { selection in
                let candidate = state.candidates.first { $0.id == selection }
                Task {
                    await projectConfiguration.setLocalBinding(
                        projectId: project.id, slotId: slot, candidate: candidate)
                }
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
