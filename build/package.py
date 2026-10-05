#!/usr/bin/env python3
"""Package the plugin as a Slackware .txz and render plugin/duc.plg.

    python3 build/package.py --version 2026.10.05 --binary out/duc

Writes dist/unraid-duc-<version>-x86_64-1.txz and updates plugin/duc.plg.
"""

import argparse
import datetime
import hashlib
import io
import os
import subprocess
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PACKAGE = "unraid-duc"


def default_repo():
    if os.environ.get("GITHUB_REPOSITORY"):
        return os.environ["GITHUB_REPOSITORY"]
    try:
        url = subprocess.check_output(
            ["git", "-C", ROOT, "remote", "get-url", "origin"], text=True, stderr=subprocess.DEVNULL
        ).strip()
        return url.split("github.com")[-1].lstrip(":/").removesuffix(".git")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "jamesfreeman959/unraid-duc"


def is_executable(rel):
    return rel.startswith("usr/local/emhttp/plugins/duc/scripts/") or rel == "usr/local/bin/duc"


def add(tar, rel, data=None, path=None):
    """Add a file or directory owned by root with normalised permissions."""
    info = tarfile.TarInfo(rel)
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = int(os.environ.get("SOURCE_DATE_EPOCH", datetime.datetime.now().timestamp()))
    if data is None and path is None:
        info.type = tarfile.DIRTYPE
        info.mode = 0o755
        tar.addfile(info)
        return
    if data is None:
        with open(path, "rb") as f:
            data = f.read()
    info.size = len(data)
    info.mode = 0o755 if is_executable(rel) else 0o644
    tar.addfile(info, io.BytesIO(data))


def build_txz(version, binary, dist):
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"{PACKAGE}-{version}-x86_64-1.txz")
    entries = {}
    for dirpath, dirnames, filenames in os.walk(SRC):
        dirnames.sort()
        rel_dir = os.path.relpath(dirpath, SRC)
        if rel_dir != ".":
            entries[rel_dir + "/"] = None
        for name in sorted(filenames):
            if name == ".DS_Store":
                continue
            rel = os.path.normpath(os.path.join(rel_dir, name))
            entries[rel] = os.path.join(dirpath, name)
    for d in ("usr/", "usr/local/", "usr/local/bin/"):
        entries.setdefault(d, None)
    entries["usr/local/bin/duc"] = binary

    with tarfile.open(out, "w:xz") as tar:
        for rel in sorted(entries):
            src = entries[rel]
            if rel.endswith("/"):
                add(tar, rel.rstrip("/"))
            else:
                add(tar, rel, path=src)

    with open(out, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    return out, digest


def render_plg(version, digest, repo, author, changes):
    with open(os.path.join(ROOT, "plugin", "duc.plg.in")) as f:
        plg = f.read()
    for key, val in {
        "@VERSION@": version,
        "@SHA256@": digest,
        "@REPO@": repo,
        "@AUTHOR@": author,
        "@CHANGES@": changes.strip(),
    }.items():
        plg = plg.replace(key, val)
    out = os.path.join(ROOT, "plugin", "duc.plg")
    with open(out, "w") as f:
        f.write(plg)
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--version", default=datetime.date.today().strftime("%Y.%m.%d"))
    p.add_argument("--binary", default=os.path.join(ROOT, "out", "duc"))
    p.add_argument("--dist", default=os.path.join(ROOT, "dist"))
    p.add_argument("--repo", default=default_repo())
    p.add_argument("--author", default=os.environ.get("PLUGIN_AUTHOR", "jamesfreeman959"))
    p.add_argument("--changes", default=None, help="changelog text (markdown)")
    args = p.parse_args()

    changes = args.changes or f"### {args.version}\n\n- Release {args.version}"
    txz, digest = build_txz(args.version, args.binary, args.dist)
    plg = render_plg(args.version, digest, args.repo, args.author, changes)
    print(f"package: {txz}\nsha256:  {digest}\nplugin:  {plg}")


if __name__ == "__main__":
    main()
