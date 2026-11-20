#!/bin/sh
# 사용법: tools/mkstage.sh <폴더> <빌드 시각(14자리)>
# 공유기의 / 에 풀 파일을 <폴더>에 모은다. deploy.sh와 release.sh가 같이 쓴다.
# wrtTIME 버전은 프로젝트의 VERSION 파일(예: 1.0.14), 빌드 시각은 브라우저 캐시를 피하는 ?v= 값이다.
set -e
STAGE="$1"
V="$2"
cd "$(dirname "$0")/.."

REPO=""
[ -f release.conf ] && . ./release.conf

mkdir -p "$STAGE/www" "$STAGE/usr/share/rpcd/acl.d" "$STAGE/usr/libexec" "$STAGE/lib/upgrade/keep.d"
cp -r www/nmm "$STAGE/www/nmm"
cp rootfs/www/index.html "$STAGE/www/index.html"
cp rootfs/usr/share/rpcd/acl.d/easyui.json "$STAGE/usr/share/rpcd/acl.d/"
cp rootfs/lib/upgrade/keep.d/nmmwrt "$STAGE/lib/upgrade/keep.d/"
sed "s#__REPO__#$REPO#g" rootfs/usr/libexec/nmmwrt-update > "$STAGE/usr/libexec/nmmwrt-update"
# index.html의 ?v=__V__ 를 버전으로 바꾼다. uhttpd는 캐시 헤더를 따로 보내지 않아서,
# 이렇게 해야 업데이트 후 브라우저가 옛 파일을 쓰지 않는다.
sed "s/__V__/$V/g" www/nmm/index.html > "$STAGE/www/nmm/index.html"
cp VERSION "$STAGE/www/nmm/VERSION"

# 소유자 root, 파일 644 / 폴더 755 (Windows 쪽 파일에는 실행 비트가 붙어 있을 수 있어서 직접 맞춘다)
find "$STAGE" -type d -exec chmod 755 {} +
find "$STAGE" -type f -exec chmod 644 {} +
chmod 755 "$STAGE/usr/libexec/nmmwrt-update"
