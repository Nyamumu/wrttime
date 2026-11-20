// GitHub Pages 데모: 공유기 없이 브라우저 안에서 가짜 ubus(tools/fakeubus.py)를 Python(Pyodide)으로 돌린다.
// 화면 코드(www/nmm)는 그대로 쓰고, /ubus와 /cgi-bin 요청만 여기서 가로챈다. 설정은 메모리에만 있어 새로고침하면 처음으로 돌아간다.
(function () {
  const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
  const DEMO_BUILD = '__B__'; // 내용이 바뀔 때마다 달라지는 값 (브라우저 캐시 무효화)
  const realFetch = window.fetch.bind(window);
  const RealXHR = window.XMLHttpRequest;
  let api = null;

  const BOOTSTRAP = `
import base64, hashlib, json, sys
sys.path.insert(0, '/demo')
import fakeubus

class DemoUbus(fakeubus.FakeUbus):
    # LuCI로 이동 메뉴는 보이고, LuCI 서비스가 필요한 추가 기능 메뉴는 숨긴다
    LUCI_MENU = {'luci-base.json': {}}

fake = DemoUbus(acl_files=['/demo/easyui.json'], password='admin', apply_delay=1.5, log=lambda *a: None, profile='mt6000')
# 데모는 항상 최신 버전이다 (wrtTIME 업데이트 카드에 새 버전이 뜨지 않게)
fake.nmm_version = fake.nmm_latest = '__V__'

def demo_ubus(body):
    return json.dumps(fake.handle(body.encode('utf-8')), ensure_ascii=False)

def demo_backup(sid):
    if not fake.check(sid, 'cgi-io', 'backup', 'read'):
        return None
    return base64.b64encode(fake.make_backup()).decode()

def demo_upload(sid, path, data):
    data = bytes(data)
    if not fake.check(sid, 'cgi-io', 'upload', 'write'):
        return json.dumps({'message': 'Upload permission denied', 'failure': [1, 'Operation not permitted']})
    if not fake.check(sid, 'file', path, 'write'):
        return json.dumps({'message': 'Access to path denied by ACL', 'failure': [0, 'No error information']})
    fake.files[path] = data
    return json.dumps({'size': len(data), 'checksum': hashlib.md5(data).hexdigest(), 'sha256sum': hashlib.sha256(data).hexdigest()})
`;

  /* ---------- 안내 화면 ---------- */

  const STYLE = `
#nmm-demo-load { position: fixed; inset: 0; z-index: 9999; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; text-align: center; background: #f5f5f5; color: #333; font: 15px system-ui, sans-serif; }
#nmm-demo-load b { font-size: 26px; color: #b8605d; }
#nmm-demo-load button { padding: 8px 16px; border: 0; border-radius: 4px; background: #f2c5c4; color: #333; font: inherit; cursor: pointer; }
#nmm-demo-note { position: fixed; right: 12px; bottom: 12px; z-index: 900; max-width: min(340px, calc(100vw - 24px)); padding: 8px 34px 8px 12px; border-radius: 6px;
  background: #333; color: #fff; font: 13px/1.5 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
#nmm-demo-note button { position: absolute; top: 3px; right: 4px; width: 26px; height: 26px; border: 0; background: none; color: #fff; font-size: 16px; cursor: pointer; }
@media (prefers-color-scheme: dark) { #nmm-demo-load { background: #1f1f1f; color: #eee; } }`;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, attrs || {});
    n.append(...kids);
    return n;
  }

  const loadText = el('span', { textContent: '데모를 준비하는 중입니다. 처음에는 10초쯤 걸릴 수 있습니다.' });
  const loadBox = el('div', { id: 'nmm-demo-load' }, el('b', { textContent: 'wrtTIME' }), loadText);

  function showShell() {
    document.head.append(el('style', { textContent: STYLE }));
    document.body.append(loadBox);
    const close = el('button', { type: 'button', textContent: '×', title: '닫기', onclick: () => note.remove() });
    const note = el('div', { id: 'nmm-demo-note' }, '데모 화면입니다. 실제 공유기가 아니며 새로고침하면 처음으로 돌아갑니다. 로그인: root / admin', close);
    document.body.append(note);
    // 로그인 화면에 데모 비밀번호를 미리 넣어 둔다
    new MutationObserver(() => {
      const pw = document.querySelector('.login-card input[type=password]');
      if (pw && !pw.dataset.demo) { pw.dataset.demo = '1'; pw.value = 'admin'; }
    }).observe(document.body, { childList: true, subtree: true });
    // 데모에는 LuCI가 없으므로 새 탭을 여는 대신 안내한다
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('a.luci-link')) return;
      ev.preventDefault();
      window.infoModal('LuCI로 이동', '데모에서는 지원하지 않습니다.');
    }, true);
  }
  if (document.body) showShell(); else document.addEventListener('DOMContentLoaded', showShell, { once: true });

  /* ---------- Python 시작 ---------- */

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      document.head.append(el('script', { src, onload: resolve, onerror: () => reject(new Error('load')) }));
    });
  }

  async function boot() {
    const text = async (path) => {
      const res = await realFetch(`${path}?v=${DEMO_BUILD}`);
      if (!res.ok) throw new Error(path);
      return res.text();
    };
    await loadScript(`${PYODIDE_URL}pyodide.js`);
    const [source, acl, py] = await Promise.all([text('demo/fakeubus.py'), text('demo/easyui.json'), window.loadPyodide({ indexURL: PYODIDE_URL })]);
    py.FS.mkdirTree('/demo');
    py.FS.writeFile('/demo/fakeubus.py', source);
    py.FS.writeFile('/demo/easyui.json', acl);
    py.runPython(BOOTSTRAP);
    const fake = py.globals.get('fake');
    api = {
      ubus: py.globals.get('demo_ubus'), backup: py.globals.get('demo_backup'), upload: py.globals.get('demo_upload'),
      isDown: () => fake.is_down(), tick: () => fake.tick(),
    };
    setInterval(() => api.tick(), 1000); // 요청이 없어도 자동 되돌림과 세션 만료가 돌게 한다
    loadBox.remove();
  }

  const ready = boot().catch(() => {
    loadText.textContent = '데모를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
    loadBox.append(el('button', { type: 'button', textContent: '다시 시도', onclick: () => location.reload() }));
    return new Promise(() => {}); // 화면 코드는 더 진행하지 않는다
  });

  /* ---------- 요청 가로채기 ---------- */

  const json = (text) => new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async function demoFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) {
      if (url.hostname === 'cdn.jsdelivr.net') return realFetch(input, init);
      throw new TypeError('데모에서는 외부 서버에 연결하지 않습니다.'); // 펌웨어 빌드 서버 등
    }
    const isUbus = url.pathname === '/ubus';
    if (!isUbus && !url.pathname.startsWith('/cgi-bin/')) return realFetch(input, init);
    await ready;
    if (api.isDown()) throw new TypeError('적용 중이라 연결이 잠시 끊겼습니다.');
    if (isUbus) return json(api.ubus(String(init.body || '')));
    if (url.pathname === '/cgi-bin/cgi-backup') {
      const data = api.backup(new URLSearchParams(String(init.body || '')).get('sessionid') || '');
      if (data == null) return new Response('Backup permission denied\n', { status: 403 });
      return new Response(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), { status: 200, headers: { 'Content-Type': 'application/x-targz' } });
    }
    return new Response('', { status: 200 }); // LuCI 로그인, 로그아웃
  };

  // 파일 올리기(cgi-upload)만 메모리로 받는다
  window.XMLHttpRequest = class DemoXHR extends RealXHR {
    open(method, url, ...rest) {
      this.demoUpload = /\/cgi-bin\/cgi-upload$/.test(url);
      if (!this.demoUpload) super.open(method, url, ...rest);
    }

    send(body) {
      if (!this.demoUpload) { super.send(body); return; }
      (async () => {
        await ready;
        const file = body.get('filedata');
        const data = new Uint8Array(await file.arrayBuffer());
        const text = api.upload(body.get('sessionid'), body.get('filename'), data);
        if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: data.length, total: data.length });
        Object.defineProperty(this, 'status', { value: 200 });
        Object.defineProperty(this, 'responseText', { value: text });
        if (this.onload) this.onload();
      })().catch(() => { if (this.onerror) this.onerror(); });
    }
  };
}());
