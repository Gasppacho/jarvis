-- Project-scoped Local Binding slots are independently replaceable from the
-- portable configuration. Existing imports remain valid unresolved drafts.
ALTER TABLE project_bindings
ADD COLUMN slot_bindings TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(slot_bindings) AND json_type(slot_bindings) = 'object');
