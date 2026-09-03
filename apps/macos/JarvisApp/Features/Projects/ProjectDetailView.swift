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
    @State private var newSlotName = ""
    @State private var newSlotRequirement = ""

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
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    if let detail = state.detail {
                        repositorySection(detail)
                        if state.draft != nil {
                            portableConfigurationEditor(detail)
                            localBindingsEditor
                            compositionReview(proxy)
                            validationReport
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

            startingPointEditor
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

    private var startingPointEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Starting point").font(.headline)
            Text(
                "Choose a canonical draft or keep a Custom composition. You can edit every choice afterward."
            )
                .font(.callout)
                .foregroundStyle(.secondary)
            ForEach(presentation.startingPoints) { startingPoint in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(startingPoint.displayName).font(.body.weight(.semibold))
                        Text(startingPoint.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(startingPoint.action.label) {
                        perform(.edit(startingPoint.action))
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityHint(
                    "Creates an editable Portable Configuration Draft without Local Bindings.")
            }
        }
        .id("starting-point")
    }

    private var slotRequirementsEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Project slots").font(.headline)
            Text("Choose capability IDs declared by the loaded Module Catalog.")
                .font(.callout)
                .foregroundStyle(.secondary)
            ForEach(presentation.slots) { slotPresentation in
                let slot = slotPresentation.id
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top) {
                        TextField("Slot", text: slotNameBinding(slot))
                        capabilityControl(
                            selection: slotRequirementBinding(slot),
                            currentValue: slotPresentation.requirement)
                        Toggle("Optional", isOn: slotOptionalBinding(slot))
                        Button(role: .destructive) {
                            perform(.edit(.removeSlot(slot)))
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                    }
                    TextField("Description", text: slotDescriptionBinding(slot))
                    requesterList(slotPresentation.requesters)
                }
                .padding(10)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    TextField("New slot name", text: $newSlotName)
                    capabilityControl(
                        selection: $newSlotRequirement,
                        currentValue: newSlotRequirement)
                    Button("Add slot") {
                        let edit = ProjectDetailPresentation.Action.Edit.addSlot(
                            name: newSlotName, requirement: newSlotRequirement)
                        perform(.edit(edit))
                        newSlotName = ""
                        newSlotRequirement = ""
                    }
                    .disabled(
                        newSlotName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || newSlotRequirement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func capabilityControl(
        selection: Binding<String>, currentValue: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Picker("Required capability", selection: selection) {
                Text("Choose from Module Catalog").tag("")
                if !currentValue.isEmpty && !presentation.capabilityOptions.contains(currentValue) {
                    Text("Custom value — edit in Advanced").tag(currentValue)
                }
                ForEach(presentation.capabilityOptions, id: \.self) { capability in
                    Text(capability).tag(capability)
                }
            }
            if presentation.capabilityOptions.isEmpty {
                Text("No installed Module Package declares a required capability.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            DisclosureGroup("Advanced") {
                TextField("Custom capability ID", text: selection)
                    .textFieldStyle(.roundedBorder)
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    private func requesterList(_ requesters: [ProjectDetailPresentation.SlotRequester]) -> some View {
        if requesters.isEmpty {
            Text("Needed by: no Module Instance in the current Draft.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else {
            Text("Needed by").font(.caption.weight(.semibold))
            ForEach(requesters) { requester in
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(requester.instanceId) — \(requester.displayName)")
                        .font(.caption.weight(.medium))
                    Text(requester.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func moduleEditor(_ module: ProjectModuleDraft, projectSlots: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Color.clear.frame(height: 0).id("module-\(module.id)")
            if let card = presentation.moduleCards.first(where: { $0.id == module.id }) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(card.displayName).font(.headline)
                        Text(card.description).font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle("Enabled", isOn: moduleEnabledBinding(module.id))
                    Button(role: .destructive) {
                        perform(.edit(.removeModule(module.id)))
                    } label: {
                        Image(systemName: "trash")
                    }
                    .buttonStyle(.borderless)
                }
                Text(card.eventSummary).font(.caption)
                Text("Required capabilities: \(card.requiredCapabilities)").font(.caption)
                Text("Compatibility: \(card.compatibility)").font(.caption)
                if card.missingResources != "No missing resources" {
                    Label(
                        "Missing resources: \(card.missingResources)", systemImage: "exclamationmark.triangle"
                    )
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                DisclosureGroup("Advanced") {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker(
                            "Module Package", selection: modulePackageBinding(module.id, module.moduleId)
                        ) {
                            ForEach(moduleCatalog.packages) { package in
                                Text(package.displayName).tag(package.moduleId)
                            }
                        }
                        TextField("Unique Instance ID", text: moduleInstanceIDBinding(module.id))
                            .textFieldStyle(.roundedBorder)
                        Text(card.technicalDetails).font(.caption.monospaced())
                    }
                }
                .accessibilityHint("Shows technical IDs, package version, and contract details.")
            }

            Picker("Runtime slot", selection: moduleRuntimeSlotBinding(module.id)) {
                Text("None").tag("")
                ForEach(projectSlots, id: \.self) { Text($0).tag($0) }
            }

            bindingRows(module, options: ["main"] + projectSlots)
            configurationFields(module)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .id("module-instance-\(module.instanceId)")
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
        if module.automationRules != nil {
            automationRulesEditor(module)
        } else if !module.configurationFields.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Schema-backed configuration").font(.subheadline.weight(.semibold))
                if let explanation = module.configurationRepairExplanation {
                    Label(explanation, systemImage: "arrow.uturn.backward.circle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                ForEach(module.configurationFields) { field in
                    configurationControl(
                        field,
                        value: configurationBinding(module.id, field.key))
                }
            }
        }
    }

    private func configurationControl(
        _ field: ModuleConfigurationField,
        value: Binding<String>
    ) -> AnyView {
        let content: AnyView
        switch field.kind {
        case .boolean:
            content = AnyView(
                Toggle(
                    field.label,
                    isOn: Binding(
                        get: { value.wrappedValue == "true" },
                        set: { value.wrappedValue = $0 ? "true" : "false" })))
        case .choice(let choices):
            content = AnyView(
                Picker(field.label, selection: value) {
                    Text(field.required ? "Choose…" : "None").tag("")
                    ForEach(choices, id: \.self) { Text($0).tag($0) }
                })
        case .integer, .number, .string:
            content = AnyView(
                TextField(field.label + (field.required ? " *" : ""), text: value))
        case .array(let item):
            content = arrayConfigurationControl(field, item: item, value: value)
        case .object(let children):
            content = objectConfigurationControl(field, children: children, value: value)
        }
        return AnyView(
            VStack(alignment: .leading, spacing: 4) {
                content
                Text(field.required ? "Required" : "Optional")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                if let description = field.description {
                    Text(description).font(.caption).foregroundStyle(.secondary)
                }
                if let defaultValue = field.defaultValue {
                    Text("Default: \(defaultValue)").font(.caption).foregroundStyle(.secondary)
                }
                if field.minimum != nil || field.maximum != nil {
                    Text(
                        "Range: \(field.minimum?.formatted() ?? "unbounded") to \(field.maximum?.formatted() ?? "unbounded")"
                    ).font(.caption).foregroundStyle(.secondary)
                }
                if field.minimumLength != nil || field.maximumLength != nil {
                    Text(
                        "Length: \(field.minimumLength.map(String.init) ?? "unbounded") to \(field.maximumLength.map(String.init) ?? "unbounded")"
                    ).font(.caption).foregroundStyle(.secondary)
                }
                if !field.examples.isEmpty {
                    Text("Example: \(field.examples.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let issue = field.validationIssue(for: value.wrappedValue) {
                    Text(issue).font(.caption).foregroundStyle(.red)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(field.accessibilityLabel)
            .accessibilityHint(field.accessibilityHint))
    }

    private func arrayConfigurationControl(
        _ field: ModuleConfigurationField,
        item: ModuleConfigurationField,
        value: Binding<String>
    ) -> AnyView {
        guard let values = configurationArray(value.wrappedValue) else {
            return AnyView(configurationRepairControl(field, value: value))
        }
        return AnyView(
            VStack(alignment: .leading, spacing: 6) {
                Text(field.label).font(.body.weight(.medium))
                ForEach(values.indices, id: \.self) { index in
                    HStack(alignment: .firstTextBaseline) {
                        configurationControl(
                            item,
                            value: arrayItemBinding(parent: value, index: index, field: item))
                        Button(role: .destructive) {
                            var updated = configurationArray(value.wrappedValue) ?? []
                            guard updated.indices.contains(index) else { return }
                            updated.remove(at: index)
                            value.wrappedValue = configurationText(updated)
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                        .disabled(field.minimumItems.map { values.count <= $0 } ?? false)
                    }
                }
                Button("Add \(item.label)") {
                    var updated = configurationArray(value.wrappedValue) ?? []
                    updated.append(configurationSeed(for: item))
                    value.wrappedValue = configurationText(updated)
                }
                .disabled(field.maximumItems.map { values.count >= $0 } ?? false)
                if field.minimumItems != nil || field.maximumItems != nil {
                    Text(
                        "Values: \(field.minimumItems.map(String.init) ?? "unbounded") to \(field.maximumItems.map(String.init) ?? "unbounded")"
                    ).font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("Advanced raw JSON") {
                    TextEditor(text: value).font(.body.monospaced()).frame(minHeight: 54)
                }
            })
    }

    private func objectConfigurationControl(
        _ field: ModuleConfigurationField,
        children: [ModuleConfigurationField],
        value: Binding<String>
    ) -> AnyView {
        guard configurationObject(value.wrappedValue) != nil else {
            return AnyView(configurationRepairControl(field, value: value))
        }
        return AnyView(
            GroupBox(field.label) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(children) { child in
                        configurationControl(
                            child,
                            value: objectValueBinding(parent: value, field: child))
                    }
                    if children.isEmpty {
                        StructuredJSONObjectEditor(
                            title: "Custom properties",
                            text: value,
                            allowsScalarValuesOnly: false)
                    }
                    DisclosureGroup("Advanced raw JSON") {
                        TextEditor(text: value).font(.body.monospaced()).frame(minHeight: 54)
                    }
                }
            })
    }

    private func configurationRepairControl(
        _ field: ModuleConfigurationField,
        value: Binding<String>
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(
                "\(field.label) cannot be shown as structured controls. Repair its JSON in Advanced; your input is preserved.",
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.caption).foregroundStyle(.orange)
            DisclosureGroup("Advanced raw JSON") {
                TextEditor(text: value).font(.body.monospaced()).frame(minHeight: 54)
            }
        }
    }

    private func automationRulesEditor(_ module: ProjectModuleDraft) -> some View {
        let rows = presentation.automationRuleRows.filter { $0.moduleID == module.id }
        return VStack(alignment: .leading, spacing: 12) {
            Text("Automation Rules").font(.subheadline.weight(.semibold))
            ForEach(rows) { row in
                VStack(alignment: .leading, spacing: 8) {
                    Text(row.sentence).font(.body.weight(.medium))
                    AutomationEventSelector(
                        title: "Input Fact",
                        currentType: row.inputEventType,
                        choices: row.inputChoices,
                        hint: row.inputHint,
                        select: { choice in
                            perform(
                                .edit(
                                    .setAutomationRuleInput(
                                        row.moduleID, row.id, choice.type)))
                        },
                        custom: { value in
                            perform(
                                .edit(
                                    .setAutomationRuleInput(row.moduleID, row.id, value)))
                        })
                    StructuredJSONObjectEditor(
                        title: "Bounded match",
                        text: automationRuleMatchBinding(row),
                        allowsScalarValuesOnly: true)
                    AutomationEventSelector(
                        title: "Emitted Request",
                        currentType: row.emissionEventType,
                        choices: row.emissionChoices,
                        hint: row.emissionHint,
                        select: { choice in
                            perform(
                                .edit(
                                    .setAutomationRuleEmission(
                                        row.moduleID,
                                        row.id,
                                        choice.type,
                                        resolvedConsumerID: choice.selectedConsumerID)))
                        },
                        custom: { value in
                            perform(
                                .edit(
                                    .setAutomationRuleEmission(
                                        row.moduleID,
                                        row.id,
                                        value,
                                        resolvedConsumerID: nil)))
                        })
                    StructuredJSONObjectEditor(
                        title: "Request payload",
                        text: automationRulePayloadBinding(row),
                        allowsScalarValuesOnly: false)
                    if !row.targetChoices.isEmpty {
                        Picker("Resolved consumer", selection: automationRuleTargetBinding(row)) {
                            ForEach(row.targetChoices, id: \.self) { consumer in
                                Text(consumer).tag(consumer)
                            }
                        }
                    }
                    Text(row.routingExplanation).font(.caption).foregroundStyle(.secondary)
                    DisclosureGroup("Advanced Rule details") {
                        TextField("Rule ID", text: automationRuleIDBinding(row))
                        Text("Target: \(String(describing: row.target))")
                            .font(.caption.monospaced())
                    }
                    Button("Remove Automation Rule", role: .destructive) {
                        perform(.edit(.removeAutomationRule(row.moduleID, row.id)))
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(row.sentence)
                .accessibilityHint(row.routingExplanation)
                .padding(10)
                .background(.background, in: RoundedRectangle(cornerRadius: 8))
            }
            Button("Add Automation Rule") {
                perform(.edit(.addAutomationRule(module.id)))
            }
        }
        .id("automation-rules")
    }

    private var localBindingsEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Local Bindings").sectionLabel()
            Text(
                "Portable Configuration declares what is needed. Resource choices update only this Mac's Local Bindings."
            )
                .font(.callout)
                .foregroundStyle(.secondary)
            ForEach(presentation.resourceBindings) { resource in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(resource.id).font(.headline)
                        Text(resource.statusLabel)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }
                    Text("Requires: \(resource.requiredCapabilities.joined(separator: ", "))")
                        .font(.caption)
                    requesterList(resource.requesters)
                    if resource.status != .bound {
                        Label("Consequence: \(resource.impact)", systemImage: "exclamationmark.triangle")
                            .font(.callout)
                            .foregroundStyle(.orange)
                        Text("Next action: \(resource.repairAction)")
                            .font(.callout.weight(.medium))
                    }
                    if resource.candidates.isEmpty {
                        Label(resource.emptyCandidateExplanation, systemImage: "questionmark.circle")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Eligible resource", selection: localBindingSelection(resource.id)) {
                            Text("Unbound").tag("")
                            ForEach(resource.candidates) { candidate in
                                Text("\(candidate.displayName) · \(candidate.kind.rawValue)")
                                    .tag(candidate.id)
                            }
                        }
                    }
                    Text("Writes Local Bindings only. Portable Configuration is untouched.")
                        .font(.caption.weight(.medium))
                }
                .padding(12)
                .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(resource.accessibilityLabel)
                .accessibilityHint(resource.accessibilityHint)
                .id("resource-\(resource.id)")
            }
            if presentation.resourceBindings.isEmpty {
                Text("This Portable Configuration declares no project resource Slots.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button("Reload Project Resources") {
                Task {
                    await projectConfiguration.refresh(
                        projectId: project.id, packages: moduleCatalog.packages)
                }
            }
        }
    }

    private func compositionReview(_ proxy: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Review").sectionLabel()
            Label(
                presentation.isReadyForValidation
                    ? "Ready to validate — the saved Draft and Local Bindings passed Engine review."
                    : "Draft save is available separately. Ready to validate remains false while Engine findings exist or edits are unsaved.",
                systemImage: presentation.isReadyForValidation
                    ? "checkmark.seal.fill" : "exclamationmark.triangle.fill"
            )
            .foregroundStyle(presentation.isReadyForValidation ? .green : .orange)
            .accessibilityLabel(
                presentation.isReadyForValidation ? "Ready to validate" : "Not ready to validate")

            ForEach(ProjectDetailPresentation.ReviewRow.Category.allCases, id: \.rawValue) { category in
                let rows = presentation.reviewRows.filter { $0.category == category }
                if !rows.isEmpty {
                    Text(category.rawValue).font(.headline)
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(row.title).font(.body.weight(.medium))
                                Spacer()
                                Text(row.status.rawValue).font(.caption.weight(.semibold))
                            }
                            Text(row.detail).font(.caption).foregroundStyle(.secondary)
                            if let repair = row.repairAction,
                                let target = row.navigationTarget
                            {
                                Button("Repair: \(repair)") {
                                    withAnimation { proxy.scrollTo(target, anchor: .center) }
                                }
                                .buttonStyle(.link)
                            }
                        }
                        .padding(8)
                        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel(row.accessibilityLabel)
                        .accessibilityHint(row.accessibilityHint)
                    }
                }
            }
        }
        .id("composition-review")
    }

    private var validationReport: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Validation Report").sectionLabel()
            Label(
                presentation.validation.title,
                systemImage: validationStatusIcon)
                .foregroundStyle(validationStatusColor)

            Label(
                presentation.validation.activationReadinessExplanation,
                systemImage: presentation.validation.isReadyToActivate
                    ? "bolt.circle.fill" : "bolt.slash.circle")
                .font(.callout)
                .foregroundStyle(
                    presentation.validation.isReadyToActivate ? .green : .secondary)
                .accessibilityLabel(
                    presentation.validation.isReadyToActivate
                        ? "Ready to activate" : "Not ready to activate")
                .accessibilityHint(
                    presentation.validation.activationReadinessExplanation)

            if presentation.validation.status == .validating {
                ProgressView("Checking saved Project composition…")
            }

            if let message = presentation.validation.errorMessage {
                Label(message, systemImage: "network.slash")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            ForEach(presentation.validation.findings) { finding in
                VStack(alignment: .leading, spacing: 4) {
                    Text(finding.code).font(.body.monospaced())
                    Text(finding.reference)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                    Text(finding.unavailable).font(.callout.weight(.semibold))
                    Text(finding.impact).font(.callout)
                    Text(finding.correctiveAction).font(.callout)
                    Text("Engine detail: \(finding.diagnostic)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(finding.accessibilityLabel)
            }

            ForEach(presentation.validation.requestRoutes) { route in
                VStack(alignment: .leading, spacing: 3) {
                    Text(route.contractIdentity).font(.body.monospaced())
                    Text(route.route).font(.caption).foregroundStyle(.secondary)
                }
            }
            ForEach(presentation.validation.satisfiedCapabilities) { capability in
                VStack(alignment: .leading, spacing: 3) {
                    Text(capability.capability).font(.body.monospaced())
                    Text(capability.detail).font(.caption).foregroundStyle(.secondary)
                }
            }

            let validate = ProjectDetailPresentation.Action.Asynchronous.validate
            Button(
                presentation.validation.status == .failed ? "Retry validation" : validate.label
            ) {
                perform(.asynchronous(validate))
            }
            .disabled(
                !presentation.isReadyForValidation
                    || presentation.validation.status == .validating)
        }
        .id("validation-report")
    }

    private var validationStatusIcon: String {
        switch presentation.validation.status {
        case .valid: "checkmark.seal.fill"
        case .invalid: "exclamationmark.triangle.fill"
        case .failed: "network.slash"
        case .stale: "clock.arrow.circlepath"
        case .unvalidated, .validating: "checkmark.seal"
        }
    }

    private var validationStatusColor: Color {
        switch presentation.validation.status {
        case .valid: .green
        case .invalid: .red
        case .failed: .orange
        case .stale: .orange
        case .unvalidated, .validating: .secondary
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
            Button("Save Draft locally") { perform(.asynchronous(saveLocal)) }
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
                guard
                    let binding = presentation.repositories.first(where: {
                    $0.repositoryId == repositoryId
                    })
                else { return }
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

    private func automationRuleIDBinding(
        _ row: ProjectDetailPresentation.AutomationRuleRow
    ) -> Binding<String> {
        Binding(
            get: { row.ruleID },
            set: { perform(.edit(.setAutomationRuleID(row.moduleID, row.id, $0))) })
    }

    private func automationRulePayloadBinding(
        _ row: ProjectDetailPresentation.AutomationRuleRow
    ) -> Binding<String> {
        Binding(
            get: { row.payloadJSON },
            set: { perform(.edit(.setAutomationRulePayload(row.moduleID, row.id, $0))) })
    }

    private func automationRuleTargetBinding(
        _ row: ProjectDetailPresentation.AutomationRuleRow
    ) -> Binding<String> {
        Binding(
            get: {
                if case .moduleInstance(let id) = row.target { return id }
                return ""
            },
            set: { perform(.edit(.setAutomationRuleTarget(row.moduleID, row.id, $0))) })
    }

    private func automationRuleMatchBinding(
        _ row: ProjectDetailPresentation.AutomationRuleRow
    ) -> Binding<String> {
        Binding(
            get: { row.matchJSON },
            set: { perform(.edit(.setAutomationRuleMatch(row.moduleID, row.id, $0))) })
    }

    private func configurationArray(_ text: String) -> [Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [Any]
    }

    private func configurationObject(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func configurationText(_ value: Any) -> String {
        if let string = value as? String { return string }
        if let boolean = value as? Bool { return boolean ? "true" : "false" }
        if let number = value as? NSNumber { return number.stringValue }
        guard JSONSerialization.isValidJSONObject(value),
            let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func configurationSeed(for field: ModuleConfigurationField) -> Any {
        guard !field.initialValue.isEmpty else { return "" }
        return (try? field.decode(field.initialValue)) ?? field.initialValue
    }

    private func arrayItemBinding(
        parent: Binding<String>,
        index: Int,
        field: ModuleConfigurationField
    ) -> Binding<String> {
        Binding(
            get: {
                let values = configurationArray(parent.wrappedValue) ?? []
                guard values.indices.contains(index) else { return "" }
                return configurationText(values[index])
            },
            set: { text in
                var values = configurationArray(parent.wrappedValue) ?? []
                guard values.indices.contains(index) else { return }
                values[index] = (try? field.decode(text)) ?? text
                parent.wrappedValue = configurationText(values)
            })
    }

    private func objectValueBinding(
        parent: Binding<String>,
        field: ModuleConfigurationField
    ) -> Binding<String> {
        Binding(
            get: {
                let object = configurationObject(parent.wrappedValue) ?? [:]
                return object[field.key].map(configurationText) ?? field.initialValue
            },
            set: { text in
                var object = configurationObject(parent.wrappedValue) ?? [:]
                if text.isEmpty && !field.required {
                    object.removeValue(forKey: field.key)
                } else {
                    object[field.key] = (try? field.decode(text)) ?? text
                }
                parent.wrappedValue = configurationText(object)
            })
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
                await projectConfiguration.refreshAfterRepositoryBindingChange(
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

@MainActor
private struct AutomationEventSelector: View {
    let title: String
    let currentType: String
    let choices: [ProjectDetailPresentation.AutomationEventOption]
    let hint: String
    let select: (ProjectDetailPresentation.AutomationEventOption) -> Void
    let custom: (String) -> Void

    @State private var search = ""

    private var filteredChoices: [ProjectDetailPresentation.AutomationEventOption] {
        guard !search.isEmpty else { return choices }
        return choices.filter {
            $0.label.localizedCaseInsensitiveContains(search)
                || $0.type.localizedCaseInsensitiveContains(search)
                || $0.detail.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            TextField("Search \(title)", text: $search)
                .textFieldStyle(.roundedBorder)
            Menu("\(title): \(selectedLabel)") {
                ForEach(filteredChoices) { choice in
                    Button("\(choice.label) — \(choice.detail)") { select(choice) }
                }
            }
            Text(hint).font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Advanced custom value") {
                TextField(
                    "Custom Event type",
                    text: Binding(get: { currentType }, set: { custom($0) })
                )
                    .textFieldStyle(.roundedBorder)
                if !choices.contains(where: { $0.type == currentType }) {
                    Label(
                        "Unknown Event blocks readiness until contract validation succeeds.",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(title), \(selectedLabel)")
        .accessibilityHint(hint)
    }

    private var selectedLabel: String {
        choices.first { $0.type == currentType }?.label ?? "Unknown: \(currentType)"
    }
}

@MainActor
private struct StructuredJSONObjectEditor: View {
    let title: String
    @Binding var text: String
    let allowsScalarValuesOnly: Bool

    @State private var newKey = ""
    @State private var newValue = ""

    private var object: [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.body.weight(.medium))
            if let object {
                ForEach(object.keys.sorted(), id: \.self) { key in
                    HStack {
                        Text(key).frame(minWidth: 100, alignment: .leading)
                        TextField("JSON value", text: valueBinding(key))
                        Button(role: .destructive) {
                            update { $0.removeValue(forKey: key) }
                        } label: {
                            Image(systemName: "minus.circle")
                        }
                        .buttonStyle(.borderless)
                    }
                }
                HStack {
                    TextField("New property", text: $newKey)
                    TextField("JSON value", text: $newValue)
                    Button("Add") {
                        let key = newKey
                        update { $0[key] = decodedValue(newValue) }
                        newKey = ""
                        newValue = ""
                    }
                    .disabled(newKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                Label(
                    "This object is invalid. Repair it in Advanced; your input is preserved.",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption).foregroundStyle(.orange)
            }
            DisclosureGroup("Advanced raw JSON") {
                TextEditor(text: $text).font(.body.monospaced()).frame(minHeight: 54)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }

    private func valueBinding(_ key: String) -> Binding<String> {
        Binding(
            get: { object?[key].map(encodedValue) ?? "" },
            set: { replacement in update { $0[key] = decodedValue(replacement) } })
    }

    private func decodedValue(_ value: String) -> Any {
        guard let data = value.data(using: .utf8),
            let decoded = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
            !allowsScalarValuesOnly || decoded is String || decoded is NSNumber || decoded is NSNull
        else { return value }
        return decoded
    }

    private func encodedValue(_ value: Any) -> String {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        else { return String(describing: value) }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func update(_ change: (inout [String: Any]) -> Void) {
        guard var object else { return }
        change(&object)
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        else { return }
        text = String(data: data, encoding: .utf8) ?? text
    }
}

extension View {
    fileprivate func sectionLabel() -> some View {
        font(.callout.weight(.semibold)).foregroundStyle(.secondary)
    }
}
