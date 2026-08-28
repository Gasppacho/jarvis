#!/usr/bin/env python3
"""Validate Jarvis documentation pack contracts and local links."""
from __future__ import annotations

from pathlib import Path
import json
import re
import sys
import urllib.parse

try:
    import yaml
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError as exc:
    raise SystemExit(
        "Install validation dependencies: python3 -m pip install -r scripts/requirements-docs.txt"
    ) from exc

ROOT = Path(__file__).resolve().parents[1]
ERRORS: list[str] = []


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def validate(instance, schema, label: str) -> None:
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    for error in sorted(validator.iter_errors(instance), key=lambda item: list(item.path)):
        ERRORS.append(f"{label}: {list(error.path)}: {error.message}")


def validate_schemas() -> None:
    for path in ROOT.glob("contracts/**/*.schema.json"):
        try:
            Draft202012Validator.check_schema(load_json(path))
        except Exception as exc:  # validator exposes multiple exception classes
            ERRORS.append(f"{path.relative_to(ROOT)}: invalid schema: {exc}")


def validate_events() -> None:
    envelope = load_json(ROOT / "contracts/schemas/event-envelope.v1.schema.json")
    for path in sorted((ROOT / "examples/events").glob("*.json")):
        event = load_json(path)
        validate(event, envelope, str(path.relative_to(ROOT)))
        payload_path = ROOT / "contracts/events" / f"{event['type']}.v{event['version']}.schema.json"
        if not payload_path.exists():
            ERRORS.append(f"{path.relative_to(ROOT)}: missing payload schema {payload_path.relative_to(ROOT)}")
            continue
        validate(event["payload"], load_json(payload_path), f"{path.relative_to(ROOT)} payload")


def validate_manifests_and_project() -> None:
    manifest_schema = load_json(ROOT / "contracts/schemas/module-manifest.v1.schema.json")
    manifests = {}
    for path in sorted((ROOT / "examples/modules").glob("*.yaml")):
        manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
        validate(manifest, manifest_schema, str(path.relative_to(ROOT)))
        manifests[manifest["metadata"]["id"]] = manifest
        descriptors = manifest["contracts"]["consumes"] + manifest["contracts"]["produces"]
        refs = [item["schemaRef"] for item in descriptors]
        if manifest.get("configuration"):
            refs.append(manifest["configuration"]["schemaRef"])
        for ref in refs:
            if not (ROOT / ref).exists():
                ERRORS.append(f"{path.relative_to(ROOT)}: missing schemaRef {ref}")

    project = yaml.safe_load((ROOT / "examples/project/.jarvis/project.yaml").read_text(encoding="utf-8"))
    validate(project, load_json(ROOT / "contracts/schemas/project-config.v1.schema.json"), "project example")
    bindings = yaml.safe_load((ROOT / "examples/project/local-bindings.yaml").read_text(encoding="utf-8"))
    validate(bindings, load_json(ROOT / "contracts/schemas/project-bindings.v1.schema.json"), "bindings example")

    for instance in project["modules"]:
        manifest = manifests.get(instance["moduleId"])
        if manifest is None:
            ERRORS.append(f"project example: unknown module {instance['moduleId']}")
            continue
        if manifest.get("configuration"):
            validate(
                instance.get("configuration", {}),
                load_json(ROOT / manifest["configuration"]["schemaRef"]),
                f"project module {instance['instanceId']} config",
            )


def validate_openapi() -> None:
    path = ROOT / "contracts/openapi/local-api.v1.yaml"
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not str(document.get("openapi", "")).startswith("3.1"):
        ERRORS.append("OpenAPI document is not version 3.1")
    if not document.get("paths") or not document.get("components"):
        ERRORS.append("OpenAPI document is missing paths or components")

    refs: list[str] = []

    def walk(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == "$ref" and isinstance(child, str):
                    refs.append(child)
                else:
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(document)
    for ref in refs:
        if not ref.startswith("#/"):
            continue
        current = document
        for part in ref[2:].split("/"):
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(current, dict) or part not in current:
                ERRORS.append(f"OpenAPI unresolved reference: {ref}")
                break
            current = current[part]


def validate_links() -> None:
    pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
    root = ROOT.resolve()
    for path in ROOT.rglob("*.md"):
        for raw in pattern.findall(path.read_text(encoding="utf-8")):
            target = raw.strip().split()[0]
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = urllib.parse.unquote(target).split("#")[0]
            if not target:
                continue
            resolved = (path.parent / target).resolve()
            try:
                resolved.relative_to(root)
            except ValueError:
                ERRORS.append(f"{path.relative_to(ROOT)}: link escapes pack: {raw}")
                continue
            if not resolved.exists():
                ERRORS.append(f"{path.relative_to(ROOT)}: missing local link: {raw}")


def validate_content_guards() -> None:
    forbidden = "".join(chr(code) for code in (104, 101, 114, 109, 101, 115))
    for path in ROOT.rglob("*"):
        if not path.is_file() or path == Path(__file__):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if forbidden in text.lower():
            ERRORS.append(f"{path.relative_to(ROOT)}: contains forbidden out-of-scope term")


def main() -> int:
    validate_schemas()
    validate_events()
    validate_manifests_and_project()
    validate_openapi()
    validate_links()
    validate_content_guards()
    if ERRORS:
        print("\n".join(ERRORS), file=sys.stderr)
        return 1
    print("Jarvis documentation pack validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
