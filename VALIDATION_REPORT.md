# Validation Report

**Generated:** 2026-08-28  
**Pack status:** Ready for repository bootstrap

## Inventory before checksum manifest

- 115 files
- 89 Markdown documents
- 18 JSON files
- 6 YAML files
- approximately 7,700 lines

## Checks performed

- [x] Every JSON Schema is valid Draft 2020-12 according to `jsonschema`.
- [x] Every event example validates against Event Envelope v1.
- [x] Every event payload validates against its `(type, version)` schema.
- [x] Every example Module Manifest validates against Module Manifest v1.
- [x] Every manifest `schemaRef` resolves to an existing file.
- [x] The example Portable Project Configuration validates.
- [x] The example Local Bindings validate.
- [x] Each example Module Instance configuration validates against its module schema.
- [x] The OpenAPI 3.1 YAML parses and every internal `$ref` resolves.
- [x] Every local Markdown link resolves inside the pack.
- [x] The explicitly excluded product dependency is absent from the pack.

## Re-run locally

```bash
python3 -m pip install -r scripts/requirements-docs.txt
python3 scripts/validate-pack.py
```

## Implementation CI still required

The repository bootstrap must add a production contract pipeline using the chosen Node toolchain. It should additionally run a full OpenAPI linter, regenerate Swift/TypeScript clients, verify generated diffs are clean and enforce backward-compatibility against the latest release tag.
