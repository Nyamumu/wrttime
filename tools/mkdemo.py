#!/usr/bin/env python3
"""GitHub Pages용 데모 사이트를 만든다: python3 tools/mkdemo.py [폴더]  (기본 dist/demo)

화면 코드(www/nmm)는 그대로 복사하고, 브라우저 안에서 가짜 ubus를 돌리는 tools/demo/demo.js를 맨 앞에 넣는다.
"""
import hashlib
import os
import shutil
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(BASE, *parts), encoding="utf-8") as f:
        return f.read()


def write(out, name, text):
    path = os.path.join(out, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def build_id(version):
    """버전 + 내용 해시. 같은 버전에서 데모만 고쳐도 브라우저가 새 파일을 받게 한다."""
    h = hashlib.sha256()
    sources = [os.path.join(BASE, "tools", name) for name in ("fakeubus.py", os.path.join("demo", "demo.js"))]
    sources.append(os.path.join(BASE, "rootfs", "usr", "share", "rpcd", "acl.d", "easyui.json"))
    for root, _, files in os.walk(os.path.join(BASE, "www", "nmm")):
        sources += [os.path.join(root, f) for f in files]
    for path in sorted(sources):
        h.update(os.path.relpath(path, BASE).replace(os.sep, "/").encode())
        with open(path, "rb") as f:
            h.update(f.read().replace(b"\r\n", b"\n"))
    return f"{version}-{h.hexdigest()[:10]}"


def build(out):
    version = read("VERSION").strip()
    build = build_id(version)
    if os.path.isdir(out):
        shutil.rmtree(out)
    shutil.copytree(os.path.join(BASE, "www", "nmm"), out)

    marker = '<link rel="stylesheet"'
    index = read("www", "nmm", "index.html")
    if marker not in index:
        raise SystemExit("index.html에서 스타일시트 줄을 찾지 못했습니다")
    index = index.replace(marker, f'<script src="demo/demo.js?v={build}"></script>\n  {marker}', 1)
    index = index.replace("__V__", build).replace("<title>wrtTIME</title>", "<title>wrtTIME 데모</title>")
    write(out, "index.html", index)

    write(out, "VERSION", version + "\n")
    write(out, "demo/demo.js", read("tools", "demo", "demo.js").replace("__V__", version).replace("__B__", build))
    write(out, "demo/fakeubus.py", read("tools", "fakeubus.py"))
    write(out, "demo/easyui.json", read("rootfs", "usr", "share", "rpcd", "acl.d", "easyui.json"))
    write(out, ".nojekyll", "")


if __name__ == "__main__":
    target = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, "dist", "demo"))
    build(target)
    print(target)
