"""가짜 ubus 테스트. 실행: python3 -m unittest discover -s tests (프로젝트 폴더에서)"""
import http.client
import http.server
import json
import os
import sys
import threading
import unittest
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "tools"))
sys.path.insert(0, BASE)

import fakeubus  # noqa: E402
from fakeubus import NULL_SID  # noqa: E402

# 2단계에서 쓸 법한 쓰기 권한. 실제 ACL 파일은 아직 읽기 전용이므로 테스트에서만 더한다.
# 같은 파일을 openwrt-sandbox.sh --acl 로도 쓴다.
UCI_ACL_FILE = os.path.join(BASE, "tests", "acl-uci-test.json")


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class Base(unittest.TestCase):
    extra_acl = None

    def setUp(self):
        self.clock = Clock()
        files = fakeubus.default_acl_files(BASE)
        if self.extra_acl:
            files.append(self.extra_acl)
        self.fake = fakeubus.FakeUbus(acl_files=files, password="pw", apply_delay=2,
                                      clock=self.clock, log=lambda *a: None)

    def raw(self, sid, obj, method, args=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "call",
                           "params": [sid, obj, method, args or {}]})
        return self.fake.handle(body.encode())

    def call(self, sid, obj, method, args=None):
        """정상 응답이면 [코드, 데이터?], JSON-RPC 오류면 ('error', 코드)."""
        res = self.raw(sid, obj, method, args)
        if "error" in res:
            return ("error", res["error"]["code"])
        return res["result"]

    def login(self, password="pw", timeout=3600):
        res = self.call(NULL_SID, "session", "login",
                        {"username": "root", "password": password, "timeout": timeout})
        self.assertEqual(res[0], 0)
        return res[1]["ubus_rpc_session"]

    def wan(self, sid):
        dump = self.call(sid, "network.interface", "dump")[1]
        return next(i for i in dump["interface"] if i["interface"] == "wan")


class SessionAndAcl(Base):
    def test_login(self):
        self.assertEqual(self.call(NULL_SID, "session", "login", {"username": "root", "password": "x"}), [6])
        self.assertEqual(self.call(NULL_SID, "session", "login", {"username": "admin", "password": "pw"}), [6])
        self.assertEqual(len(self.login()), 32)

    def test_empty_root_password_accepts_anything(self):
        self.fake.password = ""  # 순정 OpenWrt처럼 비밀번호 미설정
        for pw in ("", "아무거나"):
            res = self.call(NULL_SID, "session", "login", {"username": "root", "password": pw})
            self.assertEqual(res[0], 0)

    def test_dashboard_calls_allowed_by_easyui_acl(self):
        sid = self.login()
        for obj, method, args in [("system", "info", {}), ("system", "board", {}),
                                  ("network.interface", "dump", {}), ("iwinfo", "devices", {}),
                                  ("iwinfo", "phyname", {"section": "radio0"}),
                                  ("iwinfo", "info", {"device": "phy0-ap0"}),
                                  ("file", "read", {"path": "/tmp/dhcp.leases"}),
                                  ("file", "read", {"path": "/etc/board.json"})]:
            res = self.call(sid, obj, method, args)
            self.assertEqual(res[0], 0, (obj, method, res))
        leases = self.call(sid, "file", "read", {"path": "/tmp/dhcp.leases"})[1]["data"]
        self.assertEqual(len(leases.strip().split("\n")), 4)
        # 실기기(25.12.6)처럼 웹에서는 network.wireless status가 [2]
        self.assertEqual(self.call(sid, "network.wireless", "status"), [2])
        self.assertEqual(self.call(sid, "iwinfo", "devices")[1]["devices"], ["phy0-ap0", "phy1-ap0"])
        self.assertEqual(self.call(sid, "iwinfo", "info", {"device": "phy1-ap0"})[1]["ssid"], "MyHome-5G")

    def test_acl_denials_look_like_uhttpd(self):
        # 비로그인 세션으로 일반 객체 호출 -> uhttpd가 JSON-RPC 오류로 거부
        self.assertEqual(self.call(NULL_SID, "system", "info"), ("error", -32002))
        sid = self.login()
        # ubus 범위에 없는 메서드 (UI는 commit 대신 apply를 쓴다)
        self.assertEqual(self.call(sid, "uci", "commit", {"config": "network"}), ("error", -32002))
        # uci 범위에 없는 설정
        self.assertEqual(self.call(sid, "uci", "get", {"config": "luci"}), [6])
        # file 범위에 없는 경로 -> rpcd file 플러그인이 상태 코드 6으로 거부
        self.assertEqual(self.call(sid, "file", "read", {"path": "/etc/shadow"}), [6])

    def test_easyui_acl_allows_ui_apply_flow(self):
        """app.js의 applyUci가 하는 호출 순서가 배포용 ACL만으로 되는지."""
        sid = self.login()
        self.assertEqual(self.call(sid, "uci", "revert", {"config": "network"}), [0])
        self.assertEqual(self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {
            "proto": "pppoe", "username": "u", "password": "p", "ipaddr": "", "netmask": "", "gateway": "",
            "dns": "", "peerdns": ""}}), [0])
        # 없는 옵션에 ''를 준 것은 변경으로 남지 않는다 (실제 rpcd와 같음)
        self.assertEqual(self.call(sid, "uci", "changes", {"config": "network"})[1]["changes"], [
            ["set", "wan", "proto", "pppoe"], ["set", "wan", "username", "u"], ["set", "wan", "password", "p"]])
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        self.assertTrue(self.wan(sid)["up"])
        self.assertEqual(self.wan(sid)["proto"], "pppoe")

    def test_ui_feature_calls_allowed_by_easyui_acl(self):
        """2~4단계 화면들이 쓰는 호출이 배포용 ACL만으로 되는지."""
        sid = self.login()
        for cfg in ("network", "dhcp", "wireless", "firewall", "system", "ddns", "sqm"):
            self.assertEqual(self.call(sid, "uci", "get", {"config": cfg})[0], 0, cfg)
        self.assertEqual(self.call(sid, "uci", "add", {"config": "firewall", "type": "redirect", "values": {
            "name": "game", "src": "wan", "dest": "lan", "target": "DNAT", "proto": ["tcp", "udp"],
            "src_dport": "8080", "dest_ip": "192.168.1.50"}})[0], 0)
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        self.assertEqual(self.call(sid, "log", "read", {"lines": 2})[0], 0)
        self.assertEqual(len(self.call(sid, "log", "read", {"lines": 2})[1]["log"]), 2)
        self.assertEqual(self.call(sid, "file", "exec", {"command": "/bin/sh", "params": ["-c", "id"]}), [6])

    def test_luci_service_menu_readable(self):
        """추가 기능: LuCI 메뉴 정의(menu.d)를 배포용 ACL로 읽을 수 있고, 그 밖의 /usr/share는 안 된다."""
        sid = self.login()
        names = [e["name"] for e in self.call(sid, "file", "list", {"path": "/usr/share/luci/menu.d"})[1]["entries"]]
        self.assertIn("luci-app-ddns.json", names)
        menu = json.loads(self.call(sid, "file", "read", {"path": "/usr/share/luci/menu.d/luci-app-ddns.json"})[1]["data"])
        self.assertEqual(menu["admin/services/ddns"]["depends"]["uci"], {"ddns": True})
        self.assertEqual(self.call(sid, "file", "read", {"path": "/usr/share/rpcd/acl.d/luci-base.json"}), [6])
        self.assertEqual(self.call(sid, "file", "list", {"path": "/usr/share/luci"}), [6])

    def test_apk_acl(self):
        """소프트웨어 관리: 배포용 ACL로 apk의 정해진 명령만 실행된다."""
        sid = self.login()
        apk = lambda *p: self.call(sid, "file", "exec", {"command": "/usr/bin/apk", "params": list(p)})
        self.assertIn("P:busybox", self.call(sid, "file", "read", {"path": "/lib/apk/db/installed"})[1]["data"])
        self.assertIn("tcpdump-", apk("list", "--available", "*tcp*")[1]["stdout"])
        self.assertIn("tcpdump-4.99.5-r1 - Network monitoring", apk("search", "-v", "*tcp*")[1]["stdout"])
        self.assertEqual(apk("search", "--description", "*tcp*"), [6])
        self.assertIn("upgradable from", apk("list", "--upgradable")[1]["stdout"])
        self.assertEqual(apk("add", "tcpdump")[1]["code"], 0)
        self.assertIn("P:tcpdump", self.call(sid, "file", "read", {"path": "/lib/apk/db/installed"})[1]["data"])
        self.assertEqual(apk("del", "tcpdump")[1]["code"], 0)
        self.assertEqual(apk("update")[1]["code"], 0)
        # 정해진 하위 명령 말고는 거부 (예: apk fix, apk cache)
        self.assertEqual(apk("fix"), [6])
        self.assertEqual(apk("update", "--force"), [6])

    def test_igmpproxy_acl(self):
        """IPTV / 멀티캐스트: 설치 후 igmpproxy 설정과 서비스 제어가 배포용 ACL로 된다."""
        sid = self.login()
        rc = lambda: [e["name"] for e in self.call(sid, "file", "list", {"path": "/etc/rc.d"})[1]["entries"]]
        init = lambda a: self.call(sid, "file", "exec", {"command": "/etc/init.d/igmpproxy", "params": [a]})
        self.assertNotIn("igmpproxy", self.call(sid, "uci", "configs")[1]["configs"])
        self.assertEqual(self.call(sid, "file", "exec", {"command": "/usr/bin/apk", "params": ["add", "igmpproxy"]})[1]["code"], 0)
        self.assertEqual(self.call(sid, "uci", "get", {"config": "igmpproxy"})[0], 0)
        self.assertIn("S99igmpproxy", rc())
        for a in ("stop", "disable"):
            self.assertEqual(init(a)[1]["code"], 0)
        self.assertNotIn("S99igmpproxy", rc())
        self.assertEqual(init("enable")[1]["code"], 0)
        self.assertEqual(init("restart")[1]["code"], 0)
        self.assertIn("S99igmpproxy", rc())
        self.assertEqual(init("reload"), [6])  # 정해진 동작 말고는 거부

    def test_diagnostics_acl(self):
        """네트워크 진단: 화면이 쓰는 옵션 모양만 실행되고, 없는 위치는 [4]로 알려 준다."""
        sid = self.login()
        ex = lambda cmd, *p: self.call(sid, "file", "exec", {"command": cmd, "params": list(p)})
        r = ex("/bin/ping", "-c", "4", "-W", "2", "-4", "8.8.8.8")
        self.assertEqual(r[1]["code"], 0)
        self.assertIn("4 packets received", r[1]["stdout"])
        self.assertEqual(ex("/usr/bin/ping", "-c", "4", "-W", "2", "-4", "8.8.8.8"), [4])  # 이 공유기에는 없는 위치
        self.assertEqual(ex("/usr/bin/traceroute", "-n", "-q", "1", "-w", "2", "-m", "20", "-6", "google.com")[1]["code"], 0)
        self.assertEqual(ex("/usr/bin/nslookup", "naver.com")[1]["code"], 0)
        self.assertEqual(ex("/bin/ping", "-f", "8.8.8.8"), [6])  # 다른 옵션은 거부
        self.assertEqual(ex("/bin/ping", "8.8.8.8"), [6])

    def test_upnp_and_cron_acl(self):
        """UPnP 설치/설정/서비스 제어와 예약 재시작(crontab) 저장이 배포용 ACL로 된다."""
        sid = self.login()
        ex = lambda cmd, *p: self.call(sid, "file", "exec", {"command": cmd, "params": list(p)})
        self.assertEqual(ex("/usr/bin/apk", "add", "miniupnpd-nftables")[1]["code"], 0)
        self.assertEqual(self.call(sid, "uci", "set", {"config": "upnpd", "section": "config", "values": {"enabled": "1"}}), [0])
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        for a in ("enable", "restart"):
            self.assertEqual(ex("/etc/init.d/miniupnpd", a)[1]["code"], 0)
        leases = self.call(sid, "file", "read", {"path": "/var/run/miniupnpd.leases"})[1]["data"]
        self.assertIn("TCP:51413:", leases)
        self.assertEqual(self.call(sid, "file", "read", {"path": "/etc/crontabs/root"}), [4])
        line = "0 4 * * 1,4 sleep 70 && touch /etc/banner && reboot # wrttime-reboot\n"
        self.assertEqual(self.call(sid, "file", "write", {"path": "/etc/crontabs/root", "data": line}), [0])
        self.assertEqual(self.call(sid, "file", "read", {"path": "/etc/crontabs/root"})[1]["data"], line)
        for a in ("enable", "restart"):
            self.assertEqual(ex("/etc/init.d/cron", a)[1]["code"], 0)
        self.assertEqual(self.call(sid, "file", "write", {"path": "/etc/crontabs/other", "data": "x"}), [6])

    def test_mesh_package_swap(self):
        """메시: wpad-basic이 있으면 wpad-mesh를 바로 설치할 수 없고, 지운 뒤에는 설치된다."""
        sid = self.login()
        apk = lambda *p: self.call(sid, "file", "exec", {"command": "/usr/bin/apk", "params": list(p)})[1]
        self.assertIn("conflicts", apk("add", "wpad-mesh-mbedtls")["stderr"])
        self.assertEqual(apk("del", "wpad-basic-mbedtls")["code"], 0)
        self.assertEqual(apk("add", "wpad-mesh-mbedtls")["code"], 0)
        self.assertIn("P:wpad-mesh-mbedtls", self.call(sid, "file", "read", {"path": "/lib/apk/db/installed"})[1]["data"])

    def test_mesh_map_acl(self):
        """메시 구성도: 경로/대리 표, ARP 표, 응답 확인, 이름 파일이 배포용 ACL로 된다."""
        sid = self.login()
        ex = lambda cmd, *p: self.call(sid, "file", "exec", {"command": cmd, "params": list(p)})
        self.assertEqual(self.call(sid, "uci", "add", {"config": "wireless", "type": "wifi-iface", "name": "wrttime_mesh",
                                                       "values": {"device": "radio1", "mode": "mesh", "mesh_id": "m",
                                                                  "encryption": "sae", "key": "meshpass123", "network": "lan"}})[0], 0)
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        mpath = ex("/usr/sbin/iw", "dev", "phy1-mesh0", "mpath", "dump")[1]
        self.assertTrue(mpath["stdout"].startswith("DEST ADDR"))
        self.assertIn("PROXY NODE", ex("/usr/sbin/iw", "dev", "phy1-mesh0", "mpp", "dump")[1]["stdout"])
        self.assertEqual(ex("/usr/sbin/iw", "dev", "phy1-mesh0", "set", "type", "managed"), [6])  # 다른 iw 명령은 거부
        self.assertIn("br-lan", self.call(sid, "file", "read", {"path": "/proc/net/arp"})[1]["data"])
        self.assertEqual(ex("/bin/ping", "-c", "1", "-W", "1", "-4", "192.168.1.2")[1]["code"], 0)
        self.assertEqual(self.call(sid, "file", "read", {"path": "/etc/wrttime-mesh.json"}), [4])
        self.assertEqual(self.call(sid, "file", "write", {"path": "/etc/wrttime-mesh.json", "data": "{}"}), [0])

    def test_led_and_packagelist_acl(self):
        """LED 설정과 업그레이드 확인이 쓰는 호출이 배포용 ACL로 되는지 (LED 트리거는 링크를 푼 실제 경로도 검사)."""
        sid = self.login()
        leds = [e["name"] for e in self.call(sid, "file", "list", {"path": "/sys/class/leds"})[1]["entries"]]
        self.assertIn("white:system", leds)
        self.assertIn("[default-on]", self.call(sid, "file", "read", {"path": "/sys/class/leds/white:system/trigger"})[1]["data"])
        self.assertEqual(self.call(sid, "file", "read", {"path": "/sys/class/leds/white:system/brightness"}), [6])
        self.assertEqual(self.call(sid, "file", "exec", {"command": "/etc/init.d/led", "params": ["restart"]})[1]["code"], 0)
        self.assertEqual(self.call(sid, "file", "exec", {"command": "/etc/init.d/led", "params": ["stop"]}), [6])
        self.assertIn("busybox", self.call(sid, "rpc-sys", "packagelist", {"all": False})[1]["packages"])

    def test_nmmwrt_update_acl(self):
        """wrtTIME 업데이트: check/install만 실행할 수 있다."""
        sid = self.login()
        run = lambda *p: self.call(sid, "file", "exec", {"command": "/usr/libexec/nmmwrt-update", "params": list(p)})
        self.assertTrue(json.loads(run("check")[1]["stdout"])["update"])
        self.assertTrue(json.loads(run("install")[1]["stdout"])["installed"])
        self.assertFalse(json.loads(run("check")[1]["stdout"])["update"])
        self.assertEqual(run("install", "--force"), [6])
        self.assertEqual(run("rm"), [6])

    def test_interfaces_and_devices(self):
        sid = self.login()
        devs = self.call(sid, "network.device", "status")[1]
        # 실기기 MT3000: LAN = br-lan(eth1), WAN = eth0
        self.assertEqual(devs["br-lan"]["bridge-members"], ["eth1"])
        self.assertIn("eth0", devs)
        self.assertEqual(self.call(sid, "network.device", "status", {"name": "nope"}), [4])
        # 인터페이스 다시 연결 (network.interface.<이름> up/down 은 배포용 ACL에 있다)
        self.assertEqual(self.call(sid, "network.interface.wan", "down"), [0])
        self.assertFalse(self.wan(sid)["up"])
        self.assertEqual(self.call(sid, "network.interface.wan", "up"), [0])
        self.clock.now += 3
        self.assertTrue(self.wan(sid)["up"])
        self.assertEqual(self.call(sid, "network.interface.nope", "up"), ("error", -32000))

    def test_vlan_ops(self):
        """vlan 화면이 하는 변경: VLAN 사용 시작 -> VLAN 20 + 별도 네트워크 'iot'."""
        sid = self.login()
        ops = [
            ("add", {"config": "network", "type": "bridge-vlan", "values": {"device": "br-lan", "vlan": "1", "ports": ["lan1:u*"]}}),
            ("set", {"config": "network", "section": "lan", "values": {"device": "br-lan.1"}}),
            ("add", {"config": "network", "type": "bridge-vlan", "values": {"device": "br-lan", "vlan": "20", "ports": ["lan1:t"]}}),
            ("add", {"config": "network", "type": "interface", "name": "iot",
                     "values": {"proto": "static", "device": "br-lan.20", "ipaddr": ["192.168.20.1/24"]}}),
            ("add", {"config": "dhcp", "type": "dhcp", "name": "iot", "values": {"interface": "iot", "start": "100"}}),
            ("add", {"config": "firewall", "type": "zone", "values": {"name": "iot", "network": ["iot"], "input": "REJECT"}}),
            ("add", {"config": "network", "type": "device", "values": {"type": "8021q", "ifname": "eth1", "vid": "100", "name": "eth1.100"}}),
            ("set", {"config": "network", "section": "wan", "values": {"device": "eth1.100"}}),
        ]
        for method, args in ops:
            self.assertEqual(self.call(sid, "uci", method, args)[0], 0, (method, args))
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 120}), [0])
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        dump = {i["interface"]: i for i in self.call(sid, "network.interface", "dump")[1]["interface"]}
        self.assertEqual(dump["iot"]["ipv4-address"][0], {"address": "192.168.20.1", "mask": 24})
        devs = self.call(sid, "network.device", "status")[1]
        self.assertTrue(devs["br-lan"]["bridge-attributes"]["vlan_filtering"])
        self.assertIn("eth1.100", devs)

    def test_wireless_advanced_and_guest(self):
        sid = self.login()
        # 무선 고급: 국가/출력 (iwinfo는 배포용 ACL에 있다)
        tx = self.call(sid, "iwinfo", "txpowerlist", {"device": "phy0-ap0"})[1]["results"]
        self.assertEqual(max(x["dbm"] for x in tx), 23)
        self.call(sid, "uci", "set", {"config": "wireless", "section": "radio0", "values": {"country": "US", "txpower": "17"}})
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 120})
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        tx = self.call(sid, "iwinfo", "txpowerlist", {"device": "phy0-ap0"})[1]["results"]
        self.assertEqual([x["dbm"] for x in tx if x["active"]], [17])
        self.assertEqual(self.call(sid, "iwinfo", "txpowerlist", {"device": "nope"}), [4])
        # 게스트 네트워크 만들기 (guest.js의 createOps와 같은 변경)
        ops = [
            ("network", "device", None, {"type": "bridge", "name": "br-guest", "bridge_empty": "1"}),
            ("network", "interface", "guest", {"proto": "static", "device": "br-guest", "ipaddr": "192.168.30.1/24"}),
            ("dhcp", "dhcp", "guest", {"interface": "guest", "start": "100"}),
            ("firewall", "zone", None, {"name": "guest", "network": ["guest"], "input": "REJECT"}),
            ("wireless", "wifi-iface", "guest_radio0", {"device": "radio0", "mode": "ap", "network": "guest",
                                                        "ssid": "MyHome-Guest", "encryption": "psk2", "key": "guestpass1", "isolate": "1"}),
        ]
        for config, type_, name, values in ops:
            args = {"config": config, "type": type_, "values": values}
            if name:
                args["name"] = name
            self.assertEqual(self.call(sid, "uci", "add", args)[0], 0, (config, type_))
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 120})
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        dump = {i["interface"]: i for i in self.call(sid, "network.interface", "dump")[1]["interface"]}
        self.assertEqual(dump["guest"]["ipv4-address"][0]["address"], "192.168.30.1")
        devs = self.call(sid, "iwinfo", "devices")[1]["devices"]
        ssids = [self.call(sid, "iwinfo", "info", {"device": d})[1]["ssid"] for d in devs]
        self.assertIn("MyHome-Guest", ssids)

    def test_reboot_drops_sessions(self):
        sid = self.login()
        self.assertEqual(self.call(sid, "system", "reboot"), [0])
        self.assertTrue(self.fake.is_down())
        self.clock.now += 21
        self.assertFalse(self.fake.is_down())
        self.assertEqual(self.call(sid, "system", "info"), ("error", -32002))

    def test_factory_reset(self):
        sid = self.login()
        name = self.fake.committed["system"][0][".name"]
        self.assertRegex(name, r"^cfg[0-9a-f]{6}$")  # 익명 섹션에도 이름이 있다
        self.assertEqual(self.call(sid, "uci", "set", {"config": "system", "section": name,
                                                       "values": {"hostname": "changed"}}), [0])
        self.call(sid, "uci", "apply")
        self.clock.now += 3
        self.assertEqual(self.call(sid, "system", "board")[1]["hostname"], "changed")
        self.assertEqual(self.call(sid, "rpc-sys", "factory"), [0])
        self.clock.now += 31
        self.assertEqual(self.fake.password, "")
        new = self.login(password="anything")
        self.assertEqual(self.call(new, "system", "board")[1]["hostname"], "OpenWrt")

    def test_firmware_and_restore(self):
        sid = self.login()
        self.assertEqual(self.call(sid, "system", "validate_firmware_image", {"path": "/tmp/firmware.bin"}), [4])
        self.fake.files["/tmp/firmware.bin"] = b"random junk"
        self.assertFalse(self.call(sid, "system", "validate_firmware_image", {"path": "/tmp/firmware.bin"})[1]["valid"])
        self.fake.files["/tmp/firmware.bin"] = b"NMMWRT-TEST-FW..."
        self.assertTrue(self.call(sid, "system", "validate_firmware_image", {"path": "/tmp/firmware.bin"})[1]["valid"])
        # 복원: 백업을 만들고 설정을 바꾼 뒤 되돌린다
        backup = self.fake.make_backup()
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {"proto": "static"}})
        self.call(sid, "uci", "apply")
        self.fake.files["/tmp/backup.tar.gz"] = backup
        cmd = {"command": "/sbin/sysupgrade", "params": ["--restore-backup", "/tmp/backup.tar.gz"]}
        self.assertEqual(self.call(sid, "file", "exec", cmd)[1]["code"], 0)
        self.assertEqual(self.fake.committed["network"][4]["proto"], "dhcp")
        self.fake.files["/tmp/backup.tar.gz"] = b"not a backup"
        self.assertEqual(self.call(sid, "file", "exec", cmd)[1]["code"], 1)

    def test_password_set(self):
        sid = self.login()
        self.assertEqual(self.call(sid, "rpc-sys", "password_set", {"user": "root", "password": "newpass123"}), [0])
        self.assertEqual(self.call(NULL_SID, "session", "login", {"username": "root", "password": "pw"}), [6])
        self.assertEqual(self.call(NULL_SID, "session", "login",
                                   {"username": "root", "password": "newpass123"})[0], 0)

    def test_broken_apply_reconnects_after_rollback(self):
        """--apply-delay를 크게 주면 적용 후 연결이 끊긴 채로 있다가 롤백 뒤 돌아온다."""
        self.fake.apply_delay = 999
        sid = self.login()
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {"proto": "static"}})
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 60})
        self.clock.now += 59
        self.assertTrue(self.fake.is_down())
        self.clock.now += 2
        self.fake.tick()
        self.clock.now += 3
        self.assertFalse(self.fake.is_down())
        self.assertEqual(self.call(sid, "uci", "confirm"), [5])

    def test_expiry_and_touch(self):
        sid = self.login(timeout=60)
        self.clock.now += 50
        self.assertEqual(self.call(sid, "system", "info")[0], 0)  # 호출하면 연장된다
        self.clock.now += 50
        self.assertEqual(self.call(sid, "system", "info")[0], 0)
        self.clock.now += 61
        self.assertEqual(self.call(sid, "system", "info"), ("error", -32002))

    def test_destroy(self):
        sid = self.login()
        self.assertEqual(self.call(sid, "session", "destroy"), [0])
        self.assertEqual(self.call(sid, "system", "info"), ("error", -32002))

    def test_jsonrpc_shapes(self):
        self.assertEqual(self.fake.handle(b"{nope")["error"]["code"], -32700)
        bad = self.fake.handle(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "call", "params": [1]}).encode())
        self.assertEqual(bad["error"]["code"], -32602)
        batch = self.fake.handle(json.dumps([
            {"jsonrpc": "2.0", "id": 1, "method": "call", "params": [NULL_SID, "system", "info", {}]},
            {"jsonrpc": "2.0", "id": 2, "method": "list", "params": ["sys*"]},
        ]).encode())
        self.assertEqual([r["id"] for r in batch], [1, 2])
        self.assertIn("system", batch[1]["result"])


class Uci(Base):
    extra_acl = UCI_ACL_FILE

    def test_unknown_object_and_method(self):
        sid = self.login()
        self.assertEqual(self.call(sid, "uci", "nosuch"), ("error", -32002))  # ACL 검사가 먼저다
        self.fake.acl.add(("ubus", "*", "*"))
        wide = self.login()
        self.assertEqual(self.call(wide, "uci", "nosuch"), [3])
        self.assertEqual(self.call(wide, "nosuch", "x"), ("error", -32000))
        self.assertEqual(self.call(sid, "uci", "get", {"config": "luci"}), [6])  # uci 범위 밖
        # 실제 rpcd: 읽기 권한과 상관없이 전체 목록
        self.assertEqual(self.call(sid, "uci", "configs")[1]["configs"],
                         ["banip", "ddns", "dhcp", "dropbear", "firewall", "network", "sqm", "system", "uhttpd", "wireless"])

    def test_get_shapes(self):
        sid = self.login()
        allv = self.call(sid, "uci", "get", {"config": "network"})[1]["values"]
        self.assertEqual(allv["lan"][".type"], "interface")
        self.assertEqual(allv["lan"][".index"], 3)
        ifaces = self.call(sid, "uci", "get", {"config": "network", "type": "interface"})[1]["values"]
        self.assertEqual(sorted(ifaces), ["lan", "loopback", "wan", "wan6"])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "wan", "option": "proto"}),
                         [0, {"value": "dhcp"}])
        # 실제 rpcd: 없는 섹션/옵션은 오류가 아니라 데이터 없는 [0]
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "nope"}), [0])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "wan", "option": "x"}), [0])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "lan", "option": "ipaddr"}),
                         [0, {"value": ["192.168.1.1/24"]}])  # 25.12 형식

    def test_staged_changes_are_per_session(self):
        a, b = self.login(), self.login()
        self.assertEqual(self.call(a, "uci", "set", {"config": "network", "section": "lan",
                                                     "values": {"ipaddr": "10.0.0.1"}}), [0])
        get = {"config": "network", "section": "lan", "option": "ipaddr"}
        self.assertEqual(self.call(a, "uci", "get", get)[1]["value"], "10.0.0.1")
        self.assertEqual(self.call(b, "uci", "get", get)[1]["value"], ["192.168.1.1/24"])
        self.assertEqual(self.call(a, "uci", "changes")[1]["changes"],
                         {"network": [["set", "lan", "ipaddr", "10.0.0.1"]]})
        self.assertEqual(self.call(b, "uci", "changes")[1]["changes"], {})

        self.assertEqual(self.call(a, "uci", "commit", {"config": "network"}), [0])
        self.assertEqual(self.call(b, "uci", "get", get)[1]["value"], "10.0.0.1")
        # commit만으로는 실행 중 상태가 바뀌지 않는다
        lan = next(i for i in self.call(a, "network.interface", "dump")[1]["interface"] if i["interface"] == "lan")
        self.assertEqual(lan["ipv4-address"][0]["address"], "192.168.1.1")

    def test_revert(self):
        sid = self.login()
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {"proto": "static"}})
        self.assertEqual(self.call(sid, "uci", "revert", {"config": "network"}), [0])
        self.assertEqual(self.call(sid, "uci", "changes", {"config": "network"})[1]["changes"], [])

    def test_add_delete_and_empty_value(self):
        sid = self.login()
        res = self.call(sid, "uci", "add", {"config": "dhcp", "type": "host",
                                            "values": {"name": "tv", "mac": "b8:27:eb:11:22:33",
                                                       "ip": "192.168.1.50"}})
        name = res[1]["section"]
        self.assertTrue(name.startswith("cfg"))
        host = self.call(sid, "uci", "get", {"config": "dhcp", "section": name})[1]["values"]
        self.assertTrue(host[".anonymous"])
        self.assertEqual(host["ip"], "192.168.1.50")

        self.call(sid, "uci", "set", {"config": "dhcp", "section": name, "values": {"ip": ""}})
        self.assertEqual(self.call(sid, "uci", "get", {"config": "dhcp", "section": name, "option": "ip"}), [0])
        self.assertEqual(self.call(sid, "uci", "delete", {"config": "dhcp", "section": name, "option": "ip"}), [4])
        self.call(sid, "uci", "delete", {"config": "dhcp", "section": name})
        self.assertEqual(self.call(sid, "uci", "get", {"config": "dhcp", "section": name}), [0])

        # 실제 rpcd: 이미 있는 이름으로 add하면 거부하지 않고 타입을 바꾼다
        self.assertEqual(self.call(sid, "uci", "add", {"config": "dhcp", "type": "host", "name": "lan"}),
                         [0, {"section": "lan"}])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "dhcp", "section": "lan"})[1]["values"][".type"],
                         "host")
        self.call(sid, "uci", "revert", {"config": "dhcp"})

        self.assertEqual(self.call(sid, "uci", "set", {"config": "network", "section": "wan",
                                                       "values": {"bad-name": "1"}}), [2])
        self.assertEqual(self.call(sid, "uci", "set", {"config": "network", "section": "wan",
                                                       "values": {"dns": ["1.1.1.1", "9.9.9.9"]}}), [0])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "wan",
                                                       "option": "dns"})[1]["value"], ["1.1.1.1", "9.9.9.9"])
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {"dns": ["8.8.8.8"]}})
        self.assertEqual(self.call(sid, "uci", "changes", {"config": "network"})[1]["changes"], [
            ["list-add", "wan", "dns", "1.1.1.1"], ["list-add", "wan", "dns", "9.9.9.9"],
            ["remove", "wan", "dns"], ["list-add", "wan", "dns", "8.8.8.8"]])
        self.assertEqual(self.call(sid, "uci", "get", {"config": "network", "section": "wan",
                                                       "option": "dns"})[1]["value"], ["8.8.8.8"])

    def static_wan(self, sid):
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {
            "proto": "static", "ipaddr": "198.51.100.7", "netmask": "255.255.255.0",
            "gateway": "198.51.100.1", "dns": ["9.9.9.9"]}})

    def test_apply_without_confirm_rolls_back(self):
        sid = self.login()
        self.static_wan(sid)
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 10}), [0])
        self.assertEqual(self.call(sid, "uci", "changes")[1]["changes"], {})

        self.assertTrue(self.fake.is_down())
        self.assertTrue(self.wan(sid)["pending"])
        self.clock.now += 2
        self.assertFalse(self.fake.is_down())
        wan = self.wan(sid)
        self.assertEqual((wan["up"], wan["proto"], wan["ipv4-address"][0]["address"]),
                         (True, "static", "198.51.100.7"))
        self.assertEqual(wan["route"][0]["nexthop"], "198.51.100.1")

        self.clock.now += 9  # 적용 후 11초: 확인 없음
        other = self.login()
        proto = {"config": "network", "section": "wan", "option": "proto"}
        self.assertEqual(self.wan(sid)["proto"], "dhcp")
        self.assertEqual(self.call(other, "uci", "get", proto)[1]["value"], "dhcp")
        self.assertEqual(self.call(sid, "uci", "confirm"), [5])  # 되돌린 뒤에는 확인할 것이 없다
        # 실제 rpcd처럼 적용했던 세션에는 변경 목록이 되살아난다
        self.assertEqual(self.call(sid, "uci", "get", proto)[1]["value"], "static")
        self.assertIn(["set", "wan", "proto", "static"], self.call(sid, "uci", "changes")[1]["changes"]["network"])

    def test_tick_alone_rolls_back(self):
        sid = self.login()
        self.static_wan(sid)
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 5})
        self.clock.now += 6
        self.fake.tick()  # dev.py의 타이머 스레드가 하는 일
        self.assertEqual(self.fake.running["network"][4]["proto"], "dhcp")

    def test_apply_then_confirm_sticks(self):
        sid = self.login()
        self.static_wan(sid)
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 10})
        self.clock.now += 3
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])
        self.clock.now += 60
        self.assertEqual(self.wan(sid)["proto"], "static")

    def test_explicit_rollback(self):
        sid = self.login()
        self.static_wan(sid)
        self.call(sid, "uci", "apply", {"rollback": True, "timeout": 10})
        self.assertEqual(self.call(sid, "uci", "rollback"), [0])
        self.clock.now += 3
        self.assertEqual(self.wan(sid)["proto"], "dhcp")

    def test_apply_conflicts(self):
        a, b = self.login(), self.login()
        self.assertEqual(self.call(a, "uci", "confirm"), [5])
        self.assertEqual(self.call(a, "uci", "rollback"), [5])
        self.assertEqual(self.call(a, "uci", "apply", {"rollback": True, "timeout": 10}), [5])  # 변경 없음
        self.assertEqual(self.call(a, "uci", "apply"), [5])
        self.static_wan(a)
        self.static_wan(b)
        self.assertEqual(self.call(a, "uci", "apply", {"rollback": True, "timeout": 10}), [0])
        self.assertEqual(self.call(b, "uci", "apply", {"rollback": True, "timeout": 10}), [6])
        self.assertEqual(self.call(b, "uci", "confirm"), [6])
        # 실제 rpcd: 확인 대기 중에는 어느 세션도 revert할 수 없다 (set은 된다)
        self.assertEqual(self.call(a, "uci", "revert", {"config": "network"}), [6])
        self.assertEqual(self.call(b, "uci", "revert", {"config": "firewall"}), [6])
        self.static_wan(a)
        self.assertEqual(self.call(a, "uci", "apply", {"rollback": True, "timeout": 10}), [6])  # 같은 세션도
        self.assertEqual(self.call(a, "uci", "confirm"), [0])

    def test_timeout_zero_never_rolls_back(self):
        sid = self.login()
        self.static_wan(sid)
        self.assertEqual(self.call(sid, "uci", "apply", {"rollback": True, "timeout": 0}), [0])
        self.clock.now += 3000  # 세션(3600초)은 살아 있을 만큼만
        self.assertEqual(self.wan(sid)["proto"], "static")
        self.assertEqual(self.call(sid, "uci", "confirm"), [0])  # 계속 대기 중이었다

    def test_default_timeout(self):
        sid = self.login()
        self.static_wan(sid)
        self.call(sid, "uci", "apply", {"rollback": True})
        self.clock.now += 54
        self.assertEqual(self.wan(sid)["proto"], "static")
        self.clock.now += 2
        self.assertEqual(self.wan(sid)["proto"], "dhcp")

    def test_apply_without_rollback(self):
        sid = self.login()
        self.call(sid, "uci", "set", {"config": "wireless", "section": "default_radio1",
                                      "values": {"ssid": "NewName"}})
        self.call(sid, "uci", "set", {"config": "wireless", "section": "radio0", "values": {"disabled": "1"}})
        self.assertEqual(self.call(sid, "uci", "apply"), [0])
        self.clock.now += 100
        self.assertEqual(self.call(sid, "iwinfo", "info", {"device": "phy1-ap0"})[1]["ssid"], "NewName")
        # 꺼진 radio0의 장치는 없다
        self.assertEqual(self.call(sid, "iwinfo", "devices")[1]["devices"], ["phy1-ap0"])

    def test_pppoe_needs_credentials(self):
        sid = self.login()
        self.call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {"proto": "pppoe"}})
        self.call(sid, "uci", "apply")
        self.clock.now += 3
        self.assertEqual((self.wan(sid)["up"], self.wan(sid)["pending"]), (False, True))
        self.call(sid, "uci", "set", {"config": "network", "section": "wan",
                                      "values": {"username": "u", "password": "p"}})
        self.call(sid, "uci", "apply")
        self.clock.now += 3
        self.assertTrue(self.wan(sid)["up"])

    def test_leases_follow_lan_subnet(self):
        sid = self.login()
        self.call(sid, "uci", "set", {"config": "network", "section": "lan", "values": {"ipaddr": "10.0.0.1"}})
        self.call(sid, "uci", "apply")
        data = self.call(sid, "file", "read", {"path": "/tmp/dhcp.leases"})[1]["data"]
        self.assertIn(" 10.0.0.101 ", data)


class Profiles(unittest.TestCase):
    """여러 종류의 공유기(포트 구성/스위치 방식) 흉내."""

    def make(self, profile):
        clock = Clock()
        fake = fakeubus.FakeUbus(acl_files=fakeubus.default_acl_files(BASE), password="pw", apply_delay=0,
                                 clock=clock, log=lambda *a: None, profile=profile)
        call = lambda sid, o, m, a=None: fake.handle(json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "call", "params": [sid, o, m, a or {}]}).encode()).get("result")
        sid = call(NULL_SID, "session", "login", {"username": "root", "password": "pw"})[1]["ubus_rpc_session"]
        return fake, call, sid, clock

    def test_every_profile_basics(self):
        for profile in fakeubus.PROFILES:
            with self.subTest(profile=profile):
                fake, call, sid, _ = self.make(profile)
                board = json.loads(call(sid, "file", "read", {"path": "/etc/board.json"})[1]["data"])
                self.assertEqual(board["model"]["id"], profile)
                self.assertEqual(call(sid, "system", "board")[1]["model"], fakeubus.PROFILES[profile])
                dump = {i["interface"]: i for i in call(sid, "network.interface", "dump")[1]["interface"]}
                self.assertEqual(dump["lan"]["ipv4-address"][0]["address"], "192.168.1.1")
                self.assertTrue(dump["wan"]["up"])
                self.assertEqual(call(sid, "network.device", "status")[0], 0)
                self.assertEqual(call(sid, "network.wireless", "status"), [2])
                self.assertEqual(call(sid, "iwinfo", "devices")[0], 0)

    def test_client_locations_data(self):
        """요약 정보의 '연결 (포트)'가 읽는 것: 브리지 MAC 학습표, 포트 번호, 무선 접속 목록 (배포용 ACL로)."""
        import base64
        fake, call, sid, _ = self.make("dsa4")
        names = [e["name"] for e in call(sid, "file", "list", {"path": "/sys/class/net/br-lan/brif"})[1]["entries"]]
        self.assertEqual(names, ["lan1", "lan2", "lan3", "lan4"])
        self.assertEqual(call(sid, "file", "read", {"path": "/sys/class/net/br-lan/brif/lan4/port_no"})[1]["data"], "0x4\n")
        raw = base64.b64decode(call(sid, "file", "read", {"path": "/sys/class/net/br-lan/brforward", "base64": True})[1]["data"])
        entries = [(raw[o:o + 6].hex(":"), raw[o + 6], raw[o + 7]) for o in range(0, len(raw), 16)]
        self.assertIn(("b8:27:eb:11:22:33", 4, 0), entries)   # living-tv -> lan4
        self.assertIn(("3c:22:fb:aa:bb:cc", 1, 0), entries)   # macbook -> lan1
        assoc = call(sid, "iwinfo", "assoclist", {"device": "phy1-ap0"})[1]["results"]
        self.assertEqual([a["mac"] for a in assoc], ["A4:83:E7:12:34:56"])
        # 다른 경로는 읽을 수 없다
        self.assertEqual(call(sid, "file", "list", {"path": "/etc"}), [6])

    def test_guest_on_existing_vlan(self):
        """게스트를 VLAN 설정에서 만든 VLAN 30에 연결: 인터페이스가 br-lan.30을 쓴다."""
        fake, call, sid, clock = self.make("dsa4")
        for method, args in [
            ("add", {"config": "network", "type": "bridge-vlan", "values": {"device": "br-lan", "vlan": "1", "ports": ["lan1:u*", "lan2:u*", "lan3:u*"]}}),
            ("add", {"config": "network", "type": "bridge-vlan", "values": {"device": "br-lan", "vlan": "30", "ports": ["lan4:u*"]}}),
            ("set", {"config": "network", "section": "lan", "values": {"device": "br-lan.1"}}),
            ("add", {"config": "network", "type": "interface", "name": "guest",
                     "values": {"proto": "static", "device": "br-lan.30", "ipaddr": "192.168.30.1/24"}}),
            ("add", {"config": "wireless", "type": "wifi-iface", "name": "guest_radio0",
                     "values": {"device": "radio0", "mode": "ap", "network": "guest", "ssid": "G", "encryption": "none", "isolate": "1"}}),
        ]:
            self.assertEqual(call(sid, "uci", method, args)[0], 0, args)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 120}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        dump = {i["interface"]: i for i in call(sid, "network.interface", "dump")[1]["interface"]}
        self.assertEqual(dump["guest"]["device"], "br-lan.30")
        self.assertEqual(dump["guest"]["ipv4-address"][0]["address"], "192.168.30.1")

    def test_ipset_and_rule_reference(self):
        """IP 세트 화면과 트래픽 규칙이 쓰는 firewall 섹션을 배포용 ACL로 만들고 고칠 수 있다."""
        fake, call, sid, clock = self.make("dsa4")
        res = call(sid, "uci", "add", {"config": "firewall", "type": "ipset", "values": {
            "name": "blocklist", "family": "ipv4", "match": ["src_net"], "entry": ["192.0.2.1", "198.51.100.0/24"]}})
        self.assertEqual(res[0], 0)
        section = res[1]["section"]
        rule = call(sid, "uci", "add", {"config": "firewall", "type": "rule", "values": {
            "name": "Block-List", "src": "lan", "dest": "wan", "ipset": "blocklist src", "target": "REJECT"}})
        self.assertEqual(rule[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        got = call(sid, "uci", "get", {"config": "firewall", "section": section})[1]["values"]
        self.assertEqual(got[".type"], "ipset")
        self.assertEqual(got["match"], ["src_net"])
        self.assertEqual(got["entry"], ["192.0.2.1", "198.51.100.0/24"])
        # 항목 바꾸기와 끄기
        self.assertEqual(call(sid, "uci", "set", {"config": "firewall", "section": section,
                                                  "values": {"entry": ["203.0.113.5"], "enabled": "0"}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        got = call(sid, "uci", "get", {"config": "firewall", "section": section})[1]["values"]
        self.assertEqual((got["entry"], got["enabled"]), (["203.0.113.5"], "0"))

    def test_ipset_page_is_loaded_and_in_menu(self):
        """새 화면 파일이 index.html, 메뉴, 페이지 등록에 모두 연결되어 있다."""
        www = os.path.join(BASE, "www", "nmm")
        def read(name):
            with open(os.path.join(www, name), encoding="utf-8") as f:
                return f.read()
        self.assertIn('src="fwipset.js?v=__V__"', read("index.html"))
        self.assertIn("path: '/fw-ipset'", read("app.js"))
        self.assertIn("PAGES['/fw-ipset']", read("fwipset.js"))

    def test_mt6000_profile(self):
        """GL-MT6000: lan1(2.5G)~lan5 브리지와 WAN eth1(2.5G), 보드 이름, 데모가 이 프로필을 쓴다."""
        fake, call, sid, clock = self.make("mt6000")
        board = json.loads(call(sid, "file", "read", {"path": "/etc/board.json"})[1]["data"])
        self.assertEqual(board["network"]["lan"]["ports"], ["lan1", "lan2", "lan3", "lan4", "lan5"])
        self.assertEqual(board["network"]["wan"]["device"], "eth1")
        self.assertEqual(call(sid, "system", "board")[1]["board_name"], "glinet,gl-mt6000")
        devs = call(sid, "network.device", "status")[1]
        self.assertEqual(devs["br-lan"]["bridge-members"], ["lan1", "lan2", "lan3", "lan4", "lan5"])
        self.assertEqual((devs["lan1"]["speed"], devs["lan2"]["speed"], devs["eth1"]["speed"]), ("2500F", "1000F", "2500F"))
        with open(os.path.join(BASE, "tools", "demo", "demo.js"), encoding="utf-8") as f:
            self.assertIn("profile='mt6000'", f.read())

    def test_https_and_repo_keys_acl(self):
        """HTTPS 설정(uhttpd)과 저장소 공개 키(/etc/apk/keys)를 배포용 ACL로 다룰 수 있고, 그 밖의 파일은 지울 수 없다."""
        fake, call, sid, clock = self.make("mt3000")
        main = call(sid, "uci", "get", {"config": "uhttpd", "section": "main"})[1]["values"]
        self.assertEqual(main["listen_https"], ["0.0.0.0:443", "[::]:443"])
        self.assertEqual(call(sid, "uci", "set", {"config": "uhttpd", "section": "main", "values": {"redirect_https": "1"}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        keys = "/etc/apk/keys"
        self.assertEqual([e["name"] for e in call(sid, "file", "list", {"path": keys})[1]["entries"]], ["openwrt-25.12.pem"])
        pem = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n"
        self.assertEqual(call(sid, "file", "write", {"path": keys + "/my-repo.pem", "data": pem, "mode": 420}), [0])
        self.assertEqual(call(sid, "file", "read", {"path": keys + "/my-repo.pem"})[1]["data"], pem)
        self.assertEqual(call(sid, "file", "remove", {"path": keys + "/my-repo.pem"}), [0])
        self.assertEqual(call(sid, "file", "remove", {"path": "/etc/passwd"}), [6])
        self.assertEqual(call(sid, "file", "write", {"path": "/etc/apk/repositories.d/x.list", "data": "x"}), [6])

    def test_demo_site_build(self):
        """GitHub Pages 데모: 데모 스크립트가 화면 코드보다 먼저 실행되고 필요한 파일이 모두 들어간다."""
        import tempfile
        sys.path.insert(0, os.path.join(BASE, "tools"))
        import mkdemo
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "site")
            mkdemo.build(out)
            with open(os.path.join(out, "index.html"), encoding="utf-8") as f:
                index = f.read()
            self.assertLess(index.index("demo/demo.js"), index.index("app.js"))
            self.assertNotIn("__V__", index)
            with open(os.path.join(out, "demo/demo.js"), encoding="utf-8") as f:
                demo = f.read()
            self.assertNotIn("__V__", demo)
            self.assertNotIn("__B__", demo)
            build = mkdemo.build_id(mkdemo.read("VERSION").strip())
            self.assertIn(f"app.js?v={build}", index)  # 내용이 바뀌면 캐시 값도 바뀐다
            self.assertIn(f"DEMO_BUILD = '{build}'", demo)
            self.assertIn("fake.nmm_version = fake.nmm_latest = '%s'" % mkdemo.read("VERSION").strip(), demo)
            for name in ("app.js", "VERSION", ".nojekyll", "demo/demo.js", "demo/fakeubus.py", "demo/easyui.json"):
                self.assertTrue(os.path.exists(os.path.join(out, name)), name)
            with open(os.path.join(out, "demo/easyui.json"), encoding="utf-8") as f:
                self.assertIn("easyui", json.load(f))

    def test_geoblock_acl(self):
        """국가 차단: banip 설정과 정해진 서비스 명령만 쓸 수 있다."""
        fake, call, sid, clock = self.make("dsa4")
        init = lambda *p: call(sid, "file", "exec", {"command": "/etc/init.d/banip", "params": list(p)})
        self.assertIn("kr\tAPNIC", call(sid, "file", "read", {"path": "/etc/banip/banip.countries"})[1]["data"])
        self.assertEqual(call(sid, "uci", "set", {"config": "banip", "section": "global", "values": {
            "ban_enabled": "1", "ban_feed": ["country"], "ban_country": ["cn", "ru"]}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        self.assertEqual(init("enable")[1]["code"], 0)
        self.assertEqual(init("restart")[1]["code"], 0)
        status = json.loads(call(sid, "file", "read", {"path": "/var/run/banIP/banIP.runtime.json"})[1]["data"])
        self.assertEqual(status["status"], "active")
        self.assertEqual(init("stop")[1]["code"], 0)
        self.assertEqual(init("disable"), [6])  # 정해진 명령만 허용
        self.assertEqual(init("search", "1.2.3.4"), [6])

    def test_wifi_overview_data_and_disconnect(self):
        """무선 개요: 상태와 접속 기기를 읽고, 배포용 ACL로 기기 연결을 끊을 수 있다."""
        fake, call, sid, clock = self.make("mt3000")
        info = call(sid, "iwinfo", "info", {"device": "phy1-ap0"})[1]
        self.assertTrue(info["bssid"] and info["hardware"]["name"] and info["frequency"])
        mac = call(sid, "iwinfo", "assoclist", {"device": "phy1-ap0"})[1]["results"][0]["mac"]
        self.assertEqual(call(sid, "hostapd.phy1-ap0", "del_client",
                              {"addr": mac, "deauth": True, "reason": 5, "ban_time": 60000}), [0])
        self.assertEqual(call(sid, "iwinfo", "assoclist", {"device": "phy1-ap0"})[1]["results"], [])

    def test_routing_sections(self):
        """라우팅 규칙 화면이 쓰는 network 섹션을 배포용 ACL로 만들 수 있다."""
        fake, call, sid, clock = self.make("dsa4")
        for type_, values in [
            ("route", {"interface": "lan", "target": "192.168.50.0/24", "gateway": "192.168.1.2", "metric": "10", "table": "100"}),
            ("route6", {"interface": "lan", "target": "2001:db8:1::/48", "gateway": "fe80::1"}),
            ("rule", {"priority": "1000", "src": "192.168.1.0/24", "lookup": "100"}),
            ("rule6", {"priority": "1000", "src": "2001:db8:1::/64", "action": "prohibit"}),
        ]:
            self.assertEqual(call(sid, "uci", "add", {"config": "network", "type": type_, "values": values})[0], 0, type_)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 120}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        types = [s[".type"] for s in call(sid, "uci", "get", {"config": "network"})[1]["values"].values()]
        for type_ in ("route", "route6", "rule", "rule6"):
            self.assertIn(type_, types)

    def test_ssh_settings_acl(self):
        """SSH 설정: dropbear 설정과 공개 키 파일만 쓸 수 있다."""
        fake, call, sid, clock = self.make("dsa4")
        keys = "/etc/dropbear/authorized_keys"
        self.assertEqual(call(sid, "file", "read", {"path": keys}), [4])
        self.assertEqual(call(sid, "file", "write", {"path": keys, "data": "ssh-ed25519 AAAA test\n", "mode": 384}), [0])
        self.assertEqual(call(sid, "file", "read", {"path": keys})[1]["data"], "ssh-ed25519 AAAA test\n")
        self.assertEqual(call(sid, "file", "write", {"path": "/etc/passwd", "data": "x"}), [6])
        self.assertEqual(call(sid, "file", "write", {"path": "/etc/dropbear/dropbear_ed25519_host_key", "data": "x"}), [6])
        self.assertEqual(call(sid, "uci", "set", {"config": "dropbear", "section": "main", "values": {"Port": "2222"}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 60}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        self.assertEqual(call(sid, "uci", "get", {"config": "dropbear", "section": "main"})[1]["values"]["Port"], "2222")

    def test_missing_package_install_creates_config(self):
        """DDNS/SQM 패키지가 없는 공유기: 화면의 설치 버튼이 쓰는 apk 명령 뒤에 설정 파일이 생긴다."""
        clock = Clock()
        fake = fakeubus.FakeUbus(acl_files=fakeubus.default_acl_files(BASE), password="pw", apply_delay=0,
                                 clock=clock, log=lambda *a: None, packages=False)
        call = lambda sid, o, m, a=None: fake.handle(json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "call", "params": [sid, o, m, a or {}]}).encode()).get("result")
        sid = call(NULL_SID, "session", "login", {"username": "root", "password": "pw"})[1]["ubus_rpc_session"]
        apk = lambda *p: call(sid, "file", "exec", {"command": "/usr/bin/apk", "params": list(p)})
        for pkg, config in (("ddns-scripts", "ddns"), ("sqm-scripts", "sqm")):
            self.assertNotIn(config, call(sid, "uci", "configs")[1]["configs"])
            self.assertEqual(apk("update")[1]["code"], 0)
            self.assertEqual(apk("add", pkg)[1]["code"], 0)
            self.assertIn(config, call(sid, "uci", "configs")[1]["configs"])
            self.assertEqual(call(sid, "uci", "get", {"config": config})[0], 0)

    def test_interface_and_device_edit(self):
        """인터페이스 목록의 수정 창이 쓰는 network 옵션을 배포용 ACL로 고칠 수 있다."""
        fake, call, sid, clock = self.make("dsa4")
        self.assertEqual(call(sid, "uci", "set", {"config": "network", "section": "wan", "values": {
            "proto": "static", "ipaddr": "203.0.113.10/24", "gateway": "203.0.113.1", "dns": ["1.1.1.1"], "metric": "10"}})[0], 0)
        self.assertEqual(call(sid, "uci", "add", {"config": "network", "type": "device", "values": {
            "name": "lan1", "macaddr": "02:11:22:33:44:55", "mtu": "1400"}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 120}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        wan = call(sid, "uci", "get", {"config": "network", "section": "wan"})[1]["values"]
        self.assertEqual((wan["proto"], wan["gateway"], wan["metric"]), ("static", "203.0.113.1", "10"))
        net = call(sid, "uci", "get", {"config": "network"})[1]["values"]
        dev = next(s for s in net.values() if s[".type"] == "device" and s.get("name") == "lan1")
        self.assertEqual((dev["macaddr"], dev["mtu"]), ("02:11:22:33:44:55", "1400"))

    def test_dsa4_ports_and_6ghz(self):
        fake, call, sid, _ = self.make("dsa4")
        devs = call(sid, "network.device", "status")[1]
        self.assertEqual(devs["br-lan"]["bridge-members"], ["lan1", "lan2", "lan3", "lan4"])
        self.assertIn("wan", devs)
        self.assertEqual(call(sid, "uci", "get", {"config": "wireless", "section": "radio2", "option": "band"})[1]["value"], "6g")
        self.assertEqual(call(sid, "iwinfo", "info", {"device": "phy2-ap0"})[1]["ssid"], "MyHome-6G")

    def test_swconfig_switch_vlan(self):
        fake, call, sid, clock = self.make("swconfig")
        board = json.loads(call(sid, "file", "read", {"path": "/etc/board.json"})[1]["data"])
        self.assertEqual([p.get("device") for p in board["switch"]["switch0"]["ports"] if p.get("device")], ["eth0"])
        devs = call(sid, "network.device", "status")[1]
        self.assertIn("eth0.1", devs)
        self.assertIn("eth0.2", devs)
        # 화면이 하는 것: 새 스위치 VLAN(순번 3, VID 20) + eth0.20 네트워크
        self.assertEqual(call(sid, "uci", "add", {"config": "network", "type": "switch_vlan",
                                                 "values": {"device": "switch0", "vlan": "3", "vid": "20", "ports": "4t 0t"}})[0], 0)
        self.assertEqual(call(sid, "uci", "add", {"config": "network", "type": "interface", "name": "iot",
                                                 "values": {"proto": "static", "device": "eth0.20", "ipaddr": "192.168.20.1/24"}})[0], 0)
        self.assertEqual(call(sid, "uci", "apply", {"rollback": True, "timeout": 120}), [0])
        self.assertEqual(call(sid, "uci", "confirm"), [0])
        self.assertIn("eth0.20", call(sid, "network.device", "status")[1])

    def test_single_port_no_bridge(self):
        fake, call, sid, _ = self.make("single")
        lan = call(sid, "uci", "get", {"config": "network", "section": "lan"})[1]["values"]
        self.assertEqual(lan["device"], "eth0")
        self.assertNotIn("br-lan", call(sid, "network.device", "status")[1])


class Http(unittest.TestCase):
    """dev.py의 HTTP 처리: 정적 파일, /ubus, 적용 직후 연결 끊김."""

    def setUp(self):
        import dev
        self.clock = Clock()
        dev.Handler.fake = fakeubus.FakeUbus(acl_files=fakeubus.default_acl_files(BASE), password="pw",
                                             apply_delay=2, clock=self.clock, log=lambda *a: None)
        self.fake = dev.Handler.fake
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), dev.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def post(self, sid, obj, method, args=None):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "call",
                           "params": [sid, obj, method, args or {}]}).encode()
        req = urllib.request.Request(self.url + "/ubus", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as res:
            return json.loads(res.read())

    def test_static_and_ubus(self):
        with urllib.request.urlopen(self.url + "/app.js", timeout=5) as res:
            self.assertIn(b"session", res.read())
        res = self.post(NULL_SID, "session", "login", {"username": "root", "password": "pw"})
        self.assertEqual(res["result"][0], 0)

    def test_cgi_upload_and_backup(self):
        sid = self.post(NULL_SID, "session", "login", {"username": "root", "password": "pw"})["result"][1]["ubus_rpc_session"]
        boundary = "XyZ"
        parts = [("sessionid", sid.encode()), ("filename", b"/tmp/firmware.bin"), ("filemode", b"0600"),
                 ("filedata", b"NMMWRT-TEST-FW\x00\x01")]
        fname = '; filename="fw.bin"'
        body = b"".join(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{n}"{fname if n == "filedata" else ""}\r\n\r\n'.encode()
            + v + b"\r\n" for n, v in parts) + f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(self.url + "/cgi-bin/cgi-upload", data=body,
                                     headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(req, timeout=5) as res:
            self.assertEqual(json.loads(res.read())["size"], 16)
        self.assertEqual(self.fake.files["/tmp/firmware.bin"], b"NMMWRT-TEST-FW\x00\x01")
        # 다른 경로에는 못 올린다 (file 쓰기 ACL)
        # 실제 cgi-io처럼 HTTP 200 + failure로 거부한다
        bad = body.replace(b"/tmp/firmware.bin", b"/etc/passwd")
        with urllib.request.urlopen(urllib.request.Request(self.url + "/cgi-bin/cgi-upload", data=bad,
                                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}), timeout=5) as res:
            out = json.loads(res.read())
        self.assertEqual(out["message"], "Access to path denied by ACL")
        self.assertNotIn("/etc/passwd", self.fake.files)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(urllib.request.Request(self.url + "/cgi-bin/cgi-backup", data=b"sessionid=0"), timeout=5)
        self.assertEqual(cm.exception.code, 403)
        req = urllib.request.Request(self.url + "/cgi-bin/cgi-backup", data=f"sessionid={sid}".encode())
        with urllib.request.urlopen(req, timeout=5) as res:
            self.assertEqual(res.read()[:2], b"\x1f\x8b")

    def test_connection_dropped_while_applying(self):
        self.fake.down_until = self.clock.now + 2
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionError, urllib.error.URLError)):
            self.post(NULL_SID, "system", "info")
        self.clock.now += 2
        self.assertEqual(self.post(NULL_SID, "system", "info")["error"]["code"], -32002)


if __name__ == "__main__":
    unittest.main()
