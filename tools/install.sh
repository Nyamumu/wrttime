#!/bin/sh
# wrtTIME 설치 스크립트. 공유기에 SSH로 접속해서 실행한다:
#   uclient-fetch -qO- https://raw.githubusercontent.com/__REPO__/release/install.sh | sh
# 최신 버전을 받아 sha256과 파일 경로를 검사한 뒤 설치한다. 이미 설치되어 있으면 최신 버전으로 바꾼다.
# 내려받다가 끊겨도 일부만 실행되지 않도록 전체를 함수로 감싼다.

main() {
	umask 022 # / 권한을 바꾸지 않기 위해 항상 022로 설치한다
	REPO="__REPO__"
	RAW="https://raw.githubusercontent.com/$REPO/release"
	BASE="https://github.com/$REPO/releases"

	fail() { echo "설치 실패: $1" >&2; [ -n "${WORK:-}" ] && rm -rf "$WORK"; exit 1; }
	get() {
		uclient-fetch -q -T 30 -O "$1" "$2" 2>/dev/null && return 0
		rm -f "$1"
		uclient-fetch -q -T 30 -O "$1" "$3" 2>/dev/null
	}

	[ "$(id -u)" = 0 ] || fail "root 계정으로 실행해 주세요."
	[ -x /usr/bin/apk ] || fail "OpenWrt 25 이상만 지원합니다."
	for c in uclient-fetch jsonfilter sha256sum tar; do
		command -v "$c" >/dev/null 2>&1 || fail "$c 명령을 찾을 수 없습니다."
	done

	WORK="$(mktemp -d /tmp/nmmwrt-install.XXXXXX)" || fail "임시 폴더를 만들지 못했습니다."
	echo "최신 버전을 확인하는 중..."
	get "$WORK/latest.json" "$RAW/latest.json" "$BASE/latest/download/latest.json" || fail "버전 정보를 받지 못했습니다. 공유기의 인터넷 연결을 확인해 주세요."
	V="$(jsonfilter -i "$WORK/latest.json" -e '@.version' 2>/dev/null)"
	S="$(jsonfilter -i "$WORK/latest.json" -e '@.sha256' 2>/dev/null)"
	echo "$V" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "버전 정보가 올바르지 않습니다."
	echo "$S" | grep -qE '^[0-9a-f]{64}$' || fail "버전 정보가 올바르지 않습니다."

	echo "wrtTIME $V 내려받는 중..."
	get "$WORK/n.tgz" "$RAW/nmmwrt-$V.tar.gz" "$BASE/download/v$V/nmmwrt.tar.gz" || fail "설치 파일을 받지 못했습니다."
	[ "$(sha256sum "$WORK/n.tgz" | cut -d' ' -f1)" = "$S" ] || fail "설치 파일 검사(sha256)에 실패했습니다."

	# 정해진 위치의 파일만 들어 있어야 한다
	tar -tzf "$WORK/n.tgz" > "$WORK/list" 2>/dev/null || fail "설치 파일이 손상되었습니다."
	if grep -qvE '^(\./)?(www/|www/index\.html|www/nmm/[A-Za-z0-9._/-]*|usr/|usr/libexec/|usr/libexec/nmmwrt-update|usr/share/|usr/share/rpcd/|usr/share/rpcd/acl\.d/|usr/share/rpcd/acl\.d/easyui\.json|lib/|lib/upgrade/|lib/upgrade/keep\.d/|lib/upgrade/keep\.d/nmmwrt)$' "$WORK/list"; then
		fail "설치 파일에 허용되지 않은 경로가 있습니다."
	fi
	grep -qE '^(\./)?www/nmm/index\.html$' "$WORK/list" || fail "설치 파일이 올바르지 않습니다."

	# 원래 첫 화면(LuCI로 보내는 파일)은 처음 한 번 보관한다
	if [ -f /www/index.html ] && ! grep -q NMMWRT-ROOT /www/index.html; then
		cp /www/index.html /www/index.html.luci
	fi
	rm -rf /www/nmm
	tar -xzf "$WORK/n.tgz" -C / || fail "파일을 설치하지 못했습니다. 저장 공간을 확인해 주세요."
	chmod 755 /
	rm -rf "$WORK"
	/etc/init.d/rpcd reload >/dev/null 2>&1

	echo "wrtTIME $V 설치 완료. 브라우저에서 공유기 주소로 접속해 주세요."
}

main "$@"
