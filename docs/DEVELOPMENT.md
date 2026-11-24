# wrtTIME: OpenWrt 쉬운 관리 UI

LuCI를 대신하는 쉬운 공유기 관리 화면입니다. **OpenWrt 25 이상**이 설치된 여러 공유기에서 쓰도록 만들었습니다.
포트 수와 이름은 공유기 설정과 `/etc/board.json`에서 알아내고, 스위치 방식(DSA, swconfig) 둘 다 지원합니다.
빌드 도구 없이 순수 JS로 만들었고,
uhttpd가 정적 파일로 서빙하며 `/ubus` JSON-RPC로 통신합니다. 휴대폰 화면과 어두운 테마를 지원합니다.

## 기능

| 메뉴 | 내용 |
|---|---|
| 시스템 요약 정보 | 인터넷/무선/내부 네트워크/기타 정보 타일, 포트 상태(링크·속도), 접속 기기 목록(연결된 포트/무선, 네트워크) |
| 네트워크 관리 | 인터넷 설정(자동 IP/고정 IP/PPPoE), 내부 네트워크 주소, DHCP 서버(범위, 임대 시간, 고정 IP 할당), VLAN(인터넷 VLAN 태그, 내부 VLAN과 별도 네트워크), 인터페이스 목록(상태, 주소, 포트 링크, 트래픽) |
| 무선 관리 | 대역별 켜기/끄기, 이름, 숨기기, 보안 방식, 암호, 빠른 로밍(802.11r), 채널 / 무선 고급 설정(대역별 국가 코드, 최대 출력) / 게스트 네트워크(무선 전용, 인터넷만) / VLAN 네트워크(VLAN 설정에서 만든 VLAN에 연결, 접속 허용 선택, 무선 선택) / 무선 메시(802.11s, WPA3-SAE, wpad-mesh 필요, 메시 구성도: 경유 연결까지 나무 모양, 이름/IP 자동 찾기와 수정, 응답 확인) |
| NAT/라우터 관리 | 포트포워드, UPnP (miniupnpd-nftables 필요, 열린 포트 목록) |
| 보안 기능 | 기기별 인터넷 접속 차단 (항상 / 요일·시간) |
| 특수 기능 | DDNS (ddns-scripts 필요), IPTV / 멀티캐스트 (IGMP 프록시: igmpproxy 필요, 브리지별 IGMP 스누핑) |
| 트래픽 관리 | 속도 관리 SQM (sqm-scripts 필요) |
| 시스템 관리 | 이름/시간대, 관리자 비밀번호, 펌웨어 업그레이드, 재시작/예약 재시작/백업/복원/초기화, 시스템 로그, 네트워크 진단(ping, traceroute, nslookup) |

설정은 적용 후 정해진 시간(보통 60초, 무선/내부 네트워크는 120초) 안에 공유기와 다시 연결되지 않으면
자동으로 이전 상태로 되돌아갑니다. 내부 네트워크 주소를 바꾸면 브라우저가 새 주소로 넘어가서 확인합니다.

## 구성

```
www/nmm/                                프론트엔드 (index.html, app.css, app.js + 페이지별 js)
rootfs/usr/share/rpcd/acl.d/easyui.json  UI가 쓸 수 있는 ubus/uci/파일 권한
deploy.sh                                공유기로 복사 + rpcd reload
dev.py                                   로컬 개발용 서버 (공유기 프록시 또는 가짜 ubus)
tools/fakeubus.py                        가짜 ubus
tests/                                   가짜 ubus 테스트
tools/openwrt-sandbox.sh                 실제 OpenWrt 샌드박스 (root 불필요)
```

## 공유기에 올리기

1. 공유기에 root 비밀번호가 설정되어 있어야 합니다.
   비밀번호가 비어 있으면 아무 비밀번호로나 로그인되므로 반드시 먼저 설정하세요. (화면에서도 경고합니다)
2. `sh deploy.sh 192.168.1.1` (리눅스/WSL/macOS에서 실행, root 비밀번호를 한 번 묻습니다)
3. `http://192.168.1.1/nmm/` 접속

LuCI는 그대로 남으므로 새 UI에 문제가 있어도 `/cgi-bin/luci`로 복구할 수 있습니다.
펌웨어 업그레이드와 백업/복원은 cgi-io 패키지를 씁니다 (LuCI를 지울 때 함께 지우지 마세요).

## 로컬에서 개발하기

공유기에 연결해서: `python3 dev.py 192.168.1.1 8080` 실행 후 `http://127.0.0.1:8080/` 접속.

공유기 없이: `python3 dev.py --mock` 실행 후 `http://127.0.0.1:8080/` 접속 (root / admin).
가짜 ubus(`tools/fakeubus.py`)가 로그인, ACL, 설정 적용/되돌림, 재시작, 펌웨어 검사 등을 메모리에서 흉내 냅니다.
`--profile mt6000`(GL-MT6000, LAN 5포트), `--profile dsa4`(LAN 4포트), `--profile swconfig`(스위치 칩), `--profile single`(포트 하나)로 다른 종류의 공유기도 흉내 냅니다.
옵션은 `python3 dev.py --help`를 보세요.

파일을 고치고 새로고침만 하면 됩니다. 테스트: `python3 -m unittest discover -s tests`

## 실제 OpenWrt로 확인하기 (공유기 없이)

리눅스나 WSL에서 root, 도커, QEMU 없이 공식 OpenWrt x86-64 rootfs를 띄웁니다.

```
bash tools/openwrt-sandbox.sh start          # http://127.0.0.1:8081/nmm/ (root / admin)
bash tools/openwrt-sandbox.sh sh logread     # 샌드박스 안에서 명령 실행
bash tools/openwrt-sandbox.sh stop
```

LuCI의 ACL은 치운 상태로 뜨므로, LuCI가 없는 공유기와 같은 조건에서 ACL을 확인할 수 있습니다.
무선 장치가 없고 WAN에 DHCP 서버가 없는 점은 실제 공유기와 다릅니다.

## 알아둘 점

- 접속 기기는 DHCP 임대(`/tmp/dhcp.leases`) 기준이라 고정 IP 기기나 이미 끊긴 임대가 섞일 수 있습니다.
- 세션 유효 시간은 1시간입니다.
- OpenWrt 25 미만은 지원하지 않습니다.
- 아직 실제 공유기에는 올려 보지 않았습니다. 무선, 실제 스위치 포트의 VLAN, 펌웨어 업그레이드는 실기기 확인이 필요합니다.
