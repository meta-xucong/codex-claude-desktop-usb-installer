"""Remove current-package table collisions before the existing TOML merger.

Uses the parser shipped in the pinned Python runtime to locate statements;
table-like text inside multiline values must never be treated as a header.
No configuration or credentials are printed.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
import sys
import tomllib
from tomllib import _parser as parser


def source_ranges(text: str, root_keys=None):
    """Locate actual table boundaries and managed comments in validated TOML."""
    out = parser.Output(parser.NestedDict(), parser.Flags())
    pos, start, header = 0, 0, ()
    spans = []
    markers = []
    while pos < len(text):
        pos = parser.skip_chars(text, pos, parser.TOML_WS)
        if pos == len(text):
            break
        char = text[pos]
        if char == "\n":
            pos += 1
            continue
        if char == "[":
            spans.append((start, pos, header))
            start = pos
            out.flags.finalize_pending()
            if text.startswith("[[", pos):
                pos, header = parser.create_list_rule(text, pos, out)
            else:
                pos, header = parser.create_dict_rule(text, pos, out)
        elif char in parser.KEY_INITIAL_CHARS:
            statement_start = pos
            pos = parser.key_value_rule(text, pos, out, header, float)
            if root_keys is not None and not header:
                _, key = parser.parse_key(text, statement_start)
                root_keys.append((statement_start, pos, key))
        pos = parser.skip_chars(text, pos, parser.TOML_WS)
        comment_start = pos
        pos = parser.skip_comment(text, pos)
        if text[comment_start:pos] in (
            "# BEGIN CODEX-STARTER-KIT MANAGED CONFIG v1",
            "# END CODEX-STARTER-KIT MANAGED CONFIG v1",
        ):
            markers.append((comment_start, pos))
        # The public parser validated every statement above, including its EOL.
        pos += 1
    spans.append((start, len(text), header))
    return spans, markers


def without_replaced_tables(existing: str, fragment: str) -> str:
    current = tomllib.loads(existing)
    generated = tomllib.loads(fragment)
    owned = {kind: set(generated.get(kind, {})) for kind in ("mcp_servers", "plugins")}
    skill_paths = {os.path.normcase(item["path"]) for item in generated.get("skills", {}).get("config", [])}
    skill_rows = iter(current.get("skills", {}).get("config", []))
    text = existing.replace("\r\n", "\n")
    spans, removed = source_ranges(text)
    for a, b, header in spans:
        replace = len(header) >= 2 and header[0] in owned and header[1] in owned[header[0]]
        if header == ("skills", "config"):
            replace = os.path.normcase(next(skill_rows).get("path", "")) in skill_paths
        if replace:
            removed.append((a, b))
    # Merge overlapping marker/table ranges, preserving all other source text.
    result, end = [], 0
    for a, b in sorted(removed):
        if a > end:
            result.append(text[end:a])
        end = max(end, b)
    result.append(text[end:])
    kept = "".join(result)
    tomllib.loads(kept + "\n" + fragment)
    return kept


MODEL_BEGIN = "# BEGIN CODEX-STARTER-KIT MODEL POLICY v1"
MODEL_END = "# END CODEX-STARTER-KIT MODEL POLICY v1"
FLAT_POLICY = re.compile(re.escape(MODEL_BEGIN) + r' (model = "[^"\n]+") ' + re.escape(MODEL_END))


class UnmatchedModelBackup(ValueError):
    pass


def recover_model_sync(existing: str, backups: Path) -> str:
    match = FLAT_POLICY.search(existing)
    if not match:
        return existing
    start = existing.rfind("\n", 0, match.start()) + 1
    stop = existing.find("\n", match.end())
    stop = len(existing) if stop < 0 else stop
    damaged = existing[start:stop]
    prefix = existing[start:match.start()]
    # The old PowerShell writer concatenated a single prefix line with two
    # arrays. Replay that exact operation before using a model-sync backup.
    if not prefix or not existing[match.end():stop].strip():
        return existing
    live = existing[:start] + prefix + existing[stop:]
    try:
        prefix_values = tomllib.loads(prefix)
        live_values = tomllib.loads(live)
    except tomllib.TOMLDecodeError:
        return existing  # Marker text inside a TOML value.
    if not prefix_values or any(live_values.get(k) != v for k, v in prefix_values.items()):
        return existing
    if live_values != tomllib.loads(existing):
        return existing
    recovered = set()
    for path in backups.glob("config.toml.model-sync.*.bak"):
        original = path.read_text(encoding="utf-8-sig")
        stripped = re.sub(r"(?ms)^" + re.escape(MODEL_BEGIN) + r"\n.*?^" + re.escape(MODEL_END) + r"\n?", "", original)
        lines = stripped.split("\n")
        if len(lines) < 2 or lines[0] != prefix:
            continue
        if lines[1].lstrip().startswith("["):
            suffix = lines[1:]
        elif re.fullmatch(r"""\s*model\s*=\s*(?:"[^"]+"|'[^']+')\s*(?:#.*)?""", lines[1]):
            suffix = lines[2:]
        else:
            continue
        if (prefix + match[0] + " ".join(suffix)).rstrip() == damaged:
            recovered.add("\n".join([prefix, MODEL_BEGIN, match[1], MODEL_END, *suffix]).rstrip() + "\n")
    if len(recovered) != 1:
        raise UnmatchedModelBackup
    restored = recovered.pop()
    if not (existing[:start] + existing[stop:]).strip():
        return restored

    # A later repair can have appended new settings. Keep those values and
    # recover only the root keys and tables that are still hidden on this line.
    roots = []
    tables, _ = source_ranges(restored, roots)

    def missing(path):
        value = live_values
        for part in path:
            if not isinstance(value, dict):
                return False
            if part not in value:
                return True
            value = value[part]
        return False

    root_text = "".join(restored[a:b] + "\n" for a, b, key in roots if missing(key))
    table_text = "\n".join(restored[a:b] for a, b, key in tables if key and missing(key))
    return root_text + live.rstrip() + "\n" + table_text


def media_registration(config: Path, wrapper: Path) -> str:
    try:
        value = tomllib.loads(config.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return "config-unreadable"
    servers = value.get("mcp_servers")
    media = servers.get("media_generation") if isinstance(servers, dict) else None
    if not isinstance(media, dict):
        return "entry-missing"
    if media.get("enabled", True) is not True:
        return "entry-disabled"
    args = media.get("args")
    if isinstance(args, list) and isinstance(media.get("command"), str) and media["command"].strip():
        for flag, path in zip(args, args[1:]):
            if flag == "-File" and isinstance(path, str) and Path(path) == wrapper:
                return "registered"
    return "wrapper-mismatch"


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["--media-registration"]:
            print(media_registration(Path(sys.argv[2]), Path(sys.argv[3])))
            sys.exit(0)
        config, fragment, output = map(Path, sys.argv[1:])
        existing = config.read_text(encoding="utf-8-sig") if config.exists() else ""
        recovered = recover_model_sync(existing, output.parent)
        output.write_text(without_replaced_tables(recovered, fragment.read_text(encoding="utf-8-sig")), encoding="utf-8")
        if recovered != existing:
            print("recovered-model-sync")
    except UnmatchedModelBackup:
        sys.exit(42)
    except Exception as error:
        print(f"Package config replacement failed ({type(error).__name__}); configuration not printed.", file=sys.stderr)
        sys.exit(1)
