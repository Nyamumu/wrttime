"""가짜 ubus: uhttpd의 /ubus JSON-RPC와 rpcd(session, uci, file)를 메모리에서 흉내 낸다.

공유기 없이 UI를 반복 테스트하기 위한 것이다. HTTP는 dev.py가 맡고, 이 모듈은
요청 본문(bytes)을 받아 응답 본문(dict/list)을 돌려주는 일만 한다.

흉내 내는 범위
- uhttpd: JSON-RPC 'call'/'list', 배치 요청, ACL 거부(-32002), 없는 객체(-32000)
- session: login/destroy/access, 호출할 때마다 만료 시간 연장
- ACL: rootfs/usr/share/rpcd/acl.d/*.json을 읽어 ubus/uci/file 범위를 검사
  (root는 실제 rpcd 기본 설정처럼 읽은 그룹 전부를 받는다. LuCI의 ACL은 없으므로
   LuCI를 지운 공유기와 같은 조건이 된다)
- uci: get/set/add/delete/changes/revert/commit/configs/apply/confirm/rollback
  변경은 세션별로 쌓이고, commit 전에는 그 세션의 get에만 보인다.
- 적용(apply): 설정을 '실행 중 상태'로 반영하고, apply_delay초 동안 연결이 끊긴다.
  rollback=true면 timeout초 안에 confirm이 없을 때 직전 상태로 되돌린다.
- 상태 조회(system, network.interface, network.wireless, /tmp/dhcp.leases)는
  '실행 중 상태'의 UCI에서 만들어 낸다. 적용해야 홈 화면이 바뀐다.

실제 OpenWrt 25.12.6(tools/openwrt-sandbox.sh)에서 확인하고 맞춘 동작
- root 비밀번호가 비어 있으면 어떤 비밀번호로도 로그인된다 (password='' 로 흉내).
- uci get: 없는 섹션/옵션도 오류가 아니라 데이터 없는 [0]을 돌려준다.
- uci add: 이미 있는 이름으로 add하면 거부하지 않고 그 섹션의 타입을 바꾼다.
- uci set: 목록 값은 changes에 (기존 값이 있으면 remove +) list-add 여러 개로 나온다.
- uci apply: 변경이 없으면 [5]. timeout 상한은 없다 (1000초도 받는다). 생략하면 약 55초.
  timeout 0은 받아들이지만 자동 롤백이 걸리지 않는다 (confirm/rollback 전까지 대기).
  롤백되면(자동이든 rollback 호출이든) 설정과 함께 그 세션의 변경 목록도 되살아난다.
- confirm/rollback할 적용이 없으면 [5], 다른 적용이 대기 중일 때 rollback 적용은 [6] (같은 세션이어도).

여전히 실제와 다를 수 있는 점
- DHCP/PPPoE 연결은 항상 성공한다 (PPPoE는 아이디/비밀번호가 있으면 성공).
- 적용 후 연결이 끊기는 시간, 바뀐 인터페이스만 다시 연결되는 방식은 단순화했다.
"""
import copy
import fnmatch
import glob
import json
import os
import re
import secrets
import threading
import time
import zlib

# libubus 상태 코드
UBUS_OK = 0
UBUS_INVALID_COMMAND = 1
UBUS_INVALID_ARGUMENT = 2
UBUS_METHOD_NOT_FOUND = 3
UBUS_NOT_FOUND = 4
UBUS_NO_DATA = 5
UBUS_PERMISSION_DENIED = 6

# uhttpd-mod-ubus의 JSON-RPC 오류
RPC_PARSE = (-32700, "Parse error")
RPC_INVALID_REQUEST = (-32600, "Invalid request")
RPC_METHOD_NOT_FOUND = (-32601, "Method not found")
RPC_INVALID_PARAMS = (-32602, "Invalid params")
RPC_OBJECT_NOT_FOUND = (-32000, "Object not found")
RPC_ACCESS_DENIED = (-32002, "Access denied")

NULL_SID = "0" * 32
DEFAULT_APPLY_TIMEOUT = 55  # 25.12.6 실측

# rpcd 패키지에 기본으로 들어 있는 비로그인 ACL
UNAUTHENTICATED = {("ubus", "session", "access"), ("ubus", "session", "login")}


class Status(Exception):
    """ubus 메서드가 0이 아닌 상태 코드를 돌려줄 때 쓴다."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# ---------- UCI 데이터 모델 ----------
# 설정 하나 = 섹션 dict의 리스트(순서 유지). 섹션 dict는 '.name', '.type', '.anonymous'와 옵션들.

def S(type_, name=None, /, **opts):  # '/' : name, type 같은 UCI 옵션 이름을 그대로 쓰기 위해
    sec = {".type": type_, ".name": name, ".anonymous": name is None}
    sec.update(opts)
    return sec


# 공유기 종류(프로필): 포트 구성과 스위치 방식이 다른 OpenWrt 25 공유기들을 흉내 낸다.
#   mt3000   GL-MT3000: DSA, LAN 포트 1개(lan1) + WAN(eth1), 2.4/5GHz
#   mt6000   GL-MT6000: DSA, lan1(2.5G)~lan5 + WAN eth1(2.5G), 2.4/5GHz (OpenWrt 25.12의 02_network와 DTS 기준)
#   dsa4     흔한 DSA 공유기: lan1~lan4 + wan, 2.4/5/6GHz
#   swconfig 스위치 칩 공유기(ath79 등): switch0의 포트 1~4=LAN, 5=WAN, 0=CPU(eth0), eth0.1/eth0.2
#   single   포트 하나(eth0)만 쓰고 브리지가 없는 기기, WAN은 eth1, 2.4GHz 하나
PROFILES = {
    "mt3000": "GL.iNet GL-MT3000",
    "mt6000": "GL.iNet GL-MT6000",
    "dsa4": "Example DSA Router (4 LAN)",
    "swconfig": "Example swconfig Router (ath79)",
    "single": "Example Single-port Router",
}


def _radio(name, band, ch, path):
    return S("wifi-device", name, type="mac80211", path=path, band=band, channel=ch,
             htmode={"2g": "HE20", "5g": "HE80", "6g": "EHT160"}[band], cell_density="0")


def _ap(name, radio, ssid, enc="psk2"):
    return S("wifi-iface", name, device=radio, network="lan", mode="ap", ssid=ssid, encryption=enc, key="changeme123")


def profile_uci(profile):
    """network, wireless 설정. 순정은 무선이 꺼져 있지만 홈 화면을 보기 쉽게 켜 둔 상태로 시작한다."""
    lo = S("interface", "loopback", device="lo", proto="static", ipaddr="127.0.0.1", netmask="255.0.0.0")
    gl = S("globals", "globals", ula_prefix="fd12:3456:789a::/48")
    lan_ip = ["192.168.1.1/24"]
    if profile == "dsa4":
        net = [lo, gl, S("device", None, name="br-lan", type="bridge", ports=["lan1", "lan2", "lan3", "lan4"]),
               S("interface", "lan", device="br-lan", proto="static", ipaddr=lan_ip, ip6assign="60"),
               S("interface", "wan", device="wan", proto="dhcp"),
               S("interface", "wan6", device="wan", proto="dhcpv6")]
        wifi = [_radio("radio0", "2g", "1", "platform/soc/wifi"), _ap("default_radio0", "radio0", "MyHome"),
                _radio("radio1", "5g", "36", "platform/soc/wifi+1"), _ap("default_radio1", "radio1", "MyHome-5G"),
                _radio("radio2", "6g", "37", "platform/soc/wifi+2"), _ap("default_radio2", "radio2", "MyHome-6G", "sae")]
    elif profile == "mt6000":
        net = [lo, gl, S("device", None, name="br-lan", type="bridge", ports=["lan1", "lan2", "lan3", "lan4", "lan5"]),
               S("interface", "lan", device="br-lan", proto="static", ipaddr=lan_ip, ip6assign="60"),
               S("interface", "wan", device="eth1", proto="dhcp"),
               S("interface", "wan6", device="eth1", proto="dhcpv6")]
        wifi = [_radio("radio0", "2g", "1", "platform/soc/18000000.wifi"), _ap("default_radio0", "radio0", "MyHome"),
                _radio("radio1", "5g", "36", "platform/soc/18000000.wifi+1"), _ap("default_radio1", "radio1", "MyHome-5G")]
    elif profile == "swconfig":
        net = [lo, gl,
               S("switch", None, name="switch0", reset="1", enable_vlan="1"),
               S("switch_vlan", None, device="switch0", vlan="1", ports="1 2 3 4 0t"),
               S("switch_vlan", None, device="switch0", vlan="2", ports="5 0t"),
               S("device", None, name="br-lan", type="bridge", ports=["eth0.1"]),
               S("interface", "lan", device="br-lan", proto="static", ipaddr=lan_ip, ip6assign="60"),
               S("interface", "wan", device="eth0.2", proto="dhcp"),
               S("interface", "wan6", device="eth0.2", proto="dhcpv6")]
        wifi = [_radio("radio0", "2g", "6", "platform/ahb/18100000.wmac"), _ap("default_radio0", "radio0", "MyHome"),
                _radio("radio1", "5g", "36", "pci0000:00/0000:00:00.0"), _ap("default_radio1", "radio1", "MyHome-5G")]
    elif profile == "single":
        net = [lo, gl,
               S("interface", "lan", device="eth0", proto="static", ipaddr=lan_ip, ip6assign="60"),
               S("interface", "wan", device="eth1", proto="dhcp"),
               S("interface", "wan6", device="eth1", proto="dhcpv6")]
        wifi = [_radio("radio0", "2g", "1", "platform/wifi"), _ap("default_radio0", "radio0", "MyHome")]
    else:  # mt3000 (실기기 확인 2026-11-18: WAN=eth0, LAN=br-lan(eth1))
        net = [lo, gl, S("device", None, name="br-lan", type="bridge", ports=["eth1"]),
               S("interface", "lan", device="br-lan", proto="static", ipaddr=lan_ip, ip6assign="60"),
               S("interface", "wan", device="eth0", proto="dhcp"),
               S("interface", "wan6", device="eth0", proto="dhcpv6")]
        wifi = [_radio("radio0", "2g", "1", "platform/soc/18000000.wifi"), _ap("default_radio0", "radio0", "MyHome"),
                _radio("radio1", "5g", "36", "platform/soc/18000000.wifi+1"), _ap("default_radio1", "radio1", "MyHome-5G")]
    return net, wifi


def profile_board(profile):
    """/etc/board.json (OpenWrt가 처음 부팅 때 만드는 보드 정보)의 흉내."""
    model = {"id": profile, "name": PROFILES.get(profile, profile)}
    if profile == "swconfig":
        return {"model": model,
                "network": {"lan": {"device": "eth0.1", "protocol": "static"}, "wan": {"device": "eth0.2", "protocol": "dhcp"}},
                "switch": {"switch0": {"enable": True, "reset": True, "ports": [
                    {"num": 0, "device": "eth0", "need_tag": False, "want_untag": False},
                    {"num": 1, "role": "lan", "index": 1}, {"num": 2, "role": "lan", "index": 2},
                    {"num": 3, "role": "lan", "index": 3}, {"num": 4, "role": "lan", "index": 4},
                    {"num": 5, "role": "wan"}],
                    "roles": [{"role": "lan", "ports": "1 2 3 4 0t", "device": "eth0.1"},
                              {"role": "wan", "ports": "5 0t", "device": "eth0.2"}]}}}
    if profile == "mt3000":  # 실기기의 board.json과 같은 모양
        return {"model": model, "network": {"lan": {"device": "eth1", "protocol": "static"},
                                            "wan": {"device": "eth0", "protocol": "dhcp"}},
                "wlan": {"phy0": {}, "phy1": {}}}
    lan_ports = {"dsa4": ["lan1", "lan2", "lan3", "lan4"], "mt6000": ["lan1", "lan2", "lan3", "lan4", "lan5"],
                 "single": None}.get(profile)
    wan = {"dsa4": "wan"}.get(profile, "eth1")
    lan = {"ports": lan_ports, "protocol": "static"} if lan_ports else {"device": "eth0", "protocol": "static"}
    return {"model": model, "network": {"lan": lan, "wan": {"device": wan, "protocol": "dhcp"}}}


def default_uci(profile="mt3000"):
    """순정 OpenWrt 25.12를 올린 직후와 비슷한 설정.

    25.12의 config_generate는 lan 주소를 CIDR('192.168.1.1/24')로 쓰고 netmask를 두지 않는다.
    """
    net, wifi = profile_uci(profile)
    return {
        "network": net,
        "wireless": wifi,
        "dhcp": [
            S("dnsmasq", None, domainneeded="1", localise_queries="1", local="/lan/", domain="lan",
              expandhosts="1", authoritative="1", readethers="1",
              leasefile="/tmp/dhcp.leases", localservice="1"),
            S("dhcp", "lan", interface="lan", start="100", limit="150", leasetime="12h"),
            S("dhcp", "wan", interface="wan", ignore="1"),
        ],
        "system": [
            S("system", None, hostname="OpenWrt", timezone="GMT0", zonename="UTC", log_size="128"),
            S("timeserver", "ntp", enabled="1", enable_server="0",
              server=["0.openwrt.pool.ntp.org", "1.openwrt.pool.ntp.org"]),
        ],
        "dropbear": [S("dropbear", "main", enable="1", PasswordAuth="on", RootPasswordAuth="on", Port="22")],
        # 25.12 기본: HTTPS(443)도 열려 있고 HTTP는 HTTPS로 넘기지 않는다
        "uhttpd": [S("uhttpd", "main", listen_http=["0.0.0.0:80", "[::]:80"], listen_https=["0.0.0.0:443", "[::]:443"],
                     redirect_https="0", home="/www", cert="/etc/uhttpd.crt", key="/etc/uhttpd.key")],
        "banip": [S("banip", "global", ban_enabled="0", ban_debug="0", ban_autodetect="1")],
        # 아래 두 개는 실제로는 ddns-scripts / sqm-scripts 패키지를 깔아야 생긴다 (--no-packages로 없앨 수 있다)
        "ddns": [
            S("ddns", "global", ddns_dateformat="%F %R", ddns_loglines="250", upd_privateip="0"),
            S("service", "myddns_ipv4", enabled="0", lookup_host="yourhost.example.com", domain="yourhost.example.com",
              username="your_username", password="your_password", interface="wan", ip_source="network",
              ip_network="wan", service_name="dyndns.org", use_ipv6="0"),
        ],
        "sqm": [
            S("queue", "eth1", enabled="0", interface="eth1", download="85000", upload="10000", qdisc="cake",
              script="piece_of_cake.qos", linklayer="none", debug_logging="0", verbosity="5"),
        ],
        "firewall": [
            S("defaults", None, input="REJECT", output="ACCEPT", forward="REJECT", synflood_protect="1"),
            S("zone", None, name="lan", network=["lan"], input="ACCEPT", output="ACCEPT", forward="ACCEPT"),
            S("zone", None, name="wan", network=["wan", "wan6"], input="REJECT", output="ACCEPT",
              forward="REJECT", masq="1", mtu_fix="1"),
            S("forwarding", None, src="lan", dest="wan"),
            # OpenWrt 기본 규칙 일부 (트래픽 규칙 화면 확인용)
            S("rule", None, name="Allow-DHCP-Renew", src="wan", proto="udp", dest_port="68", target="ACCEPT", family="ipv4"),
            S("rule", None, name="Allow-Ping", src="wan", proto="icmp", icmp_type="echo-request", family="ipv4", target="ACCEPT"),
            S("rule", None, name="Allow-ICMPv6-Input", src="wan", proto="icmp",
              icmp_type=["echo-request", "echo-reply", "destination-unreachable"], limit="1000/sec", family="ipv6", target="ACCEPT"),
            S("rule", None, name="Allow-IPSec-ESP", src="wan", dest="lan", proto="esp", target="ACCEPT"),
        ],
    }


def find_section(sections, name):
    for sec in sections:
        if sec[".name"] == name:
            return sec
    return None


def apply_change(sections, change):
    """rpcd 'changes' 형식의 변경 하나를 섹션 리스트에 반영한다."""
    op = change[0]
    if op == "add":  # ["add", 이름, 타입] - 익명 섹션
        sections.append(S(change[2], change[1]))
        sections[-1][".anonymous"] = True
    elif op == "set" and len(change) == 3:  # ["set", 이름, 타입] - 이름 있는 섹션 생성 (있으면 타입 변경)
        sec = find_section(sections, change[1])
        if sec is None:
            sections.append(S(change[2], change[1]))
        else:
            sec[".type"] = change[2]
    elif op == "set":  # ["set", 섹션, 옵션, 값]
        sec = find_section(sections, change[1])
        if sec is not None:
            sec[change[2]] = change[3]
    elif op == "list-add":  # ["list-add", 섹션, 옵션, 값]
        sec = find_section(sections, change[1])
        if sec is not None:
            cur = sec.get(change[2])
            sec[change[2]] = (cur if isinstance(cur, list) else ([cur] if cur is not None else [])) + [change[3]]
    elif op == "remove" and len(change) == 2:
        sec = find_section(sections, change[1])
        if sec is not None:
            sections.remove(sec)
    elif op == "remove":
        sec = find_section(sections, change[1])
        if sec is not None:
            sec.pop(change[2], None)


def options_of(sec):
    return {k: v for k, v in sec.items() if not k.startswith(".")}


def section_out(sec, index=None):
    out = {".anonymous": sec[".anonymous"], ".type": sec[".type"], ".name": sec[".name"]}
    if index is not None:  # 실제 rpcd: 설정 전체를 읽을 때만 .index가 붙는다
        out[".index"] = index
    out.update(copy.deepcopy(options_of(sec)))
    return out


def valid_name(name):
    return isinstance(name, str) and name != "" and all(c.isalnum() or c == "_" for c in name)


def valid_value(value):
    if isinstance(value, list):
        return all(isinstance(v, (str, int, float, bool)) for v in value)
    return isinstance(value, (str, int, float, bool))


def to_uci_value(value):
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, list):
        return [to_uci_value(v) for v in value]
    return str(value)


# ---------- 상태 조회용 계산 ----------

def mask_to_prefix(mask):
    try:
        return sum(bin(int(p)).count("1") for p in mask.split("."))
    except (ValueError, AttributeError):
        return 24


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else str(value).split()


# ---------- ACL ----------

def load_acl_groups(paths):
    groups = {}
    for path in paths:
        with open(path, encoding="utf-8") as f:
            groups.update(json.load(f))
    return groups


def acl_entries(groups):
    """ACL 그룹들을 (범위, 객체 패턴, 기능 패턴) 집합으로 푼다. rpcd의 rpc_login_setup_acl과 같은 방식."""
    entries = set()
    for group in groups.values():
        for kind in ("read", "write"):
            spec = group.get(kind) or {}
            for obj, methods in (spec.get("ubus") or {}).items():
                for m in methods:
                    entries.add(("ubus", obj, m))
            for cfg in spec.get("uci") or []:
                entries.add(("uci", cfg, kind))
            for path, ops in (spec.get("file") or {}).items():
                for op in ops:
                    entries.add(("file", path, op))
            # 그 밖의 범위(예: "cgi-io": ["upload"])는 (범위, 객체, read/write)로 들어간다
            for scope, objs in spec.items():
                if scope in ("ubus", "uci", "file") or not isinstance(objs, list):
                    continue
                for obj in objs:
                    entries.add((scope, obj, kind))
    return entries


# ---------- 본체 ----------

class FakeUbus:
    def __init__(self, acl_files=(), password="admin", apply_delay=3.0,  # password='' : 비밀번호 미설정 공유기
                 max_session_timeout=None, clock=time.monotonic, log=print, packages=True, profile="mt3000"):
        if profile not in PROFILES:
            raise ValueError("알 수 없는 프로필: " + profile)
        self.profile = profile
        self.password = password
        self.apply_delay = apply_delay
        self.max_session_timeout = max_session_timeout
        self.clock = clock
        self.log = log
        self.lock = threading.RLock()
        groups = load_acl_groups(acl_files)
        self.acl = acl_entries(groups)
        self.access_groups = {name: [k for k in ("read", "write") if g.get(k)] for name, g in groups.items()}
        self.access_groups["unauthenticated"] = ["read"]

        self.packages = packages
        self.committed = self._factory_uci()           # /etc/config
        self.running = copy.deepcopy(self.committed)   # 마지막으로 적용된 설정
        self.files = {}                                # cgi-upload로 올라온 파일 (경로 -> bytes)
        self.kicked = set()                            # 연결 끊기를 한 무선 기기
        self.files[self.APK_KEYS + "/openwrt-25.12.pem"] = (  # 25.12 기본 저장소 공개 키
            b"-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECqruC4JU7pfpnkQuueBaT29I1dFx\n"
            b"Xbc7xYsY5R2+r3Hg3SO3B2QLpMaghA9Uzx/E2PGaNkYe24uPPg/n7Q9Jeg==\n-----END PUBLIC KEY-----\n")
        self.logs = []                                 # 시스템 로그 (log read)
        self._log_event("procd: - init complete -")
        self._log_event("netifd: Interface 'wan' is now up")
        self._log_event("dnsmasq-dhcp[1]: DHCPACK(br-lan) 192.168.1.101 a4:83:e7:12:34:56 my-iphone")
        self.staged = {}                               # sid -> {config: [changes]}
        self.sessions = {}                             # sid -> dict
        self.apply_sid = None
        self.snapshot = None
        self.snapshot_staged = None                    # 롤백 때 되살릴 그 세션의 변경 목록
        self.rollback_at = None
        self.down_until = 0.0
        self.started = clock()
        self.up_since = {}                             # 인터페이스 -> 연결 시작 시각
        self.iface_down = set()                        # down으로 내린 인터페이스

        self.methods = {
            "session": {"login": self.session_login, "destroy": self.session_destroy,
                        "access": self.session_access},
            "system": {"info": self.system_info, "board": self.system_board, "reboot": self.system_reboot,
                       "validate_firmware_image": self.validate_firmware},
            "log": {"read": self.log_read},
            "iwinfo": {"txpowerlist": self.iw_txpowerlist, "info": self.iw_info, "assoclist": self.iw_assoclist,
                       "devices": self.iw_devices, "phyname": self.iw_phyname,
                       "countrylist": lambda sid, a: {"results": [
                           {"code": c, "country": n} for c, n in [
                               ("KR", "Korea (South)"), ("US", "United States"), ("PA", "Panama"), ("CL", "Chile"),
                               ("AR", "Argentina"), ("ZA", "South Africa"), ("EG", "Egypt"), ("NO", "Norway"),
                               ("SE", "Sweden"), ("FI", "Finland"), ("PL", "Poland"), ("TR", "Turkey"), ("00", "World")]]}},
            "network.interface": {"dump": self.iface_dump},
            "network.device": {"status": self.device_status},
            # 실기기(25.12.6): uhttpd가 세션 인자를 덧붙여서 웹에서는 항상 [2]. UI는 iwinfo + uci로 대신한다.
            "network.wireless": {"status": self.wireless_status_web},
            "file": {"read": self.file_read, "write": self.file_write, "exec": self.file_exec, "list": self.file_list,
                     "remove": self.file_remove},
            "rpc-sys": {"password_set": self.password_set, "factory": self.factory,
                        "upgrade_start": self.upgrade_start,
                        "packagelist": lambda sid, args: {"packages": {n: v[0] for n, v in sorted(self._apk_state().items())}}},
            "uci": {"configs": self.uci_configs, "get": self.uci_get, "set": self.uci_set,
                    "add": self.uci_add, "delete": self.uci_delete, "changes": self.uci_changes,
                    "revert": self.uci_revert, "commit": self.uci_commit, "apply": self.uci_apply,
                    "confirm": self.uci_confirm, "rollback": self.uci_rollback},
        }

    # ----- 시간에 따른 일 (요청마다, 그리고 dev.py의 타이머 스레드에서 부른다) -----

    def tick(self):
        with self.lock:
            now = self.clock()
            for sid in [s for s, v in self.sessions.items() if v["expires"] <= now]:
                del self.sessions[sid]
                self.staged.pop(sid, None)
            if self.rollback_at is not None and now >= self.rollback_at:
                self.log("[fakeubus] 확인(confirm)이 없어 설정을 되돌립니다")
                self._do_rollback()

    def is_down(self):
        """적용 직후 네트워크 재시작 중이면 True. dev.py는 이때 연결을 그냥 끊는다."""
        return self.clock() < self.down_until

    # ----- JSON-RPC (uhttpd 역할) -----

    def handle(self, body):
        self.tick()
        try:
            req = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return self._error(None, RPC_PARSE)
        if isinstance(req, list):
            return [self._handle_one(r) for r in req]
        return self._handle_one(req)

    @staticmethod
    def _error(id_, err):
        return {"jsonrpc": "2.0", "id": id_, "error": {"code": err[0], "message": err[1]}}

    def _handle_one(self, req):
        if not isinstance(req, dict) or req.get("jsonrpc") != "2.0" or not isinstance(req.get("method"), str):
            return self._error(req.get("id") if isinstance(req, dict) else None, RPC_INVALID_REQUEST)
        id_ = req.get("id")
        params = req.get("params")
        if req["method"] == "list":
            return self._list(id_, params)
        if req["method"] != "call":
            return self._error(id_, RPC_METHOD_NOT_FOUND)
        if (not isinstance(params, list) or len(params) != 4 or not all(isinstance(p, str) for p in params[:3])
                or not isinstance(params[3], dict)):
            return self._error(id_, RPC_INVALID_PARAMS)
        sid, obj, method, args = params
        with self.lock:
            if not self._allowed(sid, "ubus", obj, method):
                return self._error(id_, RPC_ACCESS_DENIED)
            methods = self._resolve(obj)
            if methods is None:
                return self._error(id_, RPC_OBJECT_NOT_FOUND)
            fn = methods.get(method)
            if fn is None:
                return {"jsonrpc": "2.0", "id": id_, "result": [UBUS_METHOD_NOT_FOUND]}
            try:
                data = fn(sid, args)
            except Status as st:
                return {"jsonrpc": "2.0", "id": id_, "result": [st.code]}
            result = [UBUS_OK] if data is None else [UBUS_OK, data]
            return {"jsonrpc": "2.0", "id": id_, "result": result}

    def _resolve(self, obj):
        """ubus 객체 이름 -> 메서드 표. network.interface.<이름>은 설정된 인터페이스마다 생긴다."""
        if obj in self.methods:
            return self.methods[obj]
        prefix = "network.interface."
        if obj.startswith(prefix):
            name = obj[len(prefix):]
            if any(s[".type"] == "interface" and s[".name"] == name for s in self.running["network"]):
                return {"up": lambda sid, a: self.iface_updown(name, True),
                        "down": lambda sid, a: self.iface_updown(name, False),
                        "renew": lambda sid, a: None,
                        "status": lambda sid, a: self._iface(find_section(self.running["network"], name))}
        prefix = "hostapd."
        if obj.startswith(prefix) and obj[len(prefix):] in self._live_ifaces():
            return {"del_client": self.hostapd_del_client}
        return None

    def _list(self, id_, params):
        names = sorted(self.methods)
        if isinstance(params, list) and params:
            names = [n for n in names if any(fnmatch.fnmatchcase(n, p) for p in params if isinstance(p, str))]
        return {"jsonrpc": "2.0", "id": id_,
                "result": {n: {m: {} for m in self.methods[n]} for n in names}}

    # ----- 세션 / ACL -----

    def _session(self, sid):
        sess = self.sessions.get(sid)
        if sess is None:
            return None
        sess["expires"] = self.clock() + sess["timeout"]  # rpcd처럼 쓸 때마다 연장
        return sess

    def _allowed(self, sid, scope, obj, func):
        if sid == NULL_SID:
            entries = UNAUTHENTICATED
        else:
            sess = self._session(sid)
            if sess is None:
                return False
            entries = sess["acl"]
        return any(s == scope and fnmatch.fnmatchcase(obj, o) and fnmatch.fnmatchcase(func, f)
                   for s, o, f in entries)

    def session_login(self, sid, args):
        user, pw = args.get("username"), args.get("password")
        # 실제 rpcd: root 비밀번호가 비어 있으면 어떤 비밀번호로도 로그인된다.
        if user != "root" or (self.password != "" and pw != self.password):
            raise Status(UBUS_PERMISSION_DENIED)
        timeout = args.get("timeout", 300)
        if not isinstance(timeout, int) or timeout <= 0:
            timeout = 300
        if self.max_session_timeout:
            timeout = min(timeout, self.max_session_timeout)
        new_sid = secrets.token_hex(16)
        acl = set(UNAUTHENTICATED) | self.acl
        self.sessions[new_sid] = {"timeout": timeout, "expires": self.clock() + timeout, "acl": acl}
        acls = {"access-group": dict(sorted(self.access_groups.items()))}
        for scope, obj, func in sorted(acl):
            acls.setdefault(scope, {}).setdefault(obj, []).append(func)
        return {"ubus_rpc_session": new_sid, "timeout": timeout, "expires": timeout,
                "acls": acls, "data": {"username": user}}

    def session_destroy(self, sid, args):
        # uhttpd가 호출자의 세션 ID를 ubus_rpc_session으로 넣어 주므로 자기 세션이 지워진다.
        target = args.get("ubus_rpc_session", sid)
        if self.sessions.pop(target, None) is None:
            raise Status(UBUS_NOT_FOUND)
        self.staged.pop(target, None)

    def session_access(self, sid, args):
        target = args.get("ubus_rpc_session", sid)
        scope, obj, func = args.get("scope", "ubus"), args.get("object"), args.get("function")
        if not isinstance(obj, str) or not isinstance(func, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        return {"access": self._allowed(target, scope, obj, func)}

    # ----- 시스템 동작 (재시작, 초기화, 업그레이드, 로그) -----

    def _factory_uci(self):
        cfg = default_uci(self.profile)
        if not self.packages:
            cfg.pop("ddns", None)
            cfg.pop("sqm", None)
            cfg.pop("banip", None)
        # 실제 uci처럼 익명 섹션에도 'cfg' + 16진수 이름을 붙인다 (항상 같은 이름이 나오게)
        for config, sections in cfg.items():
            for i, sec in enumerate(sections):
                if sec[".name"] is None:
                    sec[".name"] = "cfg%02x%04x" % (i, zlib.crc32(config.encode()) & 0xFFFF)
        return cfg

    def _log_event(self, msg, priority=30):
        self.logs.append({"msg": msg, "id": len(self.logs) + 1, "priority": priority, "source": 1,
                          "time": int(time.time() * 1000)})

    def _go_down(self, seconds, what):
        """재시작 흉내: 그동안 HTTP 연결을 끊고, 세션도 모두 사라진다."""
        now = self.clock()
        self.down_until = now + seconds
        self.sessions.clear()
        self.staged.clear()
        self.apply_sid = self.snapshot = self.snapshot_staged = self.rollback_at = None
        self.started = now + seconds + 93784  # 다시 켜진 순간 가동 시간이 0 (_uptime이 93784를 더한다)
        self.up_since = {s[".name"]: now + seconds for s in self.running.get("network", []) if s[".type"] == "interface"}
        self.log(f"[fakeubus] {what}: {seconds}초 동안 연결이 끊깁니다")

    def system_reboot(self, sid, args):
        self._go_down(20, "재시작")

    def factory(self, sid, args):
        self.committed = self._factory_uci()
        self.running = copy.deepcopy(self.committed)
        self.password = ""
        self._go_down(30, "공장 초기화")

    def upgrade_start(self, sid, args):
        if self.files.get("/tmp/firmware.bin") is None:
            raise Status(UBUS_NOT_FOUND)
        if not args.get("keep", True):
            self.committed = self._factory_uci()
            self.running = copy.deepcopy(self.committed)
            self.password = ""
        self._go_down(40, "펌웨어 업그레이드")

    def validate_firmware(self, sid, args):
        # 가짜 펌웨어: 'NMMWRT-TEST-FW'로 시작하면 이 모델에 맞는 것으로 본다
        data = self.files.get(args.get("path"))
        if data is None:
            raise Status(UBUS_NOT_FOUND)
        ok = data.startswith(b"NMMWRT-TEST-FW")
        return {"tests": {"fwtool_signature": ok, "fwtool_device_match": ok}, "valid": ok,
                "forceable": True, "allow_backup": True}

    def log_read(self, sid, args):
        lines = args.get("lines") or len(self.logs)
        return {"log": copy.deepcopy(self.logs[-int(lines):])}

    def file_exec(self, sid, args):
        cmd, params = args.get("command"), args.get("params") or []
        if not isinstance(cmd, str) or not isinstance(params, list):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._allowed(sid, "file", " ".join([cmd] + params), "exec") and not self._allowed(sid, "file", cmd, "exec"):
            raise Status(UBUS_PERMISSION_DENIED)
        if cmd == "/sbin/sysupgrade" and params[:1] == ["--restore-backup"]:
            data = self.files.get(params[1] if len(params) > 1 else "")
            if data is None or not data.startswith(b"\x1f\x8b"):
                return {"code": 1, "stderr": "tar: invalid magic\n"}
            try:
                import gzip
                restored = json.loads(gzip.decompress(data))
                self.committed = restored
                self.log("[fakeubus] 백업에서 설정을 복원했습니다 (재시작 후 반영)")
            except (OSError, ValueError):
                return {"code": 1, "stderr": "invalid backup\n"}
            return {"code": 0, "stdout": ""}
        if cmd == "/usr/bin/apk":
            return self._apk(params)
        if cmd == "/etc/init.d/banip":
            if params == ["restart"]:
                sec = find_section(self.running["banip"], "global")
                sets = [f"country.v{v}" for v in (4, 6)] if "country" in as_list(sec.get("ban_feed")) else []
                self.banip_status = {"status": "active", "element_count": "12 345 (chains: 8, sets: 2, rules: 10)",
                                     "active_feeds": sets, "last_run": "mode: restart, date / time: 2026-11-19 02:00:00, duration: 0m 9s"}
            elif params == ["stop"]:
                self.banip_status = {"status": "stopped", "element_count": "0", "active_feeds": [], "last_run": "-"}
            return {"code": 0, "stdout": ""}
        if cmd == "/etc/init.d/igmpproxy" and "igmpproxy" in self.committed:
            enabled = getattr(self, "rc_enabled", set())
            if params == ["enable"]:
                self.rc_enabled = enabled | {"igmpproxy"}
            elif params == ["disable"]:
                self.rc_enabled = enabled - {"igmpproxy"}
            elif params in (["restart"], ["stop"]):
                self.log(f"[fakeubus] igmpproxy {params[0]}")
            else:
                return {"code": 1, "stderr": "unknown action\n"}
            return {"code": 0, "stdout": ""}
        if cmd in ("/etc/init.d/miniupnpd", "/etc/init.d/cron") and params in (["enable"], ["restart"], ["stop"]):
            name = cmd.rsplit("/", 1)[1]
            if name == "miniupnpd":
                if "upnpd" not in self.committed:
                    return {"code": 127, "stderr": "not found\n"}
                self.upnp_running = params != ["stop"] and \
                    (find_section(self.running["upnpd"], "config") or {}).get("enabled") == "1"
            self.log(f"[fakeubus] {name} {params[0]}")
            return {"code": 0, "stdout": ""}
        if cmd in self.DIAG_MISSING:
            raise Status(UBUS_NOT_FOUND)  # 실제 rpcd: 없는 명령이면 [4]
        if cmd == "/usr/sbin/iw":
            return self._iw(params)
        if cmd == "/bin/ping" and params[:4] == ["-c", "1", "-W", "1"]:  # 메시 공유기 응답 확인
            ok = params[-1].rsplit(".", 1)[-1] in [n[5] for n in self.MESH_NODES if n[5]] and self._mesh_on()
            return {"code": 0 if ok else 1, "stdout": "1 packets transmitted, %d packets received\n" % (1 if ok else 0)}
        if cmd in ("/bin/ping", "/usr/bin/traceroute", "/usr/bin/nslookup"):
            return self._diag(cmd.rsplit("/", 1)[1], params)
        if cmd == "/usr/libexec/nmmwrt-update":
            # 가짜 업데이트: 새 버전이 하나 있고, 설치하면 최신이 된다 (데모는 nmm_latest와 nmm_version을 같게 둬서 최신으로 보인다)
            latest = getattr(self, "nmm_latest", "1.0.15")
            cur = getattr(self, "nmm_version", "1.0.14")
            if params == ["install"]:
                self.nmm_version = cur = latest
            info = {"repo": "example/nmmwrt", "current": cur, "latest": latest, "sha256": "0" * 64, "update": cur != latest}
            if params == ["install"]:
                info["installed"] = True
            return {"code": 0, "stdout": json.dumps(info) + "\n"}
        if cmd == "/etc/init.d/led" and params == ["restart"]:
            self.log("[fakeubus] LED 서비스를 다시 시작했습니다")
            return {"code": 0, "stdout": ""}
        return {"code": 127, "stderr": "not found\n"}

    # ----- 메시 흉내 -----
    # 메시 MAC, 경유(None = 직접), 신호, 속도, br-lan MAC, IP(None = ARP에 없음), DHCP 이름(None = 고정 IP)
    MESH_NODES = [
        ("94:83:c4:aa:bb:01", None, -58, 866700, "94:83:c4:aa:cc:01", "2", None),
        ("94:83:c4:aa:bb:02", "94:83:c4:aa:bb:01", None, None, "94:83:c4:aa:cc:02", "150", "upstairs-ap"),
        ("94:83:c4:aa:bb:03", None, -77, 288200, "94:83:c4:aa:cc:03", None, None),
    ]

    def _mesh_on(self):
        return any(s[".type"] == "wifi-iface" and s.get("mode") == "mesh" and s.get("disabled") != "1"
                   for s in self.running["wireless"])

    def _lan_base(self):
        lan = find_section(self.running["network"], "lan") or {}
        return (as_list(lan.get("ipaddr")) or ["192.168.1.1"])[0].split("/")[0].rsplit(".", 1)[0]

    def _iw(self, params):
        if len(params) != 4 or params[0] != "dev" or params[3] != "dump" or params[2] not in ("mpath", "mpp"):
            return {"code": 1, "stderr": "command failed: Invalid argument (-22)\n"}
        dev = params[1]
        if not self._mesh_on() or "-mesh" not in dev:
            return {"code": 1, "stderr": "command failed: No such device (-19)\n"}
        if params[2] == "mpath":
            rows = ["DEST ADDR         NEXT HOP          IFACE\tSN\tMETRIC\tQLEN\tEXPTIME\tDTIM\tDRET\tFLAGS\tHOP_COUNT\tPATH_CHANGE"]
            for mac, via, *_ in self.MESH_NODES:
                hops = 1 if via is None else 2
                rows.append(f"{mac} {via or mac} {dev}\t12\t{170 * hops}\t0\t2310\t100\t0\t0x15\t{hops}\t1")
        else:
            rows = ["DEST ADDR         PROXY NODE        IFACE"]
            rows += [f"{lan} {mac} {dev}" for mac, _, _, _, lan, *_ in self.MESH_NODES]
        return {"code": 0, "stdout": "\n".join(rows) + "\n"}

    def _arp(self):
        base = self._lan_base()
        rows = ["IP address       HW type     Flags       HW address            Mask     Device"]
        rows += [f"{base}.{n}  0x1  0x2  {mac}  *  br-lan" for mac, n in
                 (("a4:83:e7:12:34:56", 101), ("3c:22:fb:aa:bb:cc", 102), ("b8:27:eb:11:22:33", 104))]
        if self._mesh_on():
            rows += [f"{base}.{ip}  0x1  0x2  {lan}  *  br-lan" for _, _, _, _, lan, ip, _ in self.MESH_NODES if ip]
        return "\n".join(rows) + "\n"

    # ----- 네트워크 진단 흉내 -----
    DIAG_MISSING = ("/usr/bin/ping", "/bin/traceroute", "/bin/nslookup")  # 다른 위치는 없는 공유기 (첫 위치를 찾는 흐름 확인)

    def _diag(self, tool, params):
        host = params[-1] if params else ""
        v6 = "-6" in params
        if host.endswith(".invalid"):
            if tool == "nslookup":
                return {"code": 1, "stdout": f"Server:\t\t127.0.0.1\nAddress:\t127.0.0.1:53\n\n** server can't find {host}: NXDOMAIN\n"}
            return {"code": 1, "stderr": f"{tool}: bad address '{host}'\n"}
        addr = "2001:4860:4860::8888" if v6 else ("8.8.8.8" if re.match(r"^[\d.]+$", host) else "223.130.200.107")
        if tool == "ping":
            lines = [f"PING {host} ({addr}): 56 data bytes"]
            lines += [f"64 bytes from {addr}: seq={i} ttl=117 time={11.2 + i * 0.4:.3f} ms" for i in range(4)]
            lines += ["", f"--- {host} ping statistics ---", "4 packets transmitted, 4 packets received, 0% packet loss",
                      "round-trip min/avg/max = 11.200/11.800/12.400 ms"]
            return {"code": 0, "stdout": "\n".join(lines) + "\n"}
        if tool == "traceroute":
            hops = ["192.0.2.1", "203.0.113.1", "198.51.100.9", addr] if not v6 else ["2001:db8::1", addr]
            lines = [f"traceroute to {host} ({addr}), 20 hops max, 46 byte packets"]
            lines += [f"{i + 1:2d}  {hp}  {1.5 + i * 3.1:.3f} ms" for i, hp in enumerate(hops)]
            return {"code": 0, "stdout": "\n".join(lines) + "\n"}
        return {"code": 0, "stdout": f"Server:\t\t127.0.0.1\nAddress:\t127.0.0.1:53\n\nNon-authoritative answer:\n"
                                     f"Name:\t{host}\nAddress: {addr}\n"}

    # ----- 가짜 apk (소프트웨어 관리 화면 확인용) -----
    # 설치됨: 이름 -> (버전, 설명, 설치 크기). 저장소: 이름 -> (버전, 설명). 저장소 버전이 더 새로우면 업그레이드 가능.
    APK_INSTALLED = {
        "base-files": ("1659-r1", "This package contains a base filesystem and system scripts for OpenWrt.", 61440),
        "busybox": ("1.37.0-r5", "The Swiss Army Knife of embedded Linux.", 573440),
        "dnsmasq": ("2.91-r1", "It is intended to provide coupled DNS and DHCP service to a LAN.", 286720),
        "luci-app-firewall": ("25.290.1-r1", "Firewall and port forwarding configuration", 81920),
        "tailscale": ("1.88.3-r1", "It creates a secure network between your servers, computers, and cloud instances.", 33554432),
        "uhttpd": ("2025.07.06-r1", "uHTTPd is a tiny single threaded HTTP server.", 81920),
        "libustream-mbedtls20201210": ("2026.03.01~99f1c0db-r1", "ustream SSL Library (mbedtls)", 20480),
        "px5g-mbedtls": ("13", "Px5g is a tiny standalone X.509 certificate generator.", 10240),
        "wpad-basic-mbedtls": ("2025.08.26~ced4f9b2-r2", "This package contains a minimal IEEE 802.1x/WPA Authenticator and Supplicant", 655360),
    }
    APK_REPO = {
        "base-files": ("1659-r1", ""), "busybox": ("1.37.0-r5", ""), "dnsmasq": ("2.91-r2", ""),
        "luci-app-firewall": ("25.290.1-r1", ""), "tailscale": ("1.90.1-r1", ""), "uhttpd": ("2025.07.06-r1", ""),
        "luci-app-upnp": ("25.290.1-r1", "UPnP IGD & PCP configuration"),
        "miniupnpd-nftables": ("2.3.9-r1", "Lightweight UPnP IGD, NAT-PMP & PCP daemon"),
        "tailscale-tools": ("1.90.1-r1", ""), "tcpdump": ("4.99.5-r1", "Network monitoring and data acquisition tool"),
        "ddns-scripts": ("2.8.4-r9", "Dynamic DNS Client scripts"),
        "sqm-scripts": ("1.7.2-r1", "Smart Queue Management scripts"),
        "luci-app-sqm": ("26.320.60423~5331286", "Control the simple_qos SQM script"),
        "banip": ("1.9.1-r5", "banIP blocks IPs via named nftables Sets."),
        "igmpproxy": ("0.4-r2", "IGMP Proxy daemon"),
        "wpad-basic-mbedtls": ("2025.08.26~ced4f9b2-r2", ""),
        "wpad-mesh-mbedtls": ("2025.08.26~ced4f9b2-r2", "IEEE 802.1x Authenticator/Supplicant (with 802.11s mesh and SAE)"),
    }
    # 패키지를 설치하면 생기는 설정 파일 (--no-packages로 켠 공유기에서 설치 흐름을 확인한다)
    APK_CONFIGS = {"ddns-scripts": "ddns", "sqm-scripts": "sqm", "banip": "banip", "igmpproxy": "igmpproxy",
                   "miniupnpd-nftables": "upnpd"}
    # 기본 설정에 넣지 않고 설치할 때만 생기는 설정 (igmpproxy 패키지에 들어 있는 /etc/config/igmpproxy)
    APK_ONLY_UCI = {"igmpproxy": [
        S("igmpproxy", "cfg01a1b2", quickleave="1"),
        S("phyint", "cfg02a1b2", network="wan", zone="wan", direction="upstream", altnet=["192.168.1.0/24"]),
        S("phyint", "cfg03a1b2", network="lan", zone="lan", direction="downstream"),
    ], "upnpd": [
        S("upnpd", "config", enabled="0", enable_natpmp="1", enable_upnp="1", secure_mode="1", log_output="0",
          download="1024", upload="512", internal_iface="lan", port="5000", upnp_lease_file="/var/run/miniupnpd.leases",
          igdv1="1"),
        S("perm_rule", "cfga1b2c3", action="allow", ext_ports="1024-65535", int_addr="0.0.0.0/0",
          int_ports="1024-65535", comment="Allow high ports"),
    ]}
    BANIP_COUNTRIES = "".join(f"{c}\t{r}\t{n}\n" for c, r, n in [
        ("cn", "APNIC", "China"), ("kr", "APNIC", "Korea (the Republic of)"), ("jp", "APNIC", "Japan"), ("ru", "RIPE", "Russian Federation"),
        ("us", "ARIN", "United States of America"), ("de", "RIPE", "Germany"), ("br", "LACNIC", "Brazil"), ("ap", "AFRINIC", "ARIPO")])

    def _apk_add_config(self, pkg):
        config = self.APK_CONFIGS.get(pkg)
        if not config or config in self.committed:
            return
        if config in self.APK_ONLY_UCI:
            self.committed[config] = copy.deepcopy(self.APK_ONLY_UCI[config])
            self.running[config] = copy.deepcopy(self.APK_ONLY_UCI[config])
            self.rc_enabled = getattr(self, "rc_enabled", set()) | {config}  # 실제 apk도 설치하면서 서비스를 켠다
            return
        packages, self.packages = self.packages, True
        factory = self._factory_uci()
        self.packages = packages
        self.committed[config] = copy.deepcopy(factory[config])
        self.running[config] = copy.deepcopy(factory[config])

    def _apk_state(self):
        if not hasattr(self, "apk_installed"):
            self.apk_installed = dict(self.APK_INSTALLED)
            self.apk_updated = False
        return self.apk_installed

    def _apk_db(self):
        out = []
        for name, (ver, desc, size) in sorted(self._apk_state().items()):
            out.append(f"C:Q1fake=\nP:{name}\nV:{ver}\nA:aarch64_cortex-a53\nS:{size // 3}\nI:{size}\nT:{desc}\n")
        return "\n".join(out) + "\n"

    def _apk(self, params):
        import fnmatch
        inst = self._apk_state()
        line = lambda n, v, tag: f"{n}-{v} aarch64_cortex-a53 {{{n}}} (GPL-2.0){tag}"
        sub, rest = (params[0] if params else ""), params[1:]
        if sub == "list":
            if "--installed" in rest:
                return {"code": 0, "stdout": "\n".join(line(n, v[0], " [installed]") for n, v in sorted(inst.items())) + "\n"}
            if "--upgradable" in rest:
                ups = [line(n, self.APK_REPO[n][0], f" [upgradable from: {n}-{v[0]}]") for n, v in sorted(inst.items())
                       if n in self.APK_REPO and self.APK_REPO[n][0] != v[0]]
                return {"code": 0, "stdout": "\n".join(ups) + ("\n" if ups else "")}
            pats = [p for p in rest if not p.startswith("-")] or ["*"]
            names = [n for n in sorted(self.APK_REPO) if any(fnmatch.fnmatch(n, p) for p in pats)]
            return {"code": 0, "stdout": "\n".join(line(n, self.APK_REPO[n][0], " [installed]" if n in inst else "") for n in names) + "\n"}
        if sub == "search":
            pats = [p for p in rest if not p.startswith("-")] or ["*"]
            names = [n for n in sorted(self.APK_REPO) if any(fnmatch.fnmatch(n, p) for p in pats)]
            return {"code": 0, "stdout": "".join(f"{n}-{self.APK_REPO[n][0]} - {self.APK_REPO[n][1]}\n" for n in names)}
        if sub == "update":
            self.apk_updated = True
            return {"code": 0, "stdout": "fetch https://downloads.openwrt.org/releases/25.12.6/packages.adb\nOK: 9876 distinct packages available\n"}
        if sub in ("add", "upgrade"):
            names = [p for p in rest if not p.startswith("-")]
            for n in names:
                if n == "/tmp/upload.apk":
                    if not self.files.get(n):
                        return {"code": 1, "stderr": "ERROR: /tmp/upload.apk: No such file or directory\n"}
                    inst["uploaded-package"] = ("1.0-r1", "올린 파일로 설치한 가짜 패키지", 4096)
                    continue
                if n not in self.APK_REPO:
                    return {"code": 1, "stderr": f"ERROR: unable to select packages:\n  {n} (no such package):\n    required by: world[{n}]\n"}
                other = [p for p in inst if p.startswith("wpad-") and p != n]
                if n.startswith("wpad-") and other:  # 실제 apk: 둘 다 hostapd를 제공하므로 같이 설치할 수 없다
                    return {"code": 1, "stderr": f"ERROR: unable to select packages:\n  {n}: conflicts: {other[0]}\n"}
                ver, desc = self.APK_REPO[n]
                inst[n] = (ver, desc or (inst.get(n) or ("", "", 0))[1], (inst.get(n) or ("", "", 65536))[2])
                self._apk_add_config(n)
            self.log(f"[fakeubus] apk {sub} {' '.join(rest)}")
            return {"code": 0, "stdout": "".join(f"(1/1) Installing {n}\n" for n in names) + "OK: 16 MiB in 180 packages\n"}
        if sub == "del":
            for n in rest:
                if n not in inst:
                    return {"code": 1, "stderr": f"ERROR: No such package: {n}\n"}
            for n in rest:
                del inst[n]
            return {"code": 0, "stdout": "".join(f"(1/1) Purging {n}\n" for n in rest)}
        return {"code": 1, "stderr": "apk: unknown command\n"}

    def make_backup(self):
        import gzip
        return gzip.compress(json.dumps(self.committed, ensure_ascii=False).encode("utf-8"))

    def check(self, sid, scope, obj, func):
        """dev.py의 cgi-io 흉내가 쓰는 권한 검사."""
        with self.lock:
            self.tick()
            return self._allowed(sid, scope, obj, func)

    # ----- rpc-sys -----

    def password_set(self, sid, args):
        user, pw = args.get("user"), args.get("password")
        if not isinstance(user, str) or not isinstance(pw, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if user != "root":
            raise Status(UBUS_NOT_FOUND)
        self.password = pw
        self.log("[fakeubus] root 비밀번호를 바꿨습니다")

    # ----- uci -----

    def _need(self, sid, config, kind):
        if not isinstance(config, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._allowed(sid, "uci", config, kind):
            raise Status(UBUS_PERMISSION_DENIED)
        if config not in self.committed:
            raise Status(UBUS_NOT_FOUND)

    def _view(self, sid, config):
        """이 세션이 보는 설정: 커밋된 설정 + 이 세션이 쌓은 변경."""
        sections = copy.deepcopy(self.committed[config])
        for change in self.staged.get(sid, {}).get(config, []):
            apply_change(sections, change)
        return sections

    def _record(self, sid, config, change):
        self.staged.setdefault(sid, {}).setdefault(config, []).append(change)

    def uci_configs(self, sid, args):
        return {"configs": sorted(self.committed)}  # 실제 rpcd: 읽기 권한과 상관없이 전부 보인다

    def uci_get(self, sid, args):
        config = args.get("config")
        self._need(sid, config, "read")
        sections = self._view(sid, config)
        name, option = args.get("section"), args.get("option")
        if name is None:
            type_ = args.get("type")
            return {"values": {s[".name"]: section_out(s, i) for i, s in enumerate(sections)
                               if type_ is None or s[".type"] == type_}}
        sec = find_section(sections, name)
        if sec is None:
            return None  # 실제 rpcd: 없는 섹션도 데이터 없는 [0]
        if option is None:
            return {"values": section_out(sec)}
        if option not in options_of(sec):
            return None  # 없는 옵션도 마찬가지
        return {"value": copy.deepcopy(sec[option])}

    def uci_set(self, sid, args):
        config, name, values = args.get("config"), args.get("section"), args.get("values")
        self._need(sid, config, "write")
        if not isinstance(name, str) or not isinstance(values, dict):
            raise Status(UBUS_INVALID_ARGUMENT)
        sec = find_section(self._view(sid, config), name)
        if sec is None:
            raise Status(UBUS_NOT_FOUND)
        for opt, value in values.items():
            if not valid_name(opt) or not valid_value(value):
                raise Status(UBUS_INVALID_ARGUMENT)
        self._set_options(sid, config, name, values, existing=options_of(sec))

    def _set_options(self, sid, config, name, values, existing):
        for opt, value in values.items():
            if value == "" or value == []:  # rpcd: 빈 값은 옵션 삭제 (없는 옵션이면 아무 일도 없다)
                if opt in existing:
                    self._record(sid, config, ["remove", name, opt])
            elif isinstance(value, list):  # rpcd: 기존 값을 지우고 list-add를 하나씩
                if opt in existing:
                    self._record(sid, config, ["remove", name, opt])
                for v in to_uci_value(value):
                    self._record(sid, config, ["list-add", name, opt, v])
            else:
                self._record(sid, config, ["set", name, opt, to_uci_value(value)])

    def uci_add(self, sid, args):
        config, type_, name = args.get("config"), args.get("type"), args.get("name")
        values = args.get("values") or {}
        self._need(sid, config, "write")
        # 섹션 타입에는 '-'도 쓸 수 있다 (wifi-device, bridge-vlan). 옵션/섹션 이름은 [A-Za-z0-9_]만.
        type_ok = isinstance(type_, str) and valid_name(type_.replace("-", "_"))
        if not type_ok or (name is not None and not valid_name(name)) or not isinstance(values, dict):
            raise Status(UBUS_INVALID_ARGUMENT)
        for opt, value in values.items():
            if not valid_name(opt) or not valid_value(value):
                raise Status(UBUS_INVALID_ARGUMENT)
        sections = self._view(sid, config)
        if name is None:
            while True:
                name = "cfg%02x%04x" % (len(sections), secrets.randbelow(0x10000))
                if find_section(sections, name) is None:
                    break
            self._record(sid, config, ["add", name, type_])
            existing = {}
        else:
            # 실제 rpcd: 이미 있는 이름이면 거부하지 않고 그 섹션의 타입을 바꾼다 (UI에서 조심할 것)
            old = find_section(sections, name)
            existing = options_of(old) if old else {}
            self._record(sid, config, ["set", name, type_])
        self._set_options(sid, config, name, {k: v for k, v in values.items() if v != "" and v != []}, existing)
        return {"section": name}

    def uci_delete(self, sid, args):
        config, name = args.get("config"), args.get("section")
        self._need(sid, config, "write")
        sec = find_section(self._view(sid, config), name) if isinstance(name, str) else None
        if sec is None:
            raise Status(UBUS_NOT_FOUND)
        opts = args.get("options")
        if args.get("option") is not None:
            if args["option"] not in options_of(sec):
                raise Status(UBUS_NOT_FOUND)  # 실제 rpcd: 없는 옵션 하나를 지우면 Not found
            opts = [args["option"]]
        if opts is None:
            self._record(sid, config, ["remove", name])
            return
        if not isinstance(opts, list):
            raise Status(UBUS_INVALID_ARGUMENT)
        for opt in opts:
            if opt in options_of(sec):
                self._record(sid, config, ["remove", name, opt])

    def uci_changes(self, sid, args):
        config = args.get("config")
        mine = self.staged.get(sid, {})
        if config is not None:
            self._need(sid, config, "read")
            return {"changes": copy.deepcopy(mine.get(config, []))}
        return {"changes": {c: copy.deepcopy(mine[c]) for c in sorted(mine)
                            if mine[c] and self._allowed(sid, "uci", c, "read")}}

    def uci_revert(self, sid, args):
        config = args.get("config")
        self._need(sid, config, "write")
        if self.apply_sid is not None:
            raise Status(UBUS_PERMISSION_DENIED)  # 실제 rpcd: 적용 확인 대기 중에는 누구도 revert 못 한다
        self.staged.get(sid, {}).pop(config, None)

    def _commit(self, sid, config):
        self.committed[config] = self._view(sid, config)
        self.staged.get(sid, {}).pop(config, None)

    def uci_commit(self, sid, args):
        config = args.get("config")
        self._need(sid, config, "write")
        self._commit(sid, config)  # 실제처럼 commit만으로는 서비스가 다시 읽지 않는다

    def uci_apply(self, sid, args):
        rollback = bool(args.get("rollback", False))
        timeout = args.get("timeout", DEFAULT_APPLY_TIMEOUT)
        if self.apply_sid is not None and rollback:
            raise Status(UBUS_PERMISSION_DENIED)  # 적용이 확인을 기다리는 중 (같은 세션이어도)
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 0:
            raise Status(UBUS_INVALID_ARGUMENT)
        changed = [c for c, v in self.staged.get(sid, {}).items() if v]
        if not changed:
            raise Status(UBUS_NO_DATA)
        if rollback:
            self.snapshot = copy.deepcopy(self.committed)
            self.snapshot_staged = (sid, copy.deepcopy(self.staged[sid]))
            self.apply_sid = sid
        for config in changed:
            self._commit(sid, config)
        self._reload()
        if rollback:
            # 실제 rpcd: timeout 0은 받지만 자동 롤백을 걸지 않는다
            self.rollback_at = self.clock() + timeout if timeout > 0 else None
        self.log(f"[fakeubus] 적용: {', '.join(changed)}"
                 + (f" / {timeout}초 안에 확인 없으면 되돌림" if rollback and timeout else "")
                 + (" / 자동 롤백 없음(timeout 0)" if rollback and not timeout else ""))

    def uci_confirm(self, sid, args):
        if self.apply_sid is None:
            raise Status(UBUS_NO_DATA)
        if self.apply_sid != sid:
            raise Status(UBUS_PERMISSION_DENIED)
        self.apply_sid = self.snapshot = self.snapshot_staged = self.rollback_at = None
        self.log("[fakeubus] 적용 확인됨")

    def uci_rollback(self, sid, args):
        if self.apply_sid is None:
            raise Status(UBUS_NO_DATA)
        if self.apply_sid != sid:
            raise Status(UBUS_PERMISSION_DENIED)
        self.log("[fakeubus] 요청에 따라 설정을 되돌립니다")
        self._do_rollback()

    def _do_rollback(self):
        self.committed = self.snapshot
        # 실제 rpcd: 적용했던 세션의 변경 목록이 되살아난다 (다시 적용하거나 revert할 수 있게)
        sid, staged = self.snapshot_staged
        if sid in self.sessions:
            self.staged[sid] = staged
        self.apply_sid = self.snapshot = self.snapshot_staged = self.rollback_at = None
        # 되돌린 설정은 원래 동작하던 것이므로 짧게만 끊긴다.
        # (--apply-delay를 크게 주면 '적용한 설정 때문에 연결이 끊긴' 상황을 흉내 낼 수 있다)
        self._reload(min(self.apply_delay, 3))

    def _reload(self, delay=None):
        """reload_config 흉내: 실행 중 상태를 바꾸고, 바뀐 인터페이스는 다시 연결한다."""
        delay = self.apply_delay if delay is None else delay
        old = self.running
        self.running = copy.deepcopy(self.committed)
        now = self.clock()
        for sec in self.running.get("network", []):
            if sec[".type"] != "interface":
                continue
            prev = find_section(old.get("network", []), sec[".name"])
            if prev != sec:
                self.up_since[sec[".name"]] = now + min(delay, 3)
        self.down_until = now + delay if delay > 0 else 0

    # ----- 상태 조회 -----

    def _uptime(self):
        return int(self.clock() - self.started) + 93784  # 하루쯤 켜져 있던 것처럼

    def system_info(self, sid, args):
        now = self.clock()
        wave = (now % 60) / 60
        big = self.profile == "mt6000"  # 메모리 1GB, 저장 공간 8GB eMMC
        total = 1073741824 if big else 536870912
        available = int((800e6 if big else 290e6) + 10e6 * wave)
        return {
            "localtime": int(time.time()), "uptime": self._uptime(),
            "load": [int((0.1 + 0.4 * wave) * 65536), 9830, 6553],
            "memory": {"total": total, "free": available - 64000000, "shared": 1200000,
                       "buffered": 4000000, "available": available, "cached": 60000000},
            "root": {"total": 7340032, "free": 7300000, "used": 40032, "avail": 7280000} if big
            else {"total": 229376, "free": 210000, "used": 19376, "avail": 205000},
            "tmp": {"total": 262144, "free": 260000, "used": 2144, "avail": 260000},
            "swap": {"total": 0, "free": 0},
        }

    def system_board(self, sid, args):
        system = next((s for s in self.running["system"] if s[".type"] == "system"), {})
        return {
            "kernel": "6.6.73", "hostname": system.get("hostname", "OpenWrt"),
            "system": "ARMv8 Processor rev 4", "model": PROFILES[self.profile],
            "board_name": {"mt3000": "glinet,gl-mt3000", "mt6000": "glinet,gl-mt6000"}.get(self.profile, "example," + self.profile),
            "rootfs_type": "squashfs",
            "release": {"distribution": "OpenWrt", "version": "25.12.6", "revision": "r33311-981c978eff",
                        "target": "mediatek/filogic", "description": "OpenWrt 25.12.6 r33311-981c978eff"},
        }

    def _iface(self, sec):
        name = sec[".name"]
        proto = sec.get("proto", "none")
        now = self.clock()
        since = self.up_since.get(name, self.started - 3700)
        st = {"interface": name, "up": False, "pending": False, "available": True,
              "autostart": sec.get("auto") != "0", "dynamic": False, "proto": proto,
              "device": sec.get("device"), "data": {},
              "ipv4-address": [], "ipv6-address": [], "ipv6-prefix": [], "ipv6-prefix-assignment": [],
              "route": [], "dns-server": [], "dns-search": [], "neighbors": [], "inactive": {}}
        if sec.get("disabled") == "1" or sec.get("auto") == "0" or name in self.iface_down:
            return st
        if now < since:  # 적용 직후 재연결 중
            st["pending"] = True
            return st
        st["up"] = True
        st["uptime"] = int(now - since)
        st["l3_device"] = "pppoe-" + name if proto == "pppoe" else sec.get("device")
        dns = as_list(sec.get("dns"))
        if proto == "static":
            for addr in as_list(sec.get("ipaddr")):
                ip, _, plen = addr.partition("/")
                st["ipv4-address"].append({"address": ip, "mask": int(plen) if plen else
                                           mask_to_prefix(sec.get("netmask", "255.255.255.0"))})
            if sec.get("gateway"):
                st["route"].append({"target": "0.0.0.0", "mask": 0, "nexthop": sec["gateway"], "source": "0.0.0.0/0"})
            st["dns-server"] = dns
        elif proto == "dhcp":
            st["ipv4-address"].append({"address": "203.0.113.25", "mask": 24})
            st["route"].append({"target": "0.0.0.0", "mask": 0, "nexthop": "203.0.113.1", "source": "203.0.113.25/32"})
            st["dns-server"] = dns if sec.get("peerdns") == "0" else ["1.1.1.1", "8.8.8.8"] + dns
            st["data"] = {"leasetime": 86400}
        elif proto == "pppoe":
            if not sec.get("username") or not sec.get("password"):
                st["up"], st["pending"] = False, True  # 인증 실패로 재시도 중
                st.pop("uptime")
                return st
            st["ipv4-address"].append({"address": "100.64.12.34", "mask": 32})
            st["route"].append({"target": "0.0.0.0", "mask": 0, "nexthop": "100.64.0.1", "source": "0.0.0.0/0"})
            st["dns-server"] = dns if sec.get("peerdns") == "0" else ["168.126.63.1", "168.126.63.2"] + dns
        elif proto == "dhcpv6":
            st["ipv6-address"].append({"address": "2001:db8:1::25", "mask": 128})
        elif proto == "none":
            st["up"] = False
            st.pop("uptime")
        return st

    def _radio_of_ifname(self, ifname):
        """'phy1-ap0' -> radio1 설정 섹션 (wireless_status가 붙이는 이름 규칙과 같다)."""
        m = re.match(r"^phy(\d+)-(?:ap|mesh)\d+$", str(ifname or ""))
        return find_section(self.running["wireless"], "radio" + m.group(1)) if m else None

    def iw_txpowerlist(self, sid, args):
        radio = self._radio_of_ifname(args.get("device"))
        if radio is None:
            raise Status(UBUS_NOT_FOUND)
        top = 30 if radio.get("country") in ("US", "CA", "AU") else 23  # 국가에 따라 한도가 다른 흉내
        cur = int(radio.get("txpower") or top)
        return {"results": [{"dbm": d, "mw": round(10 ** (d / 10)), "active": d == min(cur, top)} for d in range(0, top + 1)]}

    def wireless_status_web(self, sid, args):
        raise Status(UBUS_INVALID_ARGUMENT)

    def _live_ifaces(self):
        """실행 중인 무선 장치: ifname -> (radio 섹션, iface 설정)"""
        out = {}
        for name, r in self.wireless_status(None, {}).items():
            radio = find_section(self.running["wireless"], name)
            for i in r["interfaces"]:
                if i.get("ifname"):
                    out[i["ifname"]] = (radio, i["config"])
        return out

    def iw_devices(self, sid, args):
        return {"devices": sorted(self._live_ifaces())}

    def iw_phyname(self, sid, args):
        sec = args.get("section")
        radio = find_section(self.running["wireless"], sec) if isinstance(sec, str) else None
        if radio is None or radio[".type"] != "wifi-device":
            raise Status(UBUS_NOT_FOUND)
        return {"phyname": "phy" + sec[-1]}

    def iw_info(self, sid, args):
        live = self._live_ifaces().get(args.get("device"))
        if live is None:
            raise Status(UBUS_NOT_FOUND)
        radio, cfg = live
        band = radio.get("band")
        # 실제 iwinfo info처럼 장치가 지원하는 모드/대역폭 목록도 준다
        hw = {"2g": (["b", "g", "n", "ax"], ["HT20", "HT40", "HE20", "HE40"]),
              "5g": (["a", "n", "ac", "ax"], ["HT20", "HT40", "VHT20", "VHT40", "VHT80", "VHT160",
                                             "HE20", "HE40", "HE80", "HE160"]),
              "6g": (["ax", "be"], ["HE20", "HE40", "HE80", "HE160", "EHT20", "EHT40", "EHT80", "EHT160", "EHT320"])}
        hwmodes, htmodes = hw.get(band, ([], []))
        channel = int(radio.get("channel") if str(radio.get("channel", "")).isdigit() else (36 if band == "5g" else 1))
        base = {"2g": 2407, "5g": 5000, "6g": 5950}.get(band, 2407)
        enc = str(cfg.get("encryption") or "none").split("+")[0]
        wpa = {"psk2": ([2], ["psk"]), "sae-mixed": ([2, 3], ["psk", "sae"]), "sae": ([3], ["sae"])}.get(enc)
        ifname = args.get("device")
        mesh = cfg.get("mode") == "mesh"
        return {"phy": "phy" + radio[".name"][-1], "ssid": cfg.get("mesh_id") if mesh else cfg.get("ssid"),
                "mode": "Mesh Point" if mesh else "Master",
                "bssid": "94:83:C4:CA:E%d:F%d" % (int(radio[".name"][-1]), int(ifname[-1])),
                "hwmodes": hwmodes, "htmodes": htmodes, "hardware": {"name": "MediaTek MT7986"},
                "country": radio.get("country") or "00", "txpower": int(radio.get("txpower") or 23),
                "channel": channel, "frequency": base + channel * 5,
                "bitrate": 1264700 if band == "5g" else 143400, "signal": -52, "noise": -92, "quality": 58, "quality_max": 70,
                "encryption": {"enabled": True, "wpa": wpa[0], "authentication": wpa[1], "ciphers": ["ccmp"]} if wpa else {"enabled": False}}

    def iface_updown(self, name, up):
        if up:
            self.iface_down.discard(name)
            self.up_since[name] = self.clock() + 2  # 2초 뒤 다시 연결됨
        else:
            self.iface_down.add(name)

    def device_status(self, sid, args):
        """network.device status 흉내: 설정에 나오는 장치들 (브리지, 포트, VLAN)."""
        net = self.running["network"]
        t = self.clock() - self.started + 3700
        stats = lambda k: {"rx_bytes": int(k * t * 9000), "tx_bytes": int(k * t * 2100),
                           "rx_packets": int(k * t * 9), "tx_packets": int(k * t * 4)}
        devs = {}

        fast = {"mt6000": {"lan1"}}.get(self.profile, set())  # 2.5Gbps 포트

        def port(name, speed="1000F", k=1.0):
            if name in fast:
                speed = "2500F"
            devs.setdefault(name, {"external": False, "present": True, "type": "Network device", "up": True,
                                   "carrier": True, "speed": speed, "mtu": 1500,
                                   "macaddr": "94:83:c4:%02x:%02x:%02x" % (len(name), len(devs), 0x31),
                                   "statistics": stats(k)})

        for s in net:
            if s[".type"] == "device" and s.get("type") == "bridge":
                members = as_list(s.get("ports"))
                for p in members:
                    port(p)
                devs[s["name"]] = {"external": False, "present": True, "type": "bridge", "devtype": "bridge",
                                   "up": True, "carrier": True, "mtu": 1500, "macaddr": "94:83:c4:00:00:01",
                                   "bridge-members": members,
                                   "bridge-attributes": {"vlan_filtering": any(
                                       v[".type"] == "bridge-vlan" and v.get("device") == s["name"] for v in net)},
                                   "statistics": stats(1.2)}
            elif s[".type"] == "switch_vlan":
                # swconfig: CPU 포트 장치(eth0)와 VLAN마다 eth0.<VID>
                port("eth0", "1000F", 4)
                vid = s.get("vid") or s.get("vlan")
                devs["eth0." + str(vid)] = {"external": False, "present": True, "type": "VLAN", "devtype": "vlan",
                                            "up": True, "carrier": True, "mtu": 1500, "macaddr": "94:83:c4:00:00:04",
                                            "parent": "eth0", "vid": int(vid), "statistics": stats(1)}
            elif s[".type"] == "device" and s.get("type") == "8021q":
                port(s.get("ifname", "eth1"), "2500F", 3)
                devs[s["name"]] = {"external": False, "present": True, "type": "VLAN", "devtype": "vlan", "up": True,
                                   "carrier": True, "mtu": 1500, "macaddr": "94:83:c4:00:00:02", "statistics": stats(3)}
        for s in net:
            if s[".type"] == "interface" and s.get("device") and s[".name"] != "loopback":
                dev = s["device"]
                if dev not in devs:
                    if "." in dev:
                        devs[dev] = {"external": False, "present": True, "type": "VLAN", "devtype": "vlan", "up": True,
                                     "carrier": True, "mtu": 1500, "macaddr": "94:83:c4:00:00:03", "statistics": stats(0.3)}
                    else:
                        port(dev, "2500F" if s[".name"].startswith("wan") else "1000F", 3)
        name = args.get("name")
        if name:
            if name not in devs:
                raise Status(UBUS_NOT_FOUND)
            return devs[name]
        return devs

    def iface_dump(self, sid, args):
        return {"interface": [self._iface(s) for s in self.running["network"] if s[".type"] == "interface"]}

    def wireless_status(self, sid, args):
        sections = self.running["wireless"]
        out = {}
        for radio in (s for s in sections if s[".type"] == "wifi-device"):
            disabled = radio.get("disabled") == "1"
            ifaces = []
            counts = {}  # 실제 OpenWrt처럼 종류별로 번호를 붙인다 (phy1-ap0, phy1-ap1, phy1-mesh0)
            for iface in (s for s in sections
                          if s[".type"] == "wifi-iface" and s.get("device") == radio[".name"]
                          and s.get("disabled") != "1"):
                cfg = options_of(iface)
                cfg["network"] = as_list(cfg.get("network"))
                cfg.setdefault("mode", "ap")
                entry = {"section": iface[".name"], "config": cfg, "vlans": [], "stations": []}
                kind = "mesh" if cfg["mode"] == "mesh" else "ap"
                n = counts[kind] = counts.get(kind, -1) + 1
                if not disabled:
                    entry["ifname"] = "phy%s-%s%d" % (radio[".name"][-1], kind, n)
                ifaces.append(entry)
            out[radio[".name"]] = {"up": not disabled, "pending": False, "autostart": True,
                                   "disabled": disabled, "retry_setup_failed": False,
                                   "config": options_of(radio), "interfaces": ifaces}
        return out

    def _leases(self):
        lan = find_section(self.running["network"], "lan") or {}
        # 내부 IP 대역을 바꾸면 기기 주소도 그 대역으로 보이게 한다.
        addrs = as_list(lan.get("ipaddr")) or ["192.168.1.1"]
        base = addrs[0].split("/")[0].rsplit(".", 1)[0]
        expiry = int(time.time()) + 43200
        rows = [("a4:83:e7:12:34:56", 101, "my-iphone", "01:a4:83:e7:12:34:56"),
                ("3c:22:fb:aa:bb:cc", 102, "macbook-pro", "*"),
                ("f0:18:98:de:f0:12", 103, "*", "*"),
                ("b8:27:eb:11:22:33", 104, "living-tv", "*")]
        if self._mesh_on():
            rows += [(lan, int(ip), name, "*") for _, _, _, _, lan, ip, name in self.MESH_NODES if name]
        return "".join(f"{expiry} {mac} {base}.{n} {name} {cid}\n" for mac, n, name, cid in rows)

    # 가짜 기기들이 어디에 붙어 있는지: 무선(대역) 또는 유선(브리지 구성원 순번, -1 = 마지막)
    CLIENT_PLACES = {"a4:83:e7:12:34:56": ("wifi", "5g"), "3c:22:fb:aa:bb:cc": ("wired", 0),
                     "f0:18:98:de:f0:12": ("wifi", "2g"), "b8:27:eb:11:22:33": ("wired", -1)}

    def _bridges(self):
        return {n: d["bridge-members"] for n, d in self.device_status(None, {}).items() if d.get("bridge-members")}

    def iw_assoclist(self, sid, args):
        radio = self._radio_of_ifname(args.get("device"))
        if radio is None:
            raise Status(UBUS_NOT_FOUND)
        bands = {r.get("band") for r in self.running["wireless"] if r[".type"] == "wifi-device"}
        band = radio.get("band")
        out = []
        if "-mesh" in str(args.get("device")):  # 메시: 직접 연결된 이웃 공유기 (MESH_NODES)
            return {"results": [{"mac": mac.upper(), "signal": sig, "signal_avg": sig, "noise": -95, "inactive": 40,
                                 "connected_time": 7260, "mesh plink": "ESTAB",
                                 "rx": {"rate": rate, "mhz": 80, "vht": True, "mcs": 9, "nss": 2},
                                 "tx": {"rate": rate * 9 // 10, "mhz": 80, "vht": True, "mcs": 8, "nss": 2}}
                                for mac, via, sig, rate, *_ in self.MESH_NODES if via is None]}
        if not str(args.get("device")).endswith("-ap0"):  # 가짜 기기는 대역의 첫 번째 무선에만 붙어 있다
            return {"results": out}
        rate = {"rate": 1729600, "mhz": 160, "he": True, "mcs": 8, "nss": 2} if band != "2g" else \
            {"rate": 72200, "mhz": 20, "ht": True, "mcs": 7, "short_gi": True}
        for mac, (kind, where) in self.CLIENT_PLACES.items():
            # 그 대역이 없는 공유기면 2.4GHz에 붙인다
            if mac not in self.kicked and kind == "wifi" and (where == band or (where not in bands and band == "2g")):
                out.append({"mac": mac.upper(), "signal": -48, "signal_avg": -48, "noise": -95, "inactive": 120,
                            "connected_time": 5400, "rx": dict(rate), "tx": dict(rate, rate=rate["rate"] // 2)})
        return {"results": out}

    def hostapd_del_client(self, sid, args):
        if not isinstance(args.get("addr"), str):
            raise Status(UBUS_INVALID_ARGUMENT)
        self.kicked.add(args["addr"].lower())

    # 실기기 GL-MT3000의 LED (트리거 목록은 실제 커널 것 일부)
    LEDS = ["blue:run", "white:system", "mt76-phy0", "mt76-phy1"]
    LED_TRIGGERS = "none kbd-scrolllock timer heartbeat default-on netdev phy0rx phy0tx phy0assoc phy0radio phy0tpt phy1tpt"

    def _led_trigger(self, name):
        if name not in self.LEDS:
            return None
        sec = next((s for s in self.running["system"] if s[".type"] == "led" and s.get("sysfs") == name), None)
        cur = (sec.get("trigger") if sec else None) or ("default-on" if name == "white:system" else
                                                       "phy0tpt" if name == "mt76-phy0" else "phy1tpt" if name == "mt76-phy1" else "none")
        return " ".join(f"[{t}]" if t == cur else t for t in self.LED_TRIGGERS.split()) + "\n"

    def _sysfs(self, path):
        """브리지 MAC 학습표와 포트 번호 (/sys/class/net/<브리지>/...), LED 트리거"""
        m = re.match(r"^/sys/class/leds/([^/]+)/trigger$", path)
        if m:
            return self._led_trigger(m.group(1))
        m = re.match(r"^/sys/class/net/([^/]+)/brif/([^/]+)/port_no$", path)
        if m:
            members = self._bridges().get(m.group(1), [])
            if m.group(2) not in members:
                return None
            return "0x%x\n" % (members.index(m.group(2)) + 1)
        m = re.match(r"^/sys/class/net/([^/]+)/brforward$", path)
        if m:
            members = self._bridges().get(m.group(1))
            if not members:
                return None
            data = b""
            entry = lambda mac, port, local: (bytes(int(x, 16) for x in mac.split(":"))
                                              + bytes([port & 0xFF, local]) + b"\x00\x00\x00\x00" + bytes([port >> 8, 0]) + b"\x00\x00")
            data += entry("94:83:c4:00:00:01", 1, 1)  # 공유기 자신
            for mac, (kind, where) in self.CLIENT_PLACES.items():
                if kind == "wired":
                    data += entry(mac, (where % len(members)) + 1, 0)
            return data
        return None

    @staticmethod
    def _realpath(path):
        """링크를 푼 실제 경로.
        /sys/class/net/<장치>는 /sys/devices/virtual/net/<장치>, brif/<포트>/port_no는 <포트>/brport/port_no."""
        m = re.match(r"^/sys/class/net/([^/]+)/brif/([^/]+)/port_no$", path)
        if m:
            return f"/sys/devices/virtual/net/{m.group(2)}/brport/port_no"
        m = re.match(r"^/sys/class/leds/([^/]+)/(.*)$", path)
        if m:
            return f"/sys/devices/platform/leds/leds/{m.group(1)}/{m.group(2)}"
        m = re.match(r"^/sys/class/net/([^/]+)/(.*)$", path)
        if m:
            return f"/sys/devices/virtual/net/{m.group(1)}/{m.group(2)}"
        return path

    def _file_ok(self, sid, path, op):
        """실제 rpcd: 요청한 경로와 링크를 푼 실제 경로를 둘 다 file ACL로 검사한다 (25.12.6 확인)."""
        return self._allowed(sid, "file", path, op) and self._allowed(sid, "file", self._realpath(path), op)

    # LuCI 앱이 설치하는 메뉴 정의 (/usr/share/luci/menu.d). --no-packages면 LuCI가 없는 공유기처럼 디렉터리 자체가 없다.
    # tailscale은 uci 설정이 없어 화면에서 숨겨져야 한다 (depends.uci).
    LUCI_MENU = {
        "luci-base.json": {"admin/services": {"title": "Services", "order": 40, "action": {"type": "firstchild"}},
                           "admin/system/system": {"title": "System", "order": 1, "action": {"type": "view", "path": "system/system"}}},
        "luci-app-ddns.json": {"admin/services/ddns": {"title": "Dynamic DNS", "order": 59,
                                                       "action": {"type": "view", "path": "ddns/overview"},
                                                       "depends": {"acl": ["luci-app-ddns"], "uci": {"ddns": True}}}},
        "luci-app-upnp.json": {"admin/services/upnp": {"title": "UPnP IGD & PCP", "order": 50,
                                                       "action": {"type": "view", "path": "upnp/upnp"}},
                               "admin/status/upnp": {"title": "UPnP", "action": {"type": "view", "path": "upnp/status"}}},
        "luci-app-tailscale.json": {"admin/services/tailscale": {"title": "Tailscale", "order": 90,
                                                                 "action": {"type": "view", "path": "tailscale/setting"},
                                                                 "depends": {"uci": {"tailscale": True}}}},
    }
    LUCI_MENU_DIR = "/usr/share/luci/menu.d"

    def file_list(self, sid, args):
        path = args.get("path")
        if not isinstance(path, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._file_ok(sid, path, "list"):
            raise Status(UBUS_PERMISSION_DENIED)
        if path.rstrip("/") == "/sys/class/leds":
            return {"entries": [{"name": n, "type": "symlink"} for n in self.LEDS]}
        if path.rstrip("/") == self.APK_KEYS:
            names = sorted(p.rsplit("/", 1)[1] for p in self.files if p.startswith(self.APK_KEYS + "/"))
            return {"entries": [{"name": n, "type": "file"} for n in names]}
        if path.rstrip("/") == "/etc/rc.d":
            starts = {"igmpproxy": "S99igmpproxy"}
            names = ["S10boot", "S19firewall", "S20network", "S50uhttpd"]
            names += [starts[n] for n in sorted(getattr(self, "rc_enabled", set())) if n in starts]
            return {"entries": [{"name": n, "type": "symlink"} for n in sorted(names)]}
        if path.rstrip("/") == self.LUCI_MENU_DIR:
            if not self.packages:
                raise Status(UBUS_NOT_FOUND)
            return {"entries": [{"name": n, "type": "file"} for n in sorted(self.LUCI_MENU)]}
        m = re.match(r"^/sys/class/net/([^/]+)/brif$", path)
        members = self._bridges().get(m.group(1)) if m else None
        if members is None:
            raise Status(UBUS_NOT_FOUND)
        return {"entries": [{"name": n, "type": "symlink"} for n in members]}

    SSH_KEYS = "/etc/dropbear/authorized_keys"
    APK_KEYS = "/etc/apk/keys"

    def file_remove(self, sid, args):
        path = args.get("path")
        if not isinstance(path, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._file_ok(sid, path, "write"):
            raise Status(UBUS_PERMISSION_DENIED)
        if path not in self.files:
            raise Status(UBUS_NOT_FOUND)
        del self.files[path]
        return None

    def file_write(self, sid, args):
        path, data = args.get("path"), args.get("data")
        if not isinstance(path, str) or not isinstance(data, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._file_ok(sid, path, "write"):
            raise Status(UBUS_PERMISSION_DENIED)
        self.files[path] = data.encode()
        return None

    def file_read(self, sid, args):
        path = args.get("path")
        if not isinstance(path, str):
            raise Status(UBUS_INVALID_ARGUMENT)
        if not self._file_ok(sid, path, "read"):
            raise Status(UBUS_PERMISSION_DENIED)
        files = {"/tmp/dhcp.leases": self._leases, "/lib/apk/db/installed": self._apk_db,
                 "/etc/board.json": lambda: json.dumps(profile_board(self.profile), indent=1)}
        if self.packages:
            for name, menu in self.LUCI_MENU.items():
                files[f"{self.LUCI_MENU_DIR}/{name}"] = (lambda m=menu: json.dumps(m, indent=1))
        if "banip" in self.committed:
            files["/etc/banip/banip.countries"] = lambda: self.BANIP_COUNTRIES
            if getattr(self, "banip_status", None):
                files["/var/run/banIP/banIP.runtime.json"] = lambda: json.dumps(self.banip_status)
        if path.startswith(self.APK_KEYS + "/"):
            if path not in self.files:
                raise Status(UBUS_NOT_FOUND)
            return {"data": self.files[path].decode()}
        if path == "/var/run/miniupnpd.leases" and getattr(self, "upnp_running", False):
            files[path] = lambda: ("UDP:3074:192.168.1.104:3074:0:Xbox (3074) UDP\n"
                                   "TCP:51413:192.168.1.103:51413:0:Transmission at 51413\n")
        files["/proc/net/arp"] = self._arp
        if path in (self.SSH_KEYS, "/etc/crontabs/root", "/etc/wrttime-mesh.json"):  # 저장한 적이 없으면 파일이 없다
            if path not in self.files:
                raise Status(UBUS_NOT_FOUND)
            return {"data": self.files[path].decode()}
        data = files[path]() if path in files else self._sysfs(path)
        if data is None:
            raise Status(UBUS_NOT_FOUND)
        if args.get("base64"):
            import base64
            return {"data": base64.b64encode(data if isinstance(data, bytes) else data.encode()).decode()}
        return {"data": data if isinstance(data, str) else data.decode("latin-1")}


def default_acl_files(base):
    return sorted(glob.glob(os.path.join(base, "rootfs", "usr", "share", "rpcd", "acl.d", "*.json")))
