#!/bin/sh
# 사용법: ./deploy.sh [공유기 IP]   (기본값 192.168.1.1)   리눅스/WSL/macOS에서 실행
# 새 UI는 /www/nmm/ 에 올라가므로 LuCI(/cgi-bin/luci)는 그대로 남는다.
# 첫 화면(/www/index.html)은 wrtTIME로 보내는 것으로 바꾼다 (원래 것은 /www/index.html.luci).
# ssh 한 번으로 보낸다 (비밀번호를 한 번만 묻는다). 공유기 쪽에는 busybox tar만 있으면 된다.
set -e
ROUTER="${1:-192.168.1.1}"
cd "$(dirname "$0")"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
V="$(date +%Y%m%d%H%M%S)"
sh tools/mkstage.sh "$STAGE" "$V" # 올릴 파일 모으기 (release.sh와 같은 내용)

echo "공유기 $ROUTER 에 올립니다 (root 비밀번호를 물으면 입력하세요)..."
# 공유기의 / 에 푼다. 예전 /www/nmm은 지우고 새로 넣는다.
tar -C "$STAGE" --owner=0 --group=0 -czf - www usr lib \
  | ssh "root@$ROUTER" \
    'if [ -f /www/index.html ] && ! grep -q NMMWRT-ROOT /www/index.html; then cp /www/index.html /www/index.html.luci && echo "원래 첫 화면을 /www/index.html.luci 로 보관"; fi;
     rm -rf /www/nmm && tar -xzf - -C / && /etc/init.d/rpcd reload && echo "rpcd 다시 읽음";
     echo "펌웨어 업그레이드(설정 유지) 때 보관되는 wrtTIME 파일: $(sysupgrade -l 2>/dev/null | grep -cE "^/www/nmm/|^/www/index.html$|easyui.json$|keep.d/nmmwrt$|libexec/nmmwrt-update$")개"'

echo "완료: http://$ROUTER/ -> /nmm/  (버전 $(cat VERSION), 빌드 $V)"
echo "첫 화면을 LuCI로 되돌리려면 공유기에서: mv /www/index.html.luci /www/index.html"
