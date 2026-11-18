# SPDX-FileCopyrightText: 2026 Chaoqi Liu
#
# SPDX-License-Identifier: Apache-2.0

"""Stable identities for local policy checkpoints served during evaluation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

_REQUIRED_SIDECARS = ("config.json", "policy_io.json", "norm_stats.pt")
_SAFETENSORS_FILE = "model.safetensors"
_SAFETENSORS_INDEX = "model.safetensors.index.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _weight_files(root: Path) -> tuple[str, ...]:
    index_path = root / _SAFETENSORS_INDEX
    if not index_path.exists():
        if not (root / _SAFETENSORS_FILE).is_file():
            raise FileNotFoundError(
                f"Checkpoint {root} has neither {_SAFETENSORS_FILE} nor "
                f"{_SAFETENSORS_INDEX}."
            )
        return (_SAFETENSORS_FILE,)

    try:
        payload = json.loads(index_path.read_text(encoding="utf-8"))
        weight_map = payload["weight_map"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError(f"Invalid safetensors index: {index_path}.") from exc
    if not isinstance(weight_map, dict) or not weight_map:
        raise ValueError(f"Safetensors index has no weight_map: {index_path}.")
    shard_names = set(weight_map.values())
    if not all(isinstance(name, str) and name for name in shard_names):
        raise ValueError(f"Safetensors index has invalid shard names: {index_path}.")
    for name in shard_names:
        candidate = Path(name)
        if candidate.is_absolute() or candidate.parts != (name,):
            raise ValueError(
                f"Safetensors shard must be a root-level filename, got {name!r}."
            )
    return (_SAFETENSORS_INDEX, *sorted(shard_names))


def build_checkpoint_identity(checkpoint_path: str | Path) -> dict[str, Any]:
    """Hash every required serving artifact under a local pretrained_model dir."""
    root = Path(checkpoint_path).expanduser().resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Policy checkpoint directory not found: {root}.")

    filenames = (*_REQUIRED_SIDECARS, *_weight_files(root))
    files: dict[str, dict[str, int | str]] = {}
    for filename in filenames:
        path = root / filename
        if not path.is_file() or path.stat().st_size <= 0:
            raise FileNotFoundError(
                f"Policy checkpoint artifact is missing or empty: {path}."
            )
        files[filename] = {
            "size_bytes": path.stat().st_size,
            "sha256": _sha256(path),
        }

    canonical = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {
        "schema_version": 1,
        "path": str(root),
        "artifact_sha256": hashlib.sha256(canonical).hexdigest(),
        "files": files,
    }


def _resolve_dependency_path(*, policy_root: Path, dependency_path: str) -> Path:
    candidate = Path(dependency_path).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    if candidate.exists():
        return candidate.resolve()
    for parent in (policy_root, *policy_root.parents):
        if (parent / ".git").exists():
            return (parent / candidate).resolve()
    return (policy_root / candidate).resolve()


def _json_mapping(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Invalid JSON metadata: {path}.") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"JSON metadata must be an object: {path}.")
    return payload


def build_policy_serving_identity(checkpoint_path: str | Path) -> dict[str, Any]:
    """Hash a policy checkpoint together with its external codec dependency."""
    checkpoint = build_checkpoint_identity(checkpoint_path)
    config_path = Path(checkpoint["path"]) / "config.json"
    config = _json_mapping(config_path)

    dependencies: dict[str, dict[str, Any]] = {}
    action_tokenizer = config.get("action_tokenizer")
    if action_tokenizer is not None:
        if not isinstance(action_tokenizer, dict):
            raise ValueError("Policy action_tokenizer config must be a mapping.")
        pretrained_path = action_tokenizer.get("pretrained_path")
        if not isinstance(pretrained_path, str) or not pretrained_path:
            raise ValueError(
                "Policy action_tokenizer config must contain pretrained_path for "
                "auditable serving."
            )
        dependency_root = _resolve_dependency_path(
            policy_root=Path(checkpoint["path"]),
            dependency_path=pretrained_path,
        )
        dependencies["action_tokenizer"] = build_checkpoint_identity(dependency_root)

    aggregate = {
        "checkpoint_artifact_sha256": checkpoint["artifact_sha256"],
        "dependencies": {
            name: identity["artifact_sha256"]
            for name, identity in sorted(dependencies.items())
        },
    }
    canonical = json.dumps(aggregate, sort_keys=True, separators=(",", ":")).encode()
    return {
        "schema_version": 1,
        "artifact_sha256": hashlib.sha256(canonical).hexdigest(),
        "checkpoint": checkpoint,
        "dependencies": dependencies,
    }
