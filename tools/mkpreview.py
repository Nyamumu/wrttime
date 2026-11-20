"""가짜 ubus 데이터가 든 단일 HTML(preview.html)을 만든다. 사용법: python3 tools/mkpreview.py"""
import pathlib
import re
base = pathlib.Path(__file__).resolve().parent.parent
root = base / 'www' / 'nmm'
css = (root / 'app.css').read_text(encoding='utf-8')
# index.html에 적힌 순서대로 스크립트를 이어 붙인다 (일반 스크립트라 전역을 공유한다)
order = re.findall(r'<script defer src="([^"?]+)', (root / 'index.html').read_text(encoding='utf-8'))
js = '\n'.join((root / name).read_text(encoding='utf-8') for name in order)
mock = r"""
(() => {
  const t0 = Date.now();
  const rnd = (a, b) => a + Math.random() * (b - a);
  const data = () => ({
    'system.info': { uptime: 93784 + Math.floor((Date.now() - t0) / 1000), load: [Math.floor(rnd(0.1, 0.6) * 65536), 0, 0],
      memory: { total: 536870912, free: 90000000, buffered: 4000000, cached: 60000000, available: Math.floor(rnd(280e6, 300e6)) } },
    'system.board': { model: 'GL.iNet GL-MT3000', release: { description: 'OpenWrt 24.10.0' } },
    'network.interface.dump': { interface: [
      { interface: 'loopback', up: true },
      { interface: 'wan', up: true, proto: 'dhcp', uptime: 3700 + Math.floor((Date.now() - t0) / 1000),
        'ipv4-address': [{ address: '203.0.113.25', mask: 24 }],
        route: [{ target: '0.0.0.0', mask: 0, nexthop: '203.0.113.1' }], 'dns-server': ['1.1.1.1', '8.8.8.8'] }] },
    'network.wireless.status': {
      radio0: { up: true, disabled: false, config: { band: '2g' }, interfaces: [{ config: { ssid: 'MyHome', mode: 'ap' } }] },
      radio1: { up: true, disabled: false, config: { band: '5g' }, interfaces: [{ config: { ssid: 'MyHome-5G', mode: 'ap' } }] } },
    'file.read': { data:
      '1900000000 a4:83:e7:12:34:56 192.168.1.101 jun-iphone 01:a4\n' +
      '1900000100 3c:22:fb:aa:bb:cc 192.168.1.102 macbook-pro *\n' +
      '1900000200 f0:18:98:de:f0:12 192.168.1.103 * *\n' +
      '1900000300 b8:27:eb:11:22:33 192.168.1.104 living-tv *\n' },
  });
  window.fetch = async (url, opts) => {
    await new Promise((r) => setTimeout(r, 150));
    const [, obj, method] = JSON.parse(opts.body).params;
    const out = obj === 'session' ? { ubus_rpc_session: 'preview' } : data()[obj + '.' + method];
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [0, out] }) };
  };
  const bar = document.createElement('div');
  bar.textContent = '미리보기: 가짜 데이터입니다. 아무 비밀번호로 로그인됩니다.';
  bar.style.cssText = 'position:fixed;right:12px;bottom:12px;padding:6px 12px;border-radius:8px;background:#1c2530;color:#fff;font:12px system-ui;opacity:.85;z-index:9';
  document.addEventListener('DOMContentLoaded', () => document.body.append(bar));
})();
"""
html = f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wrtTIME (미리보기)</title>
<style>{css}</style></head>
<body><div id="app"></div>
<script>{mock}</script>
<script>document.addEventListener('DOMContentLoaded', () => {{ {js} }});</script>
</body></html>"""
(base / 'preview.html').write_text(html, encoding='utf-8')
print(len(html))
