#!/bin/sh
# 사용법: ./release.sh   -> dist/에 nmmwrt.tar.gz와 latest.json을 만든다.
# GitHub에 올리기: 두 곳에 모두 올린다.
#   1) release 브랜치: latest.json + install.sh + nmmwrt-<버전>.tar.gz (공유기가 raw.githubusercontent.com에서 먼저 받는다)
#   2) gh release create v<버전> dist/nmmwrt.tar.gz dist/latest.json dist/install.sh --title "wrtTIME <버전>" (대신 쓰는 경로)
set -e
cd "$(dirname "$0")"
[ -f release.conf ] || { echo "release.conf가 없습니다. REPO=owner/name 을 적어 주세요." >&2; exit 1; }

V="$(cat VERSION)" # 새 버전을 낼 때는 VERSION 파일의 숫자를 올린다
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
sh tools/mkstage.sh "$STAGE" "$(date +%Y%m%d%H%M%S)"

rm -rf dist
mkdir -p dist
tar -C "$STAGE" --owner=0 --group=0 -czf dist/nmmwrt.tar.gz www usr lib
SHA="$(sha256sum dist/nmmwrt.tar.gz | cut -d' ' -f1)"
printf '{"version":"%s","sha256":"%s"}\n' "$V" "$SHA" > dist/latest.json
. ./release.conf
sed "s#__REPO__#$REPO#g" tools/install.sh > dist/install.sh # 설치 명령이 내려받는 스크립트
echo "버전 $V"
echo "sha256 $SHA"
