// 추가 기능: LuCI에 설치된 서비스(Services 메뉴)를 찾아 메뉴로 보여 주고, 그 LuCI 화면을 wrtTIME 안에 띄운다.
// - 목록: /usr/share/luci/menu.d/*.json 중 'admin/services/<이름>' 항목 (LuCI 앱이 설치하는 메뉴 정의).
//   depends.uci의 설정 파일이 없으면 LuCI처럼 숨긴다. 서비스가 하나도 없으면(LuCI가 없거나 앱이 없으면) 메뉴 자체를 안 보인다.
// - 화면: 같은 주소의 /cgi-bin/luci/admin/services/<이름>을 iframe으로 열고, LuCI의 머리글/메뉴를 숨겨 내용만 보인다.
// - 로그인: wrtTIME 로그인 때 같은 계정으로 LuCI에도 로그인해 둔다(luciLogin). LuCI 세션이 끝났으면 iframe에 LuCI 로그인이 보인다.

const LUCI_MENU_DIR = '/usr/share/luci/menu.d';
const LUCI_BASE = '/cgi-bin/luci';

// { present: LuCI가 설치되어 있는지, services: [{ name, title, order }] }
async function loadLuciServices() {
  let entries;
  try {
    entries = (await ubus('file', 'list', { path: LUCI_MENU_DIR })).entries || [];
  } catch {
    return { present: false, services: [] }; // LuCI 없음 또는 권한 없음
  }
  return { present: entries.length > 0, services: await readLuciServices(entries) };
}

async function readLuciServices(entries) {
  const files = entries.map((e) => e.name).filter((n) => /\.json$/.test(n));
  const [configs, ...texts] = await Promise.all([
    ubus('uci', 'configs').then((d) => d.configs || []).catch(() => null),
    ...files.map((f) => ubus('file', 'read', { path: `${LUCI_MENU_DIR}/${f}` }).then((d) => d.data).catch(() => '')),
  ]);
  const found = new Map();
  for (const text of texts) {
    let menu;
    try { menu = JSON.parse(text); } catch { continue; }
    for (const [path, node] of Object.entries(menu || {})) {
      const m = /^admin\/services\/([^/]+)$/.exec(path);
      if (!m || !node || !node.title) continue;
      const uciDeps = Object.keys((node.depends || {}).uci || {});
      if (configs && uciDeps.some((c) => !configs.includes(c))) continue;
      const prev = found.get(m[1]) || {};
      found.set(m[1], { name: m[1], title: node.title || prev.title, order: node.order != null ? +node.order : (prev.order ?? 1000) });
    }
  }
  return [...found.values()].sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
}

// wrtTIME 로그인과 함께 LuCI에도 로그인한다 (LuCI가 sysauth 쿠키를 준다). 실패해도 상관없다.
function luciLogin(username, password) {
  const body = new URLSearchParams({ luci_username: username, luci_password: password });
  return fetch(`${LUCI_BASE}/`, { method: 'POST', body, credentials: 'same-origin', redirect: 'manual' })
    .then(() => true).catch(() => false);
}

function luciLogout() {
  fetch(`${LUCI_BASE}/admin/logout`, { credentials: 'same-origin', redirect: 'manual' }).catch(() => {});
}

// LuCI 테마(bootstrap, material, openwrt-2020 등)의 머리글/메뉴/바닥글을 숨기는 스타일
const LUCI_HIDE_CSS = `
header, footer, #mainmenu, #menubar, #modemenu, .main-left, #topmenu, #indicators { display: none !important; }
body { padding-top: 0 !important; margin-top: 0 !important; }
.main, .main-right, #maincontent, .container { width: auto !important; max-width: none !important; margin-left: 0 !important; left: 0 !important; padding-top: 0 !important; }
`;

// 테마와 상관없이 내용만 남긴다: LuCI 화면의 내용 영역(#maincontent, 없으면 #view)에서 body까지 올라가며
// 각 단계의 형제(사이드바, 메뉴, 머리글 등)를 숨기고, 조상의 레이아웃(그리드/여백)을 풀어 내용이 전체 폭을 쓰게 한다.
// body 바로 아래의 형제는 대화 상자(#modal_overlay)/툴팁이 있어 건드리지 않는다.
// (실기기 GL-MT3000의 테마 footstrap은 nav.fs-sidebar + main#maincontent 구조라 CSS 선택자만으로는 안 숨겨졌다)
function keepOnlyContent(doc) {
  const content = doc.getElementById('maincontent') || (doc.getElementById('view') || {}).parentElement;
  if (!content || !doc.body.contains(content)) return;
  const SKIP = ['SCRIPT', 'STYLE', 'LINK', 'META'];
  for (let el = content; el.parentElement && el.parentElement !== doc.body; el = el.parentElement) {
    for (const sib of el.parentElement.children) {
      if (sib !== el && !SKIP.includes(sib.tagName)) sib.style.setProperty('display', 'none', 'important');
    }
  }
  for (let el = content; el && el !== doc.body; el = el.parentElement) {
    const s = el.style;
    if (el !== content) s.setProperty('display', 'block', 'important');
    for (const [k, v] of [['margin-left', '0'], ['padding-left', '0'], ['left', '0'], ['width', 'auto'], ['max-width', 'none'], ['grid-column', 'auto']]) {
      s.setProperty(k, v, 'important');
    }
  }
}

function addonPage(root, item) {
  const url = `${LUCI_BASE}/admin/services/${encodeURIComponent(item.service)}`;
  const frame = h('iframe', { class: 'addon-frame', title: item.label });
  const note = h('p', { class: 'msg warn-msg', hidden: true });
  const openBtn = h('a', { class: 'btn btn-ghost btn-small', href: url, target: '_blank', rel: 'noopener' }, '새 창에서 열기');
  root.append(
    h('div', { class: 'addon-head' }, pageTitle(item.label), openBtn),
    h('p', { class: 'muted' }, 'LuCI에 설치된 서비스 화면입니다. 이 화면의 설정은 LuCI 방식으로 저장/적용됩니다.'),
    note, frame);

  let alive = true;
  frame.addEventListener('load', () => {
    if (!alive) return;
    let doc;
    try { doc = frame.contentDocument; } catch { doc = null; }
    if (!doc) { note.textContent = '이 화면을 안에 띄울 수 없습니다. "새 창에서 열기"를 눌러 주세요.'; note.hidden = false; return; }
    note.hidden = true;
    const style = doc.createElement('style');
    style.textContent = LUCI_HIDE_CSS;
    (doc.head || doc.documentElement).append(style);
    keepOnlyContent(doc);
    if (doc.querySelector('input[name="luci_password"]')) {
      note.textContent = 'LuCI 로그인이 필요합니다. 아래에서 공유기 관리자 계정으로 로그인해 주세요.';
      note.hidden = false;
    }
  });
  // 로그인 직후라면 LuCI 로그인이 끝난 뒤에 연다 (쿠키가 있어야 바로 열린다)
  Promise.resolve(state.luciLogin).then(() => { if (alive) frame.src = url; });
  return () => { alive = false; };
}
