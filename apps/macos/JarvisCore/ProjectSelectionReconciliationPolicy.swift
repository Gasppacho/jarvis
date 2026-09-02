/// Reconciles a transient sidebar Project selection with the latest registry list.
/// RootView continues to own navigation state; this policy only decides whether
/// the selected Project still exists after a model update.
public struct ProjectSelectionReconciliationPolicy: Sendable {
    public init() {}

    public func reconciledProjectID(
        selectedProjectID: String?,
        availableProjectIDs: [String]
    ) -> String? {
        guard let selectedProjectID else { return nil }
        return availableProjectIDs.contains(selectedProjectID) ? selectedProjectID : nil
    }
}
