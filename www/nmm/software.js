// 소프트웨어 관리 (특수 기능): apk(OpenWrt 25)로 패키지를 찾고, 설치/삭제/업그레이드한다.
//   설치된 목록: /lib/apk/db/installed (P: 이름, V: 버전, T: 설명, I: 설치 크기) 를 file read로 읽는다.
//   설치 가능 / 업데이트: rpcd file exec로 `apk search -v <*검색어*>`(이름, 버전, 설명), `apk list --upgradable`.
//   동작: apk update / add / del / upgrade, 올린 파일은 cgi-upload로 /tmp/upload.apk에 둔 뒤 apk add --allow-untrusted.
// 저장 공간은 system info의 root(KB).

const APK = '/usr/bin/apk';
const APK_DB = '/lib/apk/db/installed';
const APK_UPLOAD = '/tmp/upload.apk';
const APK_TIMEOUT_MS = 180000; // 목록 받기/설치는 인터넷 속도에 따라 오래 걸릴 수 있다
const PKG_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const APK_KEYS_DIR = '/etc/apk/keys';
const APK_KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const APK_KEY_RE = /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PUBLIC KEY-----$/;
const PKG_PAGE = 100;

function apkExec(params) {
  return ubus('file', 'exec', { command: APK, params }, state.sid, APK_TIMEOUT_MS);
}

// /lib/apk/db/installed -> [{ name, version, desc, size }]
function parseApkDb(text) {
  const out = [];
  let cur = {};
  for (const line of String(text || '').split('\n').concat([''])) {
    if (!line.trim()) {
      if (cur.name) out.push(cur);
      cur = {};
      continue;
    }
    const k = line[0];
    const v = line.slice(2);
    if (line[1] !== ':') continue;
    if (k === 'P') cur.name = v;
    else if (k === 'V') cur.version = v;
    else if (k === 'T') cur.desc = v;
    else if (k === 'I') cur.size = +v || 0;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// `apk list` 한 줄: 'name-1.2.3-r4 aarch64_cortex-a53 {origin} (license) [installed]' 또는 '[upgradable from: name-1.2.2-r1]'
// LuCI 패키지의 버전에는 -r 숫자가 없다 (예: luci-app-sqm-26.320.60423~5331286)
function parseApkListLine(line) {
  const m = /^(\S+?)-(\d[^\s-]*(?:-r\d+)?)\s+(\S+)?(.*)$/.exec(line.trim());
  if (!m) return null;
  const rest = m[4] || '';
  const from = /upgradable from: \S+?-(\d[^\s\]-]*(?:-r\d+)?)\]/.exec(rest);
  return { name: m[1], version: m[2], installed: /\[installed/.test(rest), from: from ? from[1] : '' };
}

function parseApkList(text) {
  return String(text || '').split('\n').map(parseApkListLine).filter(Boolean);
}

// `apk search -v` 한 줄: 'name-1.2.3-r4 - 설명'
function parseApkSearch(text) {
  return String(text || '').split('\n').map((line) => {
    const m = /^(\S+?)-(\d[^\s-]*(?:-r\d+)?)(?:\s+-(?:\s+(.*))?)?$/.exec(line.trim());
    return m ? { name: m[1], version: m[2], desc: m[3] || '' } : null;
  }).filter(Boolean);
}

// apk 명령을 차례로 실행하고 결과를 창으로 보여 준다. 하나라도 실패하면 멈춘다. 모두 성공하면 true
// steps: [{ label, params }]
async function apkRunSteps(title, steps, note) {
  const box = h('pre', { class: 'apk-log' }, '실행 중입니다... 인터넷 속도에 따라 1~2분 걸릴 수 있습니다.');
  const ok = h('button', { class: 'btn', type: 'button', disabled: true, onclick: closeModal }, '확인');
  showModal(h('h3', null, title), note ? h('p', { class: 'muted' }, note) : null, box, h('div', { class: 'actions' }, ok));
  const log = [];
  for (const step of steps) {
    if (steps.length > 1) box.textContent = `${step.label} 중입니다... 인터넷 속도에 따라 1~2분 걸릴 수 있습니다.`;
    let res;
    try {
      res = await apkExec(step.params);
    } catch (e) {
      if (await handleDenied(e) === 'expired') return false;
      box.textContent = e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED
        ? '권한이 없습니다. (ACL에 apk 실행이 없습니다. 최신 wrtTIME를 다시 배포해 주세요.)'
        : `실행하지 못했습니다. 시간이 오래 걸려 응답을 놓쳤을 수 있으니 잠시 뒤 목록을 다시 확인해 주세요.\n(${e.message || e})`;
      ok.disabled = false;
      return false;
    }
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    if (out) log.push(out);
    // apk update는 저장소 하나만 못 받아도 코드 1로 끝난다 ("1 unavailable ... 11124 distinct packages available").
    // 받은 목록이 있으면 나머지 저장소로 계속한다 (설치할 패키지가 빠진 저장소에 있으면 다음 단계에서 실패한다).
    const partial = step.params[0] === 'update' && res.code !== 0
      && /(\d+) unavailable/.test(out) && +((/(\d+) distinct packages available/.exec(out) || [])[1] || 0) > 0;
    if (partial) {
      log.push(`일부 저장소(${/(\d+) unavailable/.exec(out)[1]}개)의 목록을 받지 못했습니다. 받은 목록으로 계속합니다.`);
    } else if (res.code !== 0) {
      box.textContent = [`실패했습니다. (코드 ${res.code})`, ...log].join('\n\n');
      box.classList.add('apk-fail');
      ok.disabled = false;
      return false;
    }
  }
  box.textContent = ['완료했습니다.', ...log].join('\n\n');
  ok.disabled = false;
  return true;
}

function softwarePage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('소프트웨어 관리'), body);
  let alive = true;
  const view = { tab: 'installed', filter: '', shown: PKG_PAGE };
  let data = { installed: [], disk: null };

  async function load() {
    let text, info;
    try {
      [text, info] = await Promise.all([
        ubus('file', 'read', { path: APK_DB }).then((d) => d.data),
        ubus('system', 'info').catch(() => null),
      ]);
    } catch (e) {
      if (e instanceof RpcError && e.code === UBUS_NOT_FOUND) { body.replaceChildren(messageCard('이 공유기에서 apk 패키지 관리자를 찾지 못했습니다 (OpenWrt 25 이상 필요).')); return; }
      const t = await loadFailureText(e);
      if (alive && t) body.replaceChildren(messageCard(t));
      return;
    }
    if (!alive) return;
    data = { installed: parseApkDb(text), disk: info && info.root };
    render();
  }

  /* ---------- 실행 + 결과 창 ---------- */

  const run = (title, params, note) => apkRunSteps(title, [{ label: title, params }], note);

  async function install(name) {
    if (!await confirmDialog('패키지 설치', `'${name}' 패키지를 설치합니다. 필요한 다른 패키지도 함께 설치됩니다.`, '설치')) return;
    if (await run(`'${name}' 설치`, ['add', name])) load();
  }

  async function remove(name) {
    if (!await confirmDialog('패키지 삭제', [
      `'${name}' 패키지를 삭제합니다.`,
      h('p', { class: 'msg warn-msg' }, '시스템에 필요한 패키지를 지우면 공유기가 제대로 동작하지 않을 수 있습니다. 무엇인지 모르는 패키지는 지우지 마세요.'),
    ], '삭제', true)) return;
    if (await run(`'${name}' 삭제`, ['del', name])) load();
  }

  async function upgrade(name) {
    if (!await confirmDialog('패키지 업그레이드', `'${name}' 패키지를 새 버전으로 바꿉니다.`, '업그레이드')) return;
    if (await run(`'${name}' 업그레이드`, ['upgrade', name])) { cache.updates = null; load(); }
  }

  /* ---------- 저장소 공개 키 (/etc/apk/keys/*.pem) ---------- */
  // apk는 이 폴더의 키로 패키지 목록과 패키지의 서명을 확인한다. 다른 저장소를 쓸 때 그 저장소의 공개 키를 등록한다.

  async function readKeys() {
    const entries = (await ubus('file', 'list', { path: APK_KEYS_DIR })).entries || [];
    const names = entries.filter((e) => e.type === 'file' && /\.pem$/.test(e.name)).map((e) => e.name).sort();
    const texts = await Promise.all(names.map((n) => ubus('file', 'read', { path: `${APK_KEYS_DIR}/${n}` }).then((d) => d.data || '', () => '')));
    return names.map((name, i) => ({ name, text: texts[i].trim() }));
  }

  async function openKeys(message) {
    let keys;
    try {
      keys = await readKeys();
    } catch (e) {
      if (await handleDenied(e) === 'expired') return;
      infoModal('저장소 공개 키', e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED
        ? '공개 키를 읽을 권한이 없습니다. 최신 wrtTIME를 다시 설치해 주세요.' : '공개 키 목록을 읽지 못했습니다.', true);
      return;
    }
    const keyPart = (text) => {
      const body = text.split('\n').filter((l) => !l.startsWith('-----')).join('');
      return body ? `${body.slice(0, 16)}…${body.slice(-12)}` : '(내용 없음)';
    };
    const rows = keys.map((k) => h('tr', null,
      h('td', null, h('b', null, k.name), /^openwrt-/.test(k.name) ? h('div', { class: 'muted' }, 'OpenWrt 공식 키') : null),
      h('td', { class: 'pkg-desc' }, keyPart(k.text)),
      h('td', { class: 'actions-cell' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => removeKey(k) }, '삭제'))));

    const name = h('input', { type: 'text', spellcheck: 'false', placeholder: '예: my-repo' });
    const pem = h('textarea', { rows: '5', spellcheck: 'false', placeholder: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----' });
    const fName = formField('키 이름', name, '영문, 숫자, . _ - (파일 이름이 됩니다. .pem은 자동으로 붙습니다)');
    const fPem = formField('공개 키 (PEM)', pem);
    const addBtn = h('button', { class: 'btn', type: 'button' }, '등록');
    addBtn.addEventListener('click', async () => {
      fName.setError(null);
      fPem.setError(null);
      const base = name.value.trim().replace(/\.pem$/i, '');
      const text = pem.value.replace(/\r/g, '').trim().split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
      let bad = false;
      if (!APK_KEY_NAME_RE.test(base)) { fName.setError('영문이나 숫자로 시작하는 1~60자 (영문, 숫자, . _ -)'); bad = true; }
      else if (keys.some((k) => k.name === `${base}.pem`)) { fName.setError('같은 이름의 키가 이미 있습니다'); bad = true; }
      if (/PRIVATE KEY/.test(text)) { fPem.setError('개인 키입니다. 저장소의 공개 키를 넣어 주세요'); bad = true; }
      else if (!APK_KEY_RE.test(text)) { fPem.setError('-----BEGIN PUBLIC KEY-----로 시작하는 공개 키를 넣어 주세요'); bad = true; }
      else if (keys.some((k) => k.text === text)) { fPem.setError('이미 등록된 키입니다'); bad = true; }
      if (bad) return;
      addBtn.disabled = true;
      try {
        await ubus('file', 'write', { path: `${APK_KEYS_DIR}/${base}.pem`, data: `${text}\n`, mode: 0o644 });
      } catch (e) {
        addBtn.disabled = false;
        if (await handleDenied(e) !== 'expired') fPem.setError('키를 저장하지 못했습니다. 최신 wrtTIME가 설치되어 있는지 확인해 주세요');
        return;
      }
      openKeys(`'${base}.pem' 키를 등록했습니다. 새 저장소를 쓰려면 "목록 새로 받기"를 눌러 주세요.`);
    });

    showModal(h('h3', null, '저장소 공개 키'),
      h('p', { class: 'muted' }, '패키지 저장소의 서명을 확인하는 공개 키입니다. 믿을 수 있는 저장소의 키만 등록하세요.'),
      message ? h('p', { class: 'msg ok-msg' }, message) : null,
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['이름', '키', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 3, class: 'muted' }, '등록된 공개 키가 없습니다.'))))),
      h('div', { class: 'card-head', style: 'margin-top:14px' }, h('h3', null, '키 등록')),
      fName.el, fPem.el,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '닫기'), addBtn));
  }

  async function removeKey(k) {
    const official = /^openwrt-/.test(k.name);
    const ok = await confirmDialog('공개 키 삭제', [
      `'${k.name}' 키를 삭제합니다.`,
      h('p', { class: 'msg warn-msg' }, official
        ? 'OpenWrt 공식 키입니다. 삭제하면 패키지 목록을 받거나 패키지를 설치할 수 없게 됩니다.'
        : '이 키로 서명한 저장소의 패키지를 더 이상 설치할 수 없게 됩니다.'),
    ], '삭제', true);
    if (!ok) { openKeys(); return; }
    try {
      await ubus('file', 'remove', { path: `${APK_KEYS_DIR}/${k.name}` });
    } catch (e) {
      if (await handleDenied(e) !== 'expired') infoModal('공개 키 삭제', '키를 삭제하지 못했습니다. 최신 wrtTIME가 설치되어 있는지 확인해 주세요.', true);
      return;
    }
    openKeys(`'${k.name}' 키를 삭제했습니다.`);
  }

  /* ---------- 설치 가능 / 업데이트 목록 (apk 실행) ---------- */

  const cache = { search: null, updates: null };

  async function searchAvailable(term) {
    const res = await apkExec(['search', '-v', `*${term}*`]);
    if (res.code !== 0) throw new Error(res.stderr || `apk 코드 ${res.code}`);
    // 같은 이름이 여러 버전으로 나올 수 있어 마지막 것만 남긴다
    const map = new Map();
    for (const p of parseApkSearch(res.stdout)) map.set(p.name, p);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function listUpdates() {
    const res = await apkExec(['list', '--upgradable']);
    if (res.code !== 0) throw new Error(res.stderr || `apk 코드 ${res.code}`);
    return parseApkList(res.stdout);
  }

  /* ---------- 화면 ---------- */

  function diskCard() {
    const d = data.disk;
    const pct = d && d.total ? Math.round((d.used / d.total) * 100) : 0;
    const mib = (kb) => `${(kb / 1024).toFixed(1)} MiB`;
    const nameIn = h('input', { type: 'text', placeholder: '패키지 이름 (예: luci-app-upnp)', spellcheck: 'false' });
    const fName = formField('패키지 이름으로 설치', nameIn);
    const installBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '설치');
    installBtn.addEventListener('click', () => {
      fName.setError(null);
      const n = nameIn.value.trim();
      if (!PKG_NAME_RE.test(n)) { fName.setError('영문/숫자와 . _ + - 로 된 패키지 이름을 입력해 주세요'); return; }
      install(n);
    });
    const updateBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '목록 새로 받기');
    updateBtn.addEventListener('click', async () => {
      if (await run('패키지 목록 새로 받기', ['update'], '인터넷에서 최신 패키지 목록을 받습니다.')) { cache.search = null; cache.updates = null; render(); }
    });
    const file = h('input', { type: 'file', accept: '.apk', hidden: true });
    const uploadBtn = h('button', { class: 'btn btn-ghost btn-inline', type: 'button', onclick: () => file.click() }, '패키지 파일 올려 설치');
    file.addEventListener('change', async () => {
      const fl = file.files[0];
      file.value = '';
      if (!fl) return;
      if (!/\.apk$/i.test(fl.name)) { infoModal('패키지 파일', '.apk 파일만 설치할 수 있습니다.', true); return; }
      if (!await confirmDialog('패키지 파일 설치', [
        `'${fl.name}' (${(fl.size / 1024).toFixed(0)} KB)을 올려 설치합니다.`,
        h('p', { class: 'msg warn-msg' }, '서명을 확인하지 않고 설치합니다. 믿을 수 있는 곳에서 받은 파일만 설치하세요.'),
      ], '올려서 설치')) return;
      const prog = h('p', { class: 'muted' }, '올리는 중... 0%');
      showModal(h('h3', null, '패키지 파일 올리기'), prog);
      try {
        await uploadFile(fl, APK_UPLOAD, (p) => { prog.textContent = `올리는 중... ${p}%`; });
      } catch (e) {
        closeModal();
        infoModal('패키지 파일', e.message || '파일을 올리지 못했습니다.', true);
        return;
      }
      closeModal();
      if (await run(`'${fl.name}' 설치`, ['add', '--allow-untrusted', APK_UPLOAD])) load();
    });
    return h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'card-head' }, h('h3', null, '저장 공간')),
      d ? h('div', null,
        h('div', { class: 'disk-bar' }, h('div', { style: `width:${Math.max(pct, 1)}%` })),
        h('p', { class: 'muted' }, `${pct}% 사용 (${mib(d.used)} / ${mib(d.total)}, 남은 공간 ${mib(d.avail || d.free)})`))
        : h('p', { class: 'muted' }, '저장 공간 정보를 읽지 못했습니다.'),
      h('div', { class: 'sw-tools' },
        h('div', { class: 'sw-install' }, fName.el, installBtn),
        h('div', { class: 'actions', style: 'margin:0' }, updateBtn, uploadBtn,
          h('button', { class: 'btn btn-ghost btn-inline', type: 'button', onclick: () => openKeys() }, '저장소 공개 키'), file)),
      h('p', { class: 'muted' }, '패키지 설치/삭제는 시스템을 망가뜨릴 수 있습니다. 설치 전에 "목록 새로 받기"를 먼저 해 주세요.'));
  }

  function tabs() {
    const items = [['installed', `설치됨 (${data.installed.length})`], ['available', '설치 가능'], ['updates', '업데이트']];
    return h('div', { class: 'seg' }, items.map(([k, label]) => h('button', {
      type: 'button', class: 'seg-btn' + (view.tab === k ? ' on' : ''),
      // 탭마다 검색어 뜻이 달라서(설치 가능은 저장소 검색) 탭을 바꾸면 비운다
      onclick: () => { if (view.tab !== k) view.filter = ''; view.tab = k; view.shown = PKG_PAGE; render(); },
    }, label)));
  }

  function filterBox(placeholder, onEnter) {
    const input = h('input', { type: 'search', value: view.filter, placeholder, spellcheck: 'false' });
    let t = null;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { view.filter = input.value.trim(); view.shown = PKG_PAGE; if (!onEnter) drawList(); }, 250);
    });
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && onEnter) { view.filter = input.value.trim(); onEnter(); } });
    return input;
  }

  const listBox = h('div');
  const sizeText = (b) => (b ? (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(b / 1024))} KiB`) : '-');
  const table = (head, rows, more) => h('div', null,
    h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ...head.map((x) => h('th', null, x)))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: head.length, class: 'muted' }, '패키지가 없습니다.'))))),
    more ? h('div', { class: 'actions' }, more) : null);
  const moreBtn = (total) => (total > view.shown
    ? h('button', { class: 'btn btn-ghost btn-inline', type: 'button', onclick: () => { view.shown += PKG_PAGE; drawList(); } }, `더 보기 (${total - view.shown}개 남음)`)
    : null);

  async function drawList() {
    const q = view.filter.toLowerCase();
    if (view.tab === 'installed') {
      const list = data.installed.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.desc || '').toLowerCase().includes(q));
      listBox.replaceChildren(table(['이름', '버전', '크기', '설명', ''], list.slice(0, view.shown).map((p) => h('tr', null,
        h('td', null, h('b', null, p.name)), h('td', null, p.version || '-'), h('td', null, sizeText(p.size)),
        h('td', { class: 'pkg-desc' }, p.desc || ''),
        h('td', { class: 'actions-cell' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => remove(p.name) }, '삭제')))),
      moreBtn(list.length)));
      return;
    }
    if (view.tab === 'available') {
      if (q.length < 2) { listBox.replaceChildren(h('p', { class: 'muted' }, '찾을 패키지 이름을 두 글자 이상 넣고 Enter를 누르세요. (예: upnp, luci-app)')); return; }
      if (!cache.search || cache.search.q !== q) {
        listBox.replaceChildren(h('p', { class: 'muted' }, '찾는 중...'));
        try {
          cache.search = { q, list: await searchAvailable(q) };
        } catch (e) {
          if (await handleDenied(e) === 'expired') return;
          listBox.replaceChildren(h('p', { class: 'msg' }, `찾지 못했습니다. "목록 새로 받기"를 먼저 해 보세요. (${e.message || e})`));
          return;
        }
      }
      if (!alive || view.tab !== 'available') return;
      const inst = new Map(data.installed.map((p) => [p.name, p.version]));
      const list = cache.search.list;
      listBox.replaceChildren(table(['이름', '버전', '설명', '상태', ''], list.slice(0, view.shown).map((p) => h('tr', null,
        h('td', null, h('b', null, p.name)), h('td', null, p.version),
        h('td', { class: 'pkg-desc' }, p.desc),
        h('td', null, inst.has(p.name) ? h('span', { class: 'pill ok' }, `설치됨 ${inst.get(p.name)}`) : h('span', { class: 'muted' }, '-')),
        h('td', { class: 'actions-cell' }, inst.has(p.name) ? null
          : h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => install(p.name) }, '설치')))),
      moreBtn(list.length)));
      return;
    }
    // 업데이트
    if (!cache.updates) {
      listBox.replaceChildren(h('p', { class: 'muted' }, '확인하는 중...'));
      try {
        cache.updates = await listUpdates();
      } catch (e) {
        if (await handleDenied(e) === 'expired') return;
        listBox.replaceChildren(h('p', { class: 'msg' }, `확인하지 못했습니다. (${e.message || e})`));
        return;
      }
    }
    if (!alive || view.tab !== 'updates') return;
    const list = cache.updates.filter((p) => !q || p.name.toLowerCase().includes(q));
    listBox.replaceChildren(
      h('p', { class: 'msg warn-msg' }, '패키지를 하나씩 업그레이드하면 커널 모듈 등이 서로 맞지 않을 수 있습니다. 큰 변경은 펌웨어 업그레이드를 권장합니다.'),
      table(['이름', '지금 버전', '새 버전', ''], list.slice(0, view.shown).map((p) => h('tr', null,
        h('td', null, h('b', null, p.name)), h('td', null, p.from || '-'), h('td', null, p.version),
        h('td', { class: 'actions-cell' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => upgrade(p.name) }, '업그레이드')))),
      moreBtn(list.length)));
  }

  function render() {
    const isSearch = view.tab === 'available';
    const filter = filterBox(isSearch ? '찾을 패키지 (Enter)' : '이름/설명으로 거르기', isSearch ? drawList : null);
    body.replaceChildren(diskCard(),
      h('section', { class: 'card', style: 'max-width:none' }, tabs(),
        h('div', { class: 'sw-filter' }, filter), listBox));
    drawList();
  }

  load();
  return () => { alive = false; };
}

PAGES['/software'] = softwarePage;
