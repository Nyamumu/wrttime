#!/usr/bin/env python3
"""wrtTIME 설치 파일 하나(dist/nmmwrt-install.sh)를 만든다.

설치 파일은 보통의 셸 스크립트이고 wrtTIME 파일을 모두 글자 그대로(here-document) 품고 있다.
공유기에 base64/scp/sftp가 없어도 되고, OpenWrt 기본 셸(busybox ash)만 있으면 설치된다.

  PC에서:      ssh root@공유기 sh < dist/nmmwrt-install.sh
  공유기에서:  sh nmmwrt-install.sh            (삭제: sh nmmwrt-install.sh uninstall)

넣는 파일: www/nmm/*  ->  /www/nmm/
           rootfs/www/index.html                     -> /www/index.html (원래 것은 처음 한 번 /www/index.html.luci로 보관)
           rootfs/usr/share/rpcd/acl.d/easyui.json   -> 같은 경로
           rootfs/lib/upgrade/keep.d/nmmwrt          -> 같은 경로 (펌웨어 업그레이드 때 보관)
"""
import os
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DELIM = "NMMWRT_FILE_END_7f3a"


def files():
    out = []
    web = os.path.join(BASE, "www", "nmm")
    for name in sorted(os.listdir(web)):
        p = os.path.join(web, name)
        if os.path.isfile(p):
            out.append((p, "/www/nmm/" + name))
    for rel in ("www/index.html", "usr/share/rpcd/acl.d/easyui.json", "lib/upgrade/keep.d/nmmwrt"):
        out.append((os.path.join(BASE, "rootfs", *rel.split("/")), "/" + rel))
    return out


def main():
    version = time.strftime("%Y%m%d%H%M%S")
    parts = []
    for src, dest in files():
        with open(src, "rb") as f:
            raw = f.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            sys.exit(f"글자 파일이 아닙니다 (설치 파일에 넣을 수 없음): {src}")
        text = text.replace("\r\n", "\n")
        if dest == "/www/nmm/index.html":
            text = text.replace("__V__", version)  # 업데이트 후 브라우저가 옛 파일을 쓰지 않게
        if any(line == DELIM for line in text.split("\n")):
            sys.exit(f"구분 줄과 같은 줄이 있습니다: {src}")
        target = "$NEW/" + dest[len("/www/nmm/"):] if dest.startswith("/www/nmm/") else dest
        parts.append(f"cat > \"{target}\" <<'{DELIM}'\n{text.rstrip(chr(10))}\n{DELIM}\n")

    script = f"""#!/bin/sh
# wrtTIME 설치 파일 (버전 {version}) - OpenWrt 25 이상
#   PC에서:      ssh root@공유기 sh < nmmwrt-install.sh
#   공유기에서:  sh nmmwrt-install.sh            삭제: sh nmmwrt-install.sh uninstall
# tools/mkinstaller.py가 만든 파일이다. 직접 고치지 말 것.
set -e
VERSION={version}

if [ ! -f /etc/openwrt_release ]; then echo "OpenWrt 공유기가 아닙니다."; exit 1; fi
. /etc/openwrt_release
case "$DISTRIB_RELEASE" in
  1[0-9].*|2[0-4].*) echo "wrtTIME는 OpenWrt 25 이상이 필요합니다. (이 공유기: $DISTRIB_RELEASE)"; exit 1 ;;
esac

if [ "$1" = "uninstall" ]; then
  rm -rf /www/nmm /usr/share/rpcd/acl.d/easyui.json /lib/upgrade/keep.d/nmmwrt
  if [ -f /www/index.html.luci ]; then mv /www/index.html.luci /www/index.html; echo "첫 화면을 LuCI로 되돌렸습니다."; fi
  /etc/init.d/rpcd reload
  echo "wrtTIME를 지웠습니다."
  exit 0
fi

echo "wrtTIME $VERSION 설치 중... ($(cat /tmp/sysinfo/model 2>/dev/null || echo OpenWrt), $DISTRIB_RELEASE)"
# 공유기 주소로 들어오면 wrtTIME로 가게 첫 화면을 바꾼다. 원래 것(LuCI로 보내는 파일)은 처음 한 번만 보관한다.
if [ -f /www/index.html ] && ! grep -q NMMWRT-ROOT /www/index.html; then
  cp /www/index.html /www/index.html.luci
  echo "원래 첫 화면을 /www/index.html.luci 로 보관했습니다."
fi

# 새 파일을 옆 폴더에 다 쓴 뒤 한 번에 바꾼다 (중간에 끊겨도 반쯤 바뀐 화면이 남지 않게)
NEW=/www/nmm.new
rm -rf "$NEW"
mkdir -p "$NEW" /usr/share/rpcd/acl.d /lib/upgrade/keep.d
{''.join(parts)}
rm -rf /www/nmm
mv "$NEW" /www/nmm
chmod 755 /www/nmm
chmod 644 /www/nmm/* /www/index.html /usr/share/rpcd/acl.d/easyui.json /lib/upgrade/keep.d/nmmwrt

/etc/init.d/rpcd reload
KEPT=$(sysupgrade -l 2>/dev/null | grep -cE "^/www/nmm/|^/www/index.html$|easyui.json$|keep.d/nmmwrt$" || true)
echo "완료: wrtTIME $VERSION  (펌웨어 업그레이드 때 보관되는 파일 $KEPT개)"
echo "접속: http://$(uci -q get network.lan.ipaddr | cut -d/ -f1)/"
"""
    os.makedirs(os.path.join(BASE, "dist"), exist_ok=True)
    out = os.path.join(BASE, "dist", "nmmwrt-install.sh")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(script)
    print(f"{os.path.relpath(out, BASE)}  (버전 {version}, {len(script) // 1024} KB, 파일 {len(parts)}개)")


if __name__ == "__main__":
    main()
