// wrtTIME 관리 UI - 공통 기능 + 홈 + 인터넷 설정 (빌드 불필요: uhttpd가 정적 파일로 서빙)
// 통신: uhttpd의 /ubus JSON-RPC. LuCI 전용 객체(luci-rpc 등)는 사용하지 않는다.
// 일반 스크립트(defer)라서 여기의 최상위 함수/상수는 다른 페이지 파일에서 그대로 쓴다.

const NULL_SESSION = '00000000000000000000000000000000';
const SESSION_KEY = 'easyui.sid';
const SESSION_TIMEOUT = 3600; // 초
const POLL_MS = 5000;
const UBUS_PERMISSION_DENIED = 6;
const UBUS_NOT_FOUND = 4;
const UBUS_NO_DATA = 5;
const UBUS_INVALID_ARGUMENT = 2;
// 설정 적용 후 이 시간(초) 안에 다시 연결해 확인하지 못하면 공유기가 스스로 이전 설정으로 되돌린다.
// 0을 주면 rpcd가 자동 롤백을 걸지 않으므로 반드시 양수여야 한다.
const APPLY_TIMEOUT = 60;
const CONFIRM_INTERVAL_MS = 2000;
// uhttpd가 세션/ACL 검사에서 거부할 때의 JSON-RPC 오류 코드. 만료된 세션도 이것으로 온다.
const RPC_ACCESS_DENIED = -32002;

const state = { sid: loadSid(), main: null, banner: null, cleanup: null };

function loadSid() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}
function saveSid(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_KEY, value);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* 저장 불가 환경에서도 동작해야 한다 */ }
}

/* ---------- ubus JSON-RPC ---------- */

class RpcError extends Error {
  constructor(code) {
    super('ubus error ' + code);
    this.code = code;
  }
}

let rpcId = 0;

// timeoutMs: 설정 적용 중처럼 공유기가 응답하지 않을 수 있을 때 무한정 기다리지 않게 한다.
async function ubus(object, method, args = {}, session = state.sid || NULL_SESSION, timeoutMs = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('/ubus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++rpcId,
        method: 'call',
        params: [session, object, method, args],
      }),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  if (body.error) throw new RpcError(body.error.code);
  const [code, data] = body.result;
  if (code !== 0) throw new RpcError(code);
  return data;
}

/* ---------- DOM 헬퍼 (데이터는 항상 텍스트 노드로 넣는다) ---------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid);
  }
  return el;
}

const app = document.getElementById('app');

/* ---------- 표시용 변환 ---------- */

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hh = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}일 ${hh}시간 ${m}분`;
  if (hh > 0) return `${hh}시간 ${m}분`;
  return `${m}분`;
}

function fmtMB(bytes) {
  return Math.round(bytes / 1048576) + ' MB';
}

const PROTO_LABEL = {
  dhcp: '자동 IP (DHCP)',
  static: '고정 IP',
  pppoe: 'PPPoE',
};

const BAND_LABEL = { '2g': '2.4GHz', '5g': '5GHz', '6g': '6GHz', '60g': '60GHz' };

/* ---------- 여러 공유기 호환 (OpenWrt 25 이상만 대상) ---------- */
// 공유기마다 포트 수, 포트 이름, 스위치 방식(DSA/swconfig), 무선 대역이 다르다.

// 무선 대역: 'band'. 없으면 채널로 추정한다.
function radioBand(cfg) {
  if (!cfg) return '';
  if (cfg.band) return cfg.band;
  const ch = parseInt(cfg.channel, 10);
  if (ch) return ch > 14 ? '5g' : '2g';
  return '';
}

function ifaceDev(sec) {
  return asList(sec.device)[0] || '';
}

// /etc/board.json: 공유기 모델별 포트 구성 (DSA는 network.lan.ports, swconfig는 switch.<이름>.ports)
let boardCache = null;
async function readBoard() {
  if (boardCache) return boardCache;
  try {
    const d = await ubus('file', 'read', { path: '/etc/board.json' });
    boardCache = JSON.parse(d.data || '{}');
  } catch {
    // 로그인 전이나 세션이 끝난 뒤의 실패는 기억하지 않는다 (기억하면 로그인한 뒤에도 포트 이름이 장치 이름으로 남는다)
    return {};
  }
  return boardCache;
}

// 포트 장치 이름 -> 사람이 읽기 쉬운 이름 (lan1 -> LAN 1, wan -> WAN).
// eth0/eth1처럼 이름만으로 알 수 없으면 board.json의 역할로 정한다 (예: MT3000은 eth0=WAN, eth1=LAN).
function portLabel(name) {
  const net = (boardCache && boardCache.network) || {};
  if (net.wan && (net.wan.device === name || asList(net.wan.ports).includes(name)) && !/^wan/i.test(name)) return 'WAN';
  if (net.lan && !/^lan\d/i.test(name)) {
    const lanPorts = asList(net.lan.ports);
    if (net.lan.device === name && !lanPorts.length) return 'LAN';
    const i = lanPorts.indexOf(name);
    if (i >= 0) return lanPorts.length > 1 ? `LAN ${i + 1}` : 'LAN';
  }
  let m;
  if ((m = /^lan(\d+)$/i.exec(name))) return `LAN ${m[1]}`;
  if (/^(wan|internet)$/i.test(name)) return 'WAN';
  if ((m = /^wan(\d+)$/i.exec(name))) return `WAN ${m[1]}`;
  if ((m = /^(sfp)(\d*)$/i.exec(name))) return `SFP${m[2] ? ' ' + m[2] : ''}`;
  return name;
}

/* ---------- 아이콘 (직접 그린 단순한 선 아이콘, 24x24) ---------- */

const ICONS = {
  chart: 'M4 20h16M7 16v-5M11 16V7M15 16V8M19 16v-3',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18',
  wifi: 'M2.5 9c5.4-4.8 13.6-4.8 19 0M5.5 12.4c3.7-3.2 9.3-3.2 13 0M8.6 15.8c1.9-1.6 4.9-1.6 6.8 0M12 19.2v.1',
  chip: 'M7 7h10v10H7zM10 10h4v4h-4zM9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
  network: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
  router: 'M3 13h18v6H3zM7 16h.01M11 16h.01M7 13L5 7M17 13l2-6',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6zM9.5 12l2 2l3.5-4',
  link: 'M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1',
  traffic: 'M4 4v16h16M7 15l4-4l3 3l5-6',
  system: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2',
  pin: 'M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
  plug: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5',
  devices: 'M3 5h13v9H3zM6 18h7M9.5 14v4M18 8h3v11h-3z',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  range: 'M4 12h16M7 9l-3 3l3 3M17 9l3 3l-3 3',
  memory: 'M4 7h16v9H4zM8 7v9M12 7v9M16 7v9M6 19h12',
  gauge: 'M4 17a8 8 0 1 1 16 0M12 17l3.5-5',
  tag: 'M3 12V4h8l10 10l-8 8zM7.5 7.5h.01',
  home: 'M3 11l9-7l9 7M5 10v10h14V10',
  logout: 'M14 4h5v16h-5M10 8l-4 4l4 4M6 12h10',
  chev: 'M9 6l6 6l-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 14v6M14 17h6',
};

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.chart);
  svg.append(path);
  return svg;
}

/* ---------- 무선 상태 ---------- */
// OpenWrt 25.12의 network.wireless는 정해진 인자 외의 값을 거부하는데, uhttpd가 /ubus 호출마다 세션 ID 인자를
// 덧붙이므로 웹에서는 항상 [2]로 실패한다 (실기기 확인). 그래서 uci 무선 설정 + iwinfo로 같은 모양을 만든다:
//   { radio0: { up, disabled, config: {...}, interfaces: [{ section, ifname, config: {...} }] } }
async function wirelessStatus() {
  try {
    return await ubus('network.wireless', 'status');
  } catch (e) {
    // [2]: 25.12의 인자 거부, -32000: 객체 없음(무선 패키지 구조가 다른 경우). 둘 다 아래 방식으로 대신한다.
    if (!(e instanceof RpcError) || (e.code !== UBUS_INVALID_ARGUMENT && e.code !== -32000)) throw e;
  }
  const sections = await uciSections('wireless');
  if (!sections) return {};
  const radios = sections.filter((s) => s['.type'] === 'wifi-device');
  const ifaces = sections.filter((s) => s['.type'] === 'wifi-iface');
  // 실행 중인 무선 장치 이름 (phy0-ap0 등)과 각 장치의 phy
  const devs = await ubus('iwinfo', 'devices').then((d) => d.devices || [], () => null);
  const names = devs || radios.flatMap((_, i) => [0, 1, 2, 3].map((j) => `phy${i}-ap${j}`)); // 목록을 못 받으면 이름 규칙으로 추정
  const infos = (await Promise.all(names.map((n) => ubus('iwinfo', 'info', { device: n })
    .then((info) => ({ ifname: n, info }), () => null)))).filter(Boolean);
  const out = {};
  for (const [idx, r] of radios.entries()) {
    const phy = await ubus('iwinfo', 'phyname', { section: r['.name'] })
      .then((d) => d.phyname || d.phy || null, () => null) || `phy${idx}`;
    const live = infos.filter((x) => x.info.phy === phy || x.ifname.startsWith(`${phy}-`));
    const aps = ifaces.filter((i) => i.device === r['.name'] && i.disabled !== '1');
    const used = new Set();
    const cfgOf = (s) => {
      const c = Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('.')));
      c.network = asList(c.network);
      c.mode = c.mode || 'ap';
      return c;
    };
    out[r['.name']] = {
      up: r.disabled !== '1' && live.length > 0,
      pending: false,
      disabled: r.disabled === '1',
      config: cfgOf(r),
      interfaces: aps.map((s, j) => {
        // 같은 SSID의 실행 중 장치를 먼저 찾고, 없으면 순서대로(phyN-apJ)
        const hit = live.find((x) => !used.has(x.ifname) && x.info.ssid === s.ssid)
          || live.find((x) => !used.has(x.ifname) && x.ifname === `${phy}-ap${j}`);
        if (hit) used.add(hit.ifname);
        return { section: s['.name'], ifname: hit ? hit.ifname : undefined, config: cfgOf(s) };
      }),
    };
  }
  return out;
}

/* ---------- 테마 (밝게/어둡게, 브라우저에 기억) ---------- */

const THEME_KEY = 'easyui.theme';
function loadPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function savePref(key, value) { try { localStorage.setItem(key, value); } catch { /* 저장 불가 환경 */ } }
if (loadPref(THEME_KEY)) document.documentElement.dataset.theme = loadPref(THEME_KEY);

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ---------- 메뉴 ---------- */

const MENU_BASIC = [
  { path: '/', label: '시스템 요약 정보', icon: 'chart' },
  { path: '/internet', label: '인터넷 설정', icon: 'globe' },
  { path: '/wireless', label: '무선 설정', icon: 'wifi' },
  { path: '/firmware', label: '펌웨어 업그레이드', icon: 'chip' },
];

const MENU_ALL = [
  { group: '네트워크 관리', icon: 'network', items: [
    { path: '/internet', label: '인터넷 설정' },
    { path: '/lan', label: '내부 네트워크 설정' },
    { path: '/dhcp', label: 'DHCP 서버 설정' },
    { path: '/ipv6', label: 'IPv6 설정' },
    { path: '/vlan', label: 'VLAN 설정' },
    { path: '/interfaces', label: '인터페이스 목록' },
  ] },
  { group: '무선 관리', icon: 'wifi', items: [
    { path: '/wifi-overview', label: '무선 개요' },
    { path: '/wireless', label: '무선 설정' },
    { path: '/wireless-advanced', label: '무선 고급 설정' },
    { path: '/guest', label: '게스트 / VLAN 네트워크' },
  ] },
  { group: 'NAT/라우터 관리', icon: 'router', items: [
    { path: '/portforward', label: '포트포워드 설정' },
    { path: '/firewall', label: '방화벽 설정' },
    { path: '/fw-rules', label: '트래픽 규칙' },
    { path: '/fw-nat', label: 'NAT 규칙' },
    { path: '/fw-ipset', label: 'IP 세트' },
    { path: '/routing', label: '라우팅 규칙' },
  ] },
  { group: '보안 기능', icon: 'shield', items: [
    { path: '/access', label: '인터넷 접속 차단' },
    { path: '/geoblock', label: '국가 차단' },
  ] },
  { group: '특수 기능', icon: 'link', items: [
    { path: '/ddns', label: 'DDNS 설정' },
    { path: '/software', label: '소프트웨어 관리' },
  ] },
  // LuCI에 설치된 서비스 (addons.js). 로그인 후 채우고, 하나도 없으면 메뉴를 숨긴다.
  { group: '추가 기능', icon: 'apps', addons: true, items: [] },
  { group: '트래픽 관리', icon: 'traffic', items: [
    { path: '/traffic', label: '속도 관리 (SQM)' },
  ] },
  { group: '시스템 관리', icon: 'system', items: [
    { path: '/system', label: '기본 설정' },
    { path: '/password', label: '관리자 비밀번호' },
    { path: '/ssh', label: 'SSH 설정' },
    { path: '/firmware', label: '펌웨어 업그레이드' },
    { path: '/maintenance', label: '재시작 / 백업 / 초기화' },
    { path: '/log', label: '시스템 로그' },
    { path: '/sysinfo', label: '시스템 정보' },
    // LuCI가 있을 때만 보인다 (addons.js가 확인). 새 탭으로 연다.
    { path: '/luci', label: 'LuCI로 이동', href: '/cgi-bin/luci/', luci: true },
  ] },
];

function flatMenu() {
  return [...MENU_BASIC, ...MENU_ALL.flatMap((g) => g.items)];
}

function pageTitle(text) {
  return h('h1', null, text);
}

/* ---------- 로그인 / 로그아웃 ---------- */

function logoEl() {
  return h('span', { class: 'logo' }, 'wrt', h('b', null, 'TIME'));
}

function renderLogin(message) {
  const user = h('input', { type: 'text', name: 'username', value: 'root', autocomplete: 'username' });
  // 비밀번호 미설정 공유기도 있으므로 빈 값을 브라우저에서 막지 않는다.
  const pass = h('input', { type: 'password', name: 'password', autocomplete: 'current-password' });
  const err = h('p', { class: 'msg', hidden: true });
  const submit = h('button', { class: 'btn', type: 'button' }, '로그인');

  if (message) {
    err.textContent = message;
    err.hidden = false;
  }

  const doLogin = async () => {
        submit.disabled = true;
        err.hidden = true;
        try {
          const data = await ubus(
            'session', 'login',
            { username: user.value, password: pass.value, timeout: SESSION_TIMEOUT },
            NULL_SESSION,
          );
          state.sid = data.ubus_rpc_session;
          saveSid(state.sid);
          state.luciLogin = luciLogin(user.value, pass.value); // 추가 기능(LuCI 화면)을 다시 로그인 없이 열기 위해
          location.hash = '#/';
          route();
        } catch (e) {
          err.textContent = e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED
            ? '아이디 또는 비밀번호가 올바르지 않습니다.'
            : '공유기에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.';
          err.hidden = false;
          submit.disabled = false;
          pass.select();
        }
  };
  // <form> 전송에 기대지 않는다: 전송이 막힌 환경(샌드박스 등)에서도 동작해야 한다.
  submit.addEventListener('click', doLogin);
  const form = h(
    'div',
    { onkeydown: (ev) => { if (ev.key === 'Enter' && !submit.disabled) doLogin(); } },
    err,
    h('label', { class: 'field' }, h('span', null, '로그인 이름'), user),
    h('label', { class: 'field' }, h('span', null, '로그인 암호'), pass),
    h('div', { style: 'height:12px' }),
    submit,
  );

  app.replaceChildren(
    h('div', { class: 'login-page' },
      h('div', { class: 'login-top' }, logoEl()),
      h('div', { class: 'login-wrap' },
        h('div', { class: 'login-card' }, h('h1', null, 'Login'), form))),
  );
  pass.focus();
}

async function logout(message) {
  const sid = state.sid;
  stopPage();
  closeModal();
  state.sid = null;
  state.main = null;
  state.banner = null;
  state.shell = null;
  saveSid(null);
  state.addons = null;
  if (sid) {
    ubus('session', 'destroy', {}, sid).catch(() => {});
    luciLogout();
  }
  renderLogin(message);
}

/* ---------- 셸(사이드바 + 본문) ---------- */

const COLLAPSE_KEY = 'easyui.collapsed';
const isMobile = () => matchMedia('(max-width: 760px)').matches;

function renderShell() {
  const shell = h('div', { class: 'shell' + (loadPref(COLLAPSE_KEY) === '1' ? ' collapsed' : '') });
  const closeMobile = () => shell.classList.remove('mobile-open');
  // 접힌 상태(아이콘만)에서 메뉴를 누르면 펼친다. 휴대폰에서는 덮는 메뉴로 연다.
  const expand = () => {
    if (isMobile()) shell.classList.add('mobile-open');
    else { shell.classList.remove('collapsed'); savePref(COLLAPSE_KEY, '0'); }
  };
  const isFolded = () => (isMobile() ? !shell.classList.contains('mobile-open') : shell.classList.contains('collapsed'));

  const toggleBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '메뉴 접기/펼치기' }, icon('menu'));
  const syncToggle = () => toggleBtn.setAttribute('aria-expanded', String(!isFolded()));
  toggleBtn.addEventListener('click', () => {
    if (isMobile()) shell.classList.toggle('mobile-open');
    else {
      shell.classList.toggle('collapsed');
      savePref(COLLAPSE_KEY, shell.classList.contains('collapsed') ? '1' : '0');
    }
    syncToggle();
  });

  const link = (item, withIcon) => (item.href
    ? h('a', { href: item.href, target: '_blank', rel: 'noopener', title: item.label, onclick: closeMobile,
      class: item.luci ? 'luci-link' : '', hidden: !!item.luci }, item.label)
    : h('a', {
      class: withIcon ? 'nav-item' : '', href: '#' + item.path, 'data-path': item.path, title: item.label,
      onclick: closeMobile,
    }, withIcon ? icon(item.icon) : null, withIcon ? h('span', null, item.label) : item.label));

  const groups = MENU_ALL.map((g) => {
    const el = h('div', { class: 'nav-group', hidden: g.addons && !g.items.length });
    const head = h('button', { class: 'nav-item', type: 'button', title: g.group }, icon(g.icon), h('span', null, g.group), icon('chev'));
    head.lastChild.classList.add('chev');
    head.addEventListener('click', () => {
      if (isFolded()) { expand(); el.classList.add('open'); syncToggle(); return; }
      el.classList.toggle('open');
    });
    const sub = h('div', { class: 'nav-sub' }, g.items.map((i) => link(i, false)));
    el.append(head, sub);
    if (g.addons) {
      // LuCI 서비스 목록을 읽어 채운다. 없으면 숨긴 채로 둔다.
      state.addonsDone = false;
      state.addons = loadLuciServices().catch(() => ({ present: false, services: [] })).then(({ present, services: list }) => {
        app.querySelectorAll('.luci-link').forEach((a) => { a.hidden = !present; });
        g.items = list.map((s) => ({ path: `/addon/${s.name}`, label: s.title, service: s.name, page: addonPage }));
        sub.replaceChildren(...g.items.map((i) => link(i, false)));
        el.hidden = !g.items.length;
        state.addonsDone = true;
        markActive();
      });
    }
    return el;
  });

  state.main = h('main', { class: 'main' });
  state.banner = h('div', { class: 'banner-slot' });
  const model = h('span', { class: 'model' }, 'OpenWrt');
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': '밝게/어둡게' });
  const syncTheme = () => themeBtn.replaceChildren(icon(isDark() ? 'sun' : 'moon'));
  themeBtn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    savePref(THEME_KEY, next);
    syncTheme();
  });
  syncTheme();

  shell.append(
    h('aside', { class: 'side' },
      h('div', { class: 'side-head' }, logoEl(), toggleBtn),
      h('div', { class: 'nav-label' }, '기본 메뉴'),
      h('nav', { class: 'nav' }, MENU_BASIC.map((i) => link(i, true))),
      h('div', { class: 'nav-sep' }),
      h('div', { class: 'nav-label' }, '전체 메뉴'),
      h('nav', { class: 'nav' }, groups),
      h('div', { class: 'side-bottom' },
        h('a', { class: 'nav-item', href: '#/', title: '홈으로 이동', onclick: closeMobile }, icon('home'), h('span', null, '홈으로 이동')),
        h('div', { class: 'nav-sep' }),
        h('button', { class: 'nav-item', type: 'button', title: '로그아웃', onclick: () => logout() }, icon('logout'), h('span', null, '로그아웃')))),
    h('div', { class: 'side-backdrop', onclick: () => { closeMobile(); syncToggle(); } }),
    h('div', { class: 'content' },
      state.banner, state.main,
      h('div', { class: 'footer' }, model, h('span', { class: 'sep' }), themeBtn)),
  );
  syncToggle();
  app.replaceChildren(shell);
  state.shell = shell;
  checkEmptyPassword();
  ubus('system', 'board').then((b) => { model.textContent = b.model || b.hostname || 'OpenWrt'; }).catch(() => {});
}

function stopPage() {
  if (state.cleanup) state.cleanup();
  state.cleanup = null;
}

function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

function route() {
  if (currentPath().startsWith('/confirm?')) return resumeConfirm(currentPath());
  if (!state.sid) return renderLogin();
  if (!state.main) renderShell();

  const path = currentPath();
  // 추가 기능 화면은 LuCI 서비스 목록을 읽은 다음에 연다 (새로고침 직후)
  if (path.startsWith('/addon/') && state.addons && !state.addonsDone) {
    state.addons.then(() => { if (currentPath() === path) route(); });
    return;
  }
  stopPage();
  closeModal();
  const item = flatMenu().find((m) => m.path === path) || flatMenu()[0];
  markActive(item.path);

  state.main.replaceChildren();
  window.scrollTo(0, 0);
  const page = item.page || PAGES[item.path] || placeholderPage;
  state.cleanup = page(state.main, item) || null;
}

// 사이드바에서 지금 페이지 표시 + 그 메뉴 묶음 펼치기
function markActive(path = currentPath()) {
  for (const a of app.querySelectorAll('.side a[data-path]')) {
    a.classList.toggle('active', a.dataset.path === path);
  }
  app.querySelectorAll('.nav-group').forEach((g) => {
    if (g.querySelector(`a[data-path="${path}"]`) && path !== '/') g.classList.add('open');
  });
}

/* ---------- 페이지: 준비 중 ---------- */

function placeholderPage(root, item) {
  root.append(
    pageTitle(item.label),
    h('div', { class: 'placeholder' }, '이 화면은 아직 준비 중입니다.'),
  );
}

/* ---------- 페이지: 홈(대시보드) ---------- */

// 요약 타일: 아이콘 + 제목 + 값. tone: '' | 't2' | 't3' (아이콘 배경색)
// 인터넷 IPv6 상태 한 줄 [문구, 색]. ifaces: network.interface dump의 interface 배열
function ipv6Summary(ifaces) {
  const w6 = ifaces.find((i) => i.interface === 'wan6') || ifaces.find((i) => ['dhcpv6', '6in4', '6rd', '6to4'].includes(i.proto));
  if (!w6) return ['사용 안 함', null];
  const a = (w6['ipv6-address'] || [])[0];
  const p = (w6['ipv6-prefix'] || [])[0];
  if (w6.up && (a || p)) return [a ? a.address : `${p.address}/${p.mask} (프리픽스)`, 'ok'];
  if (w6.up) return ['연결됨 (주소 없음)', 'warn'];
  if (w6.pending) return ['받지 못함 (윗단 응답 없음)', 'warn'];
  return ['꺼짐', null];
}

function tile(iconName, title, tone) {
  const value = h('div', { class: 'tile-value' }, '불러오는 중...');
  const el = h('div', { class: 'tile' + (tone ? ' ' + tone : '') },
    h('div', { class: 'tile-ic' }, icon(iconName)),
    h('div', { class: 'tile-text' }, h('div', { class: 'tile-title' }, title), value));
  return {
    el,
    set(text, kind) {
      value.textContent = text;
      value.className = 'tile-value' + (kind ? ' ' + kind : '');
    },
  };
}

function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) dl.append(h('dt', null, k), h('dd', null, v));
  return dl;
}

function findWan(dump) {
  const list = (dump.interface || []).filter((i) => i.interface !== 'loopback');
  const hasDefaultRoute = (i) => (i.route || []).some((r) => r.target === '0.0.0.0' && r.mask === 0);
  return list.find((i) => i.interface === 'wan') || list.find(hasDefaultRoute);
}

// network.wireless status -> [{ ssid, band, on }]
function wifiRows(status) {
  const rows = [];
  for (const [radio, r] of Object.entries(status || {})) {
    const band = BAND_LABEL[radioBand(r.config)] || radio;
    const aps = (r.interfaces || []).filter((i) => !(i.config || {}).mode || i.config.mode === 'ap');
    // 무선 장치는 있지만 켜진 무선 네트워크가 없는 경우 (OpenWrt 처음 설치 상태: wifi-iface disabled 1)
    if (!aps.length) rows.push({ title: `${band} 무선`, on: false });
    for (const i of aps) {
      rows.push({ title: `${(i.config || {}).ssid || '(이름 없음)'} (${band})`, on: r.up && !r.disabled });
    }
  }
  return rows;
}

function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

// LAN 주소 + dhcp start/limit -> '192.168.1.100 ~ 192.168.1.249'
function dhcpRangeText(lanIp, lanMask, start, limit) {
  if (!isIPv4(lanIp) || !isNetmask(lanMask)) return '-';
  const net = (ipToInt(lanIp) & ipToInt(lanMask)) >>> 0;
  const s = net + (+start || 100);
  return `${intToIp(s)} ~ ${intToIp(s + (+limit || 150) - 1)}`;
}

function parseLeases(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [, mac, ip, name] = line.split(' ');
    return { mac, ip, name: name && name !== '*' ? name : '이름 없음' };
  });
}

const IFACE_LABEL_SHORT = { lan: '내부', guest: '게스트', vnet: 'VLAN 네트워크', wan: '인터넷' };

// '1000F' -> '1 Gbps', '2500F' -> '2.5 Gbps', '100H' -> '100 Mbps 반이중'
function speedText(s) {
  const m = /^(\d+)([FH])?$/.exec(String(s));
  if (!m) return String(s);
  const mbps = +m[1];
  const txt = mbps >= 1000 ? `${mbps / 1000} Gbps` : `${mbps} Mbps`;
  return m[2] === 'H' ? `${txt} 반이중` : txt;
}

const isWifiDev = (n) => /^(wlan|phy\d|ath\d|wl\d|ra\d|rai\d)/.test(n);

// 물리 포트: 브리지 구성원 중 무선/VLAN 장치가 아닌 것 + 인터넷 포트
function physicalPorts(devs, wanIf) {
  const out = [];
  const seen = new Set();
  const addPort = (name, wan) => {
    const d = devs[name];
    if (!d || seen.has(name) || isWifiDev(name) || /\./.test(name) || d.type === 'bridge') return;
    seen.add(name);
    out.push({ name, dev: d, wan });
  };
  // 인터넷 포트 (VLAN 장치면 그 바탕 장치)
  if (wanIf) {
    let w = wanIf.device || wanIf.l3_device || '';
    if (devs[w] && devs[w].parent) w = devs[w].parent;
    w = w.replace(/\.\d+$/, '');
    // 스위치 칩 방식: 같은 장치에서 내부용 VLAN(eth0.1)도 나오면 그 장치는 CPU 연결선이지 인터넷 포트가 아니다
    const trunk = Object.values(devs).some((d) => (d['bridge-members'] || []).some((m) => m.startsWith(`${w}.`)));
    if (!trunk) addPort(w, true);
  }
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  for (const [name, d] of Object.entries(devs).sort(([a], [b]) => natural(a, b))) {
    for (const m of d['bridge-members'] || []) addPort(m, false);
  }
  return out;
}

// 접속 기기 MAC -> 연결 위치 ('LAN 2', '무선 5GHz · MyHome-5G')
// 무선: iwinfo assoclist. 유선: 브리지 MAC 학습표(/sys/class/net/<브리지>/brforward)와 포트 번호(brif/*/port_no).
const brifCache = new Map(); // 브리지 -> { at, map: port_no -> 구성원 이름 }
async function clientLocations(wlStatus, devs) {
  const where = new Map();
  // 무선
  const aps = [];
  for (const r of Object.values(wlStatus || {})) {
    for (const i of r.interfaces || []) if (i.ifname) aps.push({ ifname: i.ifname, ssid: (i.config || {}).ssid, band: BAND_LABEL[radioBand(r.config)] || '' });
  }
  const assoc = await Promise.all(aps.map((a) => ubus('iwinfo', 'assoclist', { device: a.ifname }).catch(() => null)));
  aps.forEach((a, idx) => {
    for (const s of ((assoc[idx] && assoc[idx].results) || [])) {
      if (s.mac) where.set(s.mac.toLowerCase(), `무선 ${a.band}${a.ssid ? ' · ' + a.ssid : ''}`);
    }
  });
  // 유선
  const bridges = Object.entries(devs || {}).filter(([, d]) => d.type === 'bridge' && (d['bridge-members'] || []).length);
  for (const [br] of bridges) {
    let cached = brifCache.get(br);
    if (!cached || Date.now() - cached.at > 60000) {
      const map = {};
      const list = await ubus('file', 'list', { path: `/sys/class/net/${br}/brif` }).catch(() => null);
      for (const e of ((list && list.entries) || [])) {
        const pn = await ubus('file', 'read', { path: `/sys/class/net/${br}/brif/${e.name}/port_no` }).catch(() => null);
        if (pn && pn.data) map[parseInt(pn.data, 16)] = e.name;
      }
      cached = { at: Date.now(), map };
      brifCache.set(br, cached);
    }
    const fdb = await ubus('file', 'read', { path: `/sys/class/net/${br}/brforward`, base64: true }).catch(() => null);
    if (!fdb || !fdb.data) continue;
    const bin = atob(fdb.data);
    // struct __fdb_entry: mac[6], port_no(u8), is_local(u8), ageing(u32), port_hi(u8), pad(u8), unused(u16) = 16바이트
    for (let o = 0; o + 16 <= bin.length; o += 16) {
      if (bin.charCodeAt(o + 7)) continue; // 공유기 자신의 주소
      const mac = [...Array(6)].map((_, k) => bin.charCodeAt(o + k).toString(16).padStart(2, '0')).join(':');
      const port = bin.charCodeAt(o + 6) | (bin.charCodeAt(o + 12) << 8);
      const member = cached.map[port];
      if (!member || where.has(mac)) continue;
      // 무선 구성원인데 assoclist에 없던 경우, 스위치 칩 VLAN 장치(eth0.1)인 경우는 '유선'으로만
      where.set(mac, isWifiDev(member) ? '무선' : (/\./.test(member) ? '유선' : portLabel(member)));
    }
  }
  return where;
}

function dashboardPage(root) {
  const t = {
    wanState: tile('globe', '인터넷 연결 상태'),
    wanProto: tile('plug', '인터넷 연결 방식'),
    wanTime: tile('clock', '인터넷 연결 시간'),
    wanIp: tile('pin', '외부 IP 주소'),
    wanIp6: tile('globe', 'IPv6'),
    lanIp: tile('network', '내부 IP 주소', 't2'),
    dhcp: tile('server', 'DHCP 서버 상태', 't2'),
    range: tile('range', '동적 IP 할당 범위', 't2'),
    clients: tile('devices', '접속 기기', 't2'),
    fw: tile('chip', '펌웨어 버전', 't3'),
    model: tile('tag', '모델', 't3'),
    uptime: tile('clock', '시스템 동작 시간', 't3'),
    mem: tile('memory', '메모리 사용량', 't3'),
  };
  const wifiTiles = h('div', { class: 'tiles' }, tile('wifi', '무선 네트워크').el);
  const clientCard = card('접속 기기 목록', h('span', { class: 'muted' }, '불러오는 중...'));
  clientCard.style.maxWidth = '1240px';
  const portTiles = h('div', { class: 'tiles' }, tile('plug', '포트').el);

  root.append(
    pageTitle('시스템 요약 정보'),
    h('h2', null, '인터넷 정보'),
    h('div', { class: 'tiles' }, t.wanState.el, t.wanProto.el, t.wanTime.el, t.wanIp.el, t.wanIp6.el),
    h('h2', null, '무선 정보'),
    wifiTiles,
    h('h2', null, '내부 네트워크 정보'),
    h('div', { class: 'tiles' }, t.lanIp.el, t.dhcp.el, t.range.el, t.clients.el),
    h('h2', null, '기타 정보'),
    h('div', { class: 'tiles' }, t.fw.el, t.model.el, t.uptime.el, t.mem.el),
    h('h2', null, '포트 상태'),
    portTiles,
    h('h2', null, '접속 기기'),
    clientCard,
  );

  let stopped = false;
  let timer = null;

  function renderAll(r, where) {
    const [sys, board, nets, wl, leases, dhcp, devs] = r;
    const fail = (x) => x.set('정보를 불러오지 못했습니다.');

    // 인터넷
    if (nets.status === 'fulfilled') {
      const wan = findWan(nets.value);
      // 내부 네트워크는 보통 'lan'. 없으면 고정 IP이면서 기본 경로가 없는 첫 인터페이스
      const all = (nets.value.interface || []).filter((i) => i.interface !== 'loopback');
      const lan = all.find((i) => i.interface === 'lan')
        || all.find((i) => i.proto === 'static' && !(i.route || []).some((x) => x.target === '0.0.0.0' && x.mask === 0));
      if (!wan) {
        ['wanState', 'wanProto', 'wanTime', 'wanIp'].forEach((k) => t[k].set('-'));
        t.wanState.set('WAN 인터페이스 없음', 'warn');
      } else {
        const addr = (wan['ipv4-address'] || [])[0];
        if (wan.up && addr) t.wanState.set('인터넷에 정상적으로 연결됨', 'ok');
        else if (wan.up || wan.pending) t.wanState.set('연결 중', 'warn');
        else t.wanState.set('연결 안 됨', 'bad');
        t.wanProto.set(PROTO_LABEL[wan.proto] || wan.proto || '-');
        t.wanTime.set(wan.up ? fmtUptime(wan.uptime || 0) : '-');
        t.wanIp.set(addr ? addr.address : '-');
      }
      // IPv6: wan6(DHCPv6/고정) 인터페이스의 주소 또는 받은 프리픽스
      const [v6text, v6tone] = ipv6Summary(all);
      t.wanIp6.set(v6text, v6tone);
      const lanAddr = lan && (lan['ipv4-address'] || [])[0];
      t.lanIp.set(lanAddr ? lanAddr.address : '-');
      if (dhcp.status === 'fulfilled' && dhcp.value && dhcp.value.values && lanAddr) {
        const d = dhcp.value.values;
        const off = d.ignore === '1' || d.dhcpv4 === 'disabled';
        t.dhcp.set(off ? 'DHCP 서버 꺼짐' : 'DHCP 서버 동작 중', off ? 'warn' : 'ok');
        t.range.set(off ? '-' : dhcpRangeText(lanAddr.address, prefixToMask(lanAddr.mask), d.start, d.limit));
      } else {
        t.dhcp.set('-');
        t.range.set('-');
      }
    } else {
      ['wanState', 'wanProto', 'wanTime', 'wanIp', 'wanIp6', 'lanIp', 'dhcp', 'range'].forEach((k) => fail(t[k]));
    }

    // 무선
    if (wl.status === 'fulfilled') {
      const rows = wifiRows(wl.value);
      if (!rows.length) {
        const x = tile('wifi', '무선 네트워크');
        x.set('무선 장치가 없습니다.');
        wifiTiles.replaceChildren(x.el);
      } else {
        wifiTiles.replaceChildren(...rows.map((w) => {
          const x = tile('wifi', w.title);
          x.set(w.on ? '켜짐' : '꺼짐', w.on ? 'ok' : '');
          return x.el;
        }));
      }
    } else {
      const x = tile('wifi', '무선 네트워크');
      x.set('무선 장치가 없거나 정보를 불러오지 못했습니다.');
      wifiTiles.replaceChildren(x.el);
    }

    // 접속 기기
    let list = null;
    if (leases.status === 'fulfilled') list = parseLeases(leases.value.data || '');
    else if (leases.reason instanceof RpcError && leases.reason.code === UBUS_NOT_FOUND) list = [];
    if (list) {
      t.clients.set(list.length + '대');
      const ifs = nets.status === 'fulfilled' ? (nets.value.interface || []) : [];
      // 기기 IP가 속한 인터페이스(내부/게스트/VLAN 네트워크/VLAN 네트워크)
      const netOf = (ip) => {
        if (!isIPv4(ip)) return '-';
        const i = ifs.find((x) => (x['ipv4-address'] || []).some((a) => sameSubnet(ip, a.address, prefixToMask(a.mask))));
        return i ? (IFACE_LABEL_SHORT[i.interface] || i.interface) : '-';
      };
      clientCard.replaceChildren(list.length
        ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ...['이름', 'IP 주소', 'MAC 주소', '연결 (포트)', '네트워크'].map((x) => h('th', null, x)))),
          h('tbody', null, list.map((l) => h('tr', null,
            h('td', null, l.name), h('td', null, l.ip), h('td', null, l.mac),
            h('td', null, (where && where.get(l.mac.toLowerCase())) || h('span', { class: 'muted' }, '알 수 없음')),
            h('td', null, netOf(l.ip)))))))
        : h('span', { class: 'muted' }, '접속된 기기가 없습니다.'));
    } else {
      fail(t.clients);
      clientCard.replaceChildren(h('span', { class: 'muted' }, '정보를 불러오지 못했습니다.'));
    }

    // 기타
    if (sys.status === 'fulfilled') {
      const info = sys.value;
      const mem = info.memory || {};
      const available = mem.available != null ? mem.available : (mem.free || 0) + (mem.buffered || 0) + (mem.cached || 0);
      const usedPct = mem.total ? Math.round(((mem.total - available) / mem.total) * 100) : 0;
      t.uptime.set(fmtUptime(info.uptime || 0));
      t.mem.set(`${fmtMB(mem.total - available)} / ${fmtMB(mem.total)} (${usedPct}%)`);
    } else {
      fail(t.uptime);
      fail(t.mem);
    }
    const b = board.status === 'fulfilled' ? board.value : null;
    t.fw.set(b && b.release ? `${b.release.distribution || 'OpenWrt'} ${b.release.version || ''}`.trim() : '-');
    t.model.set(b ? (b.model || b.board_name || '-') : '-');

    // 포트 상태
    if (devs && devs.status === 'fulfilled') {
      const wanIf = nets.status === 'fulfilled' ? findWan(nets.value) : null;
      const ports = physicalPorts(devs.value, wanIf);
      if (!ports.length) {
        const x = tile('plug', '포트');
        x.set('포트별 상태를 알 수 없습니다 (스위치 칩 방식이거나 포트 정보 없음).');
        portTiles.replaceChildren(x.el);
      } else {
        portTiles.replaceChildren(...ports.map((p) => {
          const x = tile('plug', p.wan ? `${portLabel(p.name)} (인터넷)` : portLabel(p.name), p.wan ? '' : 't2');
          const d = p.dev;
          if (!d.present) x.set('장치 없음');
          else if (d.up === false) x.set('꺼짐');
          else if (!d.carrier) x.set('연결 안 됨');
          else x.set(`연결됨${d.speed ? ' · ' + speedText(d.speed) : ''}`, 'ok');
          return x.el;
        }));
      }
    } else {
      const x = tile('plug', '포트');
      x.set('정보를 불러오지 못했습니다.');
      portTiles.replaceChildren(x.el);
    }
  }

  async function refresh() {
    await readBoard(); // 포트 이름(portLabel)에 쓴다. 한 번 읽으면 기억한다.
    const r = await Promise.allSettled([
      ubus('system', 'info'),
      ubus('system', 'board'),
      ubus('network.interface', 'dump'),
      wirelessStatus(),
      ubus('file', 'read', { path: '/tmp/dhcp.leases' }),
      ubus('uci', 'get', { config: 'dhcp', section: 'lan' }),
      ubus('network.device', 'status'),
    ]);
    // 이름이 'lan'이 아닌 DHCP 섹션을 쓰는 공유기도 있다: interface 옵션으로 다시 찾는다
    if (r[5].status === 'fulfilled' && !(r[5].value && r[5].value.values)) {
      try {
        const all = await uciSections('dhcp');
        const d = (all || []).find((s) => s['.type'] === 'dhcp' && s.interface === 'lan');
        if (d) r[5] = { status: 'fulfilled', value: { values: d } };
      } catch { /* 그대로 둔다 */ }
    }
    if (stopped) return;
    const sys = r[0];
    // system.info는 ACL에 항상 허용되어 있으므로, 거부되면 세션이 만료된 것이다.
    if (sys.status === 'rejected' && sys.reason instanceof RpcError && sys.reason.code === RPC_ACCESS_DENIED) {
      logout('세션이 만료되었습니다. 다시 로그인해 주세요.');
      return;
    }
    let where = null;
    try {
      where = await clientLocations(r[3].status === 'fulfilled' ? r[3].value : {}, r[6].status === 'fulfilled' ? r[6].value : {});
    } catch { /* 위치를 몰라도 나머지는 보여 준다 */ }
    if (!stopped) renderAll(r, where);
  }

  // 숨겨진 탭에서는 갱신을 쉬지만, 첫 조회는 항상 한다 (백그라운드 탭에서 열어도 화면이 비지 않게).
  let first = true;
  async function tick() {
    if (first || !document.hidden) await refresh();
    first = false;
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/* ---------- 공통: 대화 상자 ---------- */

let openModal = null;

function closeModal() {
  if (openModal) openModal.remove();
  openModal = null;
}

function showModal(...kids) {
  closeModal();
  const card = h('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' }, ...kids);
  openModal = h('div', { class: 'modal' }, card);
  document.body.append(openModal);
  return card;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 공통: 권한 거부 처리 ---------- */

// -32002는 세션 만료와 ACL에 없는 호출 두 경우에 모두 온다. 세션이 살아 있는지 확인해서 구분한다.
async function handleDenied(e) {
  if (!(e instanceof RpcError) || e.code !== RPC_ACCESS_DENIED) return null;
  try {
    await ubus('system', 'info');
  } catch (e2) {
    if (e2 instanceof RpcError && e2.code === RPC_ACCESS_DENIED) {
      logout('세션이 만료되었습니다. 다시 로그인해 주세요.');
      return 'expired';
    }
  }
  return 'acl';
}

async function loadFailureText(e) {
  const kind = await handleDenied(e);
  if (kind === 'expired') return null;
  if (kind === 'acl') return '이 기능을 쓸 권한이 없습니다. 공유기의 ACL 파일(easyui.json)이 최신인지 확인해 주세요.';
  return '정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

/* ---------- 공통: 설정 적용 (UCI + 자동 되돌리기) ---------- */
// 흐름: 이 세션의 이전 변경 버림 -> set -> apply(rollback) -> 다시 연결되면 confirm.
// confirm하지 못하면(연결이 끊긴 채면) 공유기가 APPLY_TIMEOUT초 뒤 스스로 되돌린다.
// 되돌려지면 rpcd가 이 세션의 변경 목록을 되살려 두므로 revert로 지운다.

class ApplyError extends Error {}

// ops: 차례로 실행할 UCI 변경 목록
//   { op: 'set', config, section, values }
//   { op: 'add', config, type, values, name? }     (name 없으면 익명 섹션)
//   { op: 'delete', config, section, option? }
// opts.timeout: 자동 되돌림까지의 초 (무선/내부 네트워크처럼 다시 접속이 오래 걸릴 수 있으면 길게)
// opts.newHost: 내부 네트워크 주소가 바뀌는 경우 새 주소. 지금 주소로 닿지 않으면 새 주소로 넘어가 거기서 확인한다.
async function applyUci(ops, onTick, opts = {}) {
  const timeout = opts.timeout || APPLY_TIMEOUT;
  const configs = [...new Set(ops.map((o) => o.config))];
  const revertAll = () => Promise.all(configs.map((config) => ubus('uci', 'revert', { config }).catch(() => {})));
  const busy = () => new ApplyError('다른 설정을 적용하는 중입니다. 1분쯤 뒤에 다시 시도해 주세요.');
  for (const config of configs) {
    try {
      await ubus('uci', 'revert', { config });
    } catch (e) {
      // 실제 rpcd: 어떤 세션이든 적용이 확인 대기 중이면 revert를 [6]으로 거부한다 (25.12.6 확인)
      if (e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED) throw busy();
      throw e;
    }
  }
  try {
    for (const o of ops) {
      if (o.op === 'set') {
        await ubus('uci', 'set', { config: o.config, section: o.section, values: o.values });
      } else if (o.op === 'add') {
        await ubus('uci', 'add', { config: o.config, type: o.type, name: o.name, values: o.values || {} });
      } else if (o.op === 'delete') {
        await ubus('uci', 'delete', o.option
          ? { config: o.config, section: o.section, option: o.option }
          : { config: o.config, section: o.section });
      }
    }
    await ubus('uci', 'apply', { rollback: true, timeout });
  } catch (e) {
    await revertAll();
    if (e instanceof RpcError && e.code === UBUS_NO_DATA) return 'unchanged';
    if (e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED) throw busy();
    throw e;
  }
  return confirmLoop(Date.now() + timeout * 1000, configs, onTick, opts.newHost);
}

// 2초마다 confirm. 성공 = 새 설정으로도 브라우저가 공유기에 닿는다.
async function confirmLoop(deadline, configs, onTick, newHost) {
  const revertAll = () => Promise.all(configs.map((config) => ubus('uci', 'revert', { config }).catch(() => {})));
  for (;;) {
    await sleep(CONFIRM_INTERVAL_MS);
    if (onTick) onTick(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      await ubus('uci', 'confirm', {}, undefined, 4000);
      return 'applied';
    } catch (e) {
      if (e instanceof RpcError && e.code === UBUS_NO_DATA) {
        await revertAll();
        return 'rolledback';
      }
      if (e instanceof RpcError && e.code === RPC_ACCESS_DENIED) {
        throw new ApplyError('세션이 만료되었습니다. 다시 로그인한 뒤 설정을 확인해 주세요.');
      }
      // 그 밖의 오류는 네트워크가 다시 시작되는 중이라고 보고 계속 시도한다.
      if (newHost && newHost !== location.hostname && await probeHost(newHost)) {
        const q = new URLSearchParams({ sid: state.sid, cfg: configs.join(','), until: String(deadline) });
        location.href = `${location.protocol}//${hostWithPort(newHost)}${location.pathname}#/confirm?${q}`;
        return 'redirected';
      }
      if (Date.now() > deadline + 30000) return 'lost';
    }
  }
}

// 주소 + 지금 쓰는 포트 (기본 포트가 아닌 주소로 접속한 경우에도 같은 포트로 찾아간다)
function hostWithPort(host) {
  return location.port ? `${host}:${location.port}` : host;
}

// 다른 주소의 공유기에 닿는지 그림 파일로 확인한다 (CORS가 필요 없다).
function probeHost(host) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; resolve(false); }, 3000);
    img.onload = () => { clearTimeout(timer); resolve(true); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    const dir = location.pathname.replace(/[^/]*$/, '');
    img.src = `${location.protocol}//${hostWithPort(host)}${dir}ping.svg?t=${Date.now()}`;
  });
}

// 새 주소로 넘어온 뒤(#/confirm?sid=...) 확인을 마저 한다.
async function resumeConfirm(path) {
  const q = new URLSearchParams(path.slice('/confirm?'.length));
  state.sid = q.get('sid');
  saveSid(state.sid);
  history.replaceState(null, '', location.pathname + '#/'); // 주소창에서 세션 ID를 지운다
  state.main = null;
  route();
  const deadline = Number(q.get('until')) || Date.now() + APPLY_TIMEOUT * 1000;
  const configs = (q.get('cfg') || '').split(',').filter(Boolean);
  await showApplyProgress(() => confirmLoop(deadline, configs, null, null), '새 주소로 접속했습니다. 적용을 확인하는 중입니다...');
}

const APPLY_MESSAGES = {
  applied: '설정을 적용했습니다.',
  unchanged: '바뀐 내용이 없습니다.',
  rolledback: '적용한 설정으로 공유기와 연결할 수 없어 이전 설정으로 되돌렸습니다.',
  lost: '공유기와 연결할 수 없습니다. 설정은 자동으로 이전 상태로 되돌아갑니다. 잠시 후 새로고침해 주세요.',
};

async function showApplyProgress(run, firstText, noteText) {
  const status = h('p', null, firstText);
  showModal(h('h3', null, '설정 적용'), status, noteText ? h('p', { class: 'muted' }, noteText) : null);
  let result;
  let message;
  try {
    result = await run((left) => {
      status.textContent = `적용 결과를 확인하는 중입니다... (남은 시간 ${left}초)`;
    });
    if (result === 'redirected') return result;
    message = APPLY_MESSAGES[result];
  } catch (e) {
    result = 'error';
    if (await handleDenied(e) === 'expired') return result;
    message = e instanceof ApplyError ? e.message : '설정을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }
  const ok = h('button', { class: 'btn', type: 'button', onclick: closeModal }, '확인');
  showModal(h('h3', null, result === 'applied' ? '적용 완료' : '설정 적용'),
    h('p', { class: result === 'applied' || result === 'unchanged' ? '' : 'msg' }, message), ok);
  ok.focus();
  return result;
}

// 대화 상자로 진행 상황을 보여 주며 적용한다. 결과 문자열('applied' 등)을 돌려준다.
function runApply(ops, opts = {}) {
  const timeout = opts.timeout || APPLY_TIMEOUT;
  return showApplyProgress(
    (onTick) => applyUci(ops, onTick, opts),
    '설정을 저장하고 적용하는 중입니다...',
    opts.note || `${timeout}초 안에 공유기와 다시 연결되지 않으면 이전 설정으로 자동으로 되돌아갑니다.`);
}

/* ---------- 공통: 화면 조각 ---------- */

function card(title, ...kids) {
  return h('section', { class: 'card' }, title ? h('div', { class: 'card-head' }, h('h3', null, title)) : null, ...kids);
}

function messageCard(text) {
  return card(null, h('span', { class: 'muted' }, text));
}

function infoModal(title, text, isError) {
  const ok = h('button', { class: 'btn', type: 'button', onclick: closeModal }, '확인');
  showModal(h('h3', null, title), h('p', { class: isError ? 'msg' : '' }, text), ok);
  ok.focus();
}

// 예/아니오 확인. Promise<boolean>
function confirmDialog(title, text, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    const done = (v) => { closeModal(); resolve(v); };
    const ok = h('button', { class: 'btn' + (danger ? ' btn-danger' : ''), type: 'button', onclick: () => done(true) }, okLabel);
    showModal(h('h3', null, title),
      ...(Array.isArray(text) ? text : [text]).map((t) => (typeof t === 'string' ? h('p', null, t) : t)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => done(false) }, '취소'), ok));
    ok.focus();
  });
}

function selectEl(options, value) {
  const el = h('select', null, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  if (el.value !== value && value != null && value !== '') {
    el.append(h('option', { value }, value)); // 목록에 없는 기존 값도 보존
    el.value = value;
  }
  return el;
}

// 여러 개 고르는 드롭다운. 닫혀 있을 때는 고른 것만 이름표로 보이고, 누르면 아래에 체크 목록이 펼쳐진다.
// options: [[값, 목록 문구, (덧붙임 설명)]], chip(값): 이름표 요소(없으면 기본 이름표)
// 반환 { el(.field), values(), setError() }. <label> 안에 넣으면 클릭이 체크박스로 넘어가므로 div로 감싼다.
function multiSelect(title, options, selected, { chip, empty = '선택 안 함', hint } = {}) {
  const box = h('div', { class: 'ms', tabindex: '0', role: 'button' });
  const checks = options.map(([v, label, note]) => {
    const c = h('input', { type: 'checkbox' });
    c.checked = selected.includes(v);
    c.addEventListener('change', drawBox);
    return { v, c, el: h('label', null, c, h('span', null, label), note ? h('span', { class: 'muted' }, note) : null) };
  });
  const panel = h('div', { class: 'ms-panel', hidden: true },
    checks.length ? checks.map((x) => x.el) : h('div', { class: 'muted', style: 'padding:8px 10px' }, '고를 항목이 없습니다'));
  const err = h('small', { class: 'err', hidden: true });
  function drawBox() {
    const on = checks.filter((x) => x.c.checked);
    box.replaceChildren(...(on.length ? on.map((x) => (chip ? chip(x.v) : h('span', { class: 'ms-chip' }, x.v)))
      : [h('span', { class: 'ms-empty' }, empty)]));
  }
  const toggle = () => { panel.hidden = !panel.hidden; box.classList.toggle('open', !panel.hidden); };
  box.addEventListener('click', toggle);
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  drawBox();
  return {
    el: h('div', { class: 'field' }, h('span', null, title), box, panel, hint ? h('small', { class: 'hint' }, hint) : null, err),
    values: () => checks.filter((x) => x.c.checked).map((x) => x.v),
    setError(msg) { err.textContent = msg || ''; err.hidden = !msg; },
  };
}

function toggleEl(checked, label) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!checked;
  return { input, el: h('label', { class: 'check' }, input, h('span', null, label)) };
}

// uci 설정 전체를 섹션 배열로 (.index 순서). 설정 파일이 없으면 null.
async function uciSections(config) {
  let d;
  try {
    d = await ubus('uci', 'get', { config });
  } catch (e) {
    // 설정 파일 자체가 없으면(예: 무선 장치가 없는 공유기) rpcd는 [4]를 준다
    if (e instanceof RpcError && e.code === UBUS_NOT_FOUND) return null;
    throw e;
  }
  if (!d || !d.values) return null;
  return Object.values(d.values).sort((a, b) => a['.index'] - b['.index']);
}

async function uciConfigExists(config) {
  try {
    const d = await ubus('uci', 'configs');
    return (d.configs || []).includes(config);
  } catch {
    return false;
  }
}

async function readLeases() {
  try {
    const d = await ubus('file', 'read', { path: '/tmp/dhcp.leases' });
    return parseLeases(d.data || '');
  } catch {
    return [];
  }
}

function isMac(s) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(s).trim());
}

function isPort(s) {
  return /^\d{1,5}$/.test(String(s)) && +s >= 1 && +s <= 65535;
}

// '80' 또는 '8000-8080'
function isPortRange(s) {
  const m = String(s).trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
  if (!m) return false;
  if (!isPort(m[1]) || (m[2] && !isPort(m[2]))) return false;
  return !m[2] || +m[1] <= +m[2];
}

// 공유기가 다시 켜질 때까지 기다렸다가 새로고침한다.
async function waitForRouter(title, text, address) {
  const status = h('p', { class: 'muted' }, '공유기 응답을 기다리는 중...');
  showModal(h('h3', null, title), h('p', null, text), status);
  const host = address || location.hostname;
  const started = Date.now();
  await sleep(15000); // 바로 응답하면 아직 꺼지기 전일 수 있다
  for (;;) {
    status.textContent = `공유기 응답을 기다리는 중... (${Math.round((Date.now() - started) / 1000)}초)`;
    if (await probeHost(host)) {
      // 재시작하면 세션이 사라지므로 처음 화면(로그인)으로 새로 연다
      saveSid(null);
      const url = `${location.protocol}//${hostWithPort(host)}${location.pathname}`;
      if (host === location.hostname) { location.hash = ''; location.reload(); } else location.href = url;
      return;
    }
    await sleep(3000);
  }
}

/* ---------- 공통: 입력 검사 ---------- */

function isIPv4(s) {
  const parts = String(s).split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && +p <= 255);
}

function ipToInt(s) {
  return s.split('.').reduce((n, p) => (n * 256) + (+p), 0);
}

function isNetmask(s) {
  if (!isIPv4(s)) return false;
  const n = ipToInt(s);
  const inv = (~n) >>> 0;
  return n !== 0 && ((inv + 1) & inv) === 0; // 1이 앞에서부터 연속
}

function prefixToMask(p) {
  const n = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

function sameSubnet(a, b, mask) {
  const m = ipToInt(mask);
  return ((ipToInt(a) & m) >>> 0) === ((ipToInt(b) & m) >>> 0);
}

function asList(v) {
  if (v == null || v === '') return [];
  return Array.isArray(v) ? v : String(v).split(/\s+/).filter(Boolean);
}

// ipaddr는 '1.2.3.4' + netmask 또는 ['1.2.3.4/24'] (25.12 기본 형식) 둘 다 올 수 있다.
function readAddr(cfg) {
  const [first] = asList(cfg.ipaddr);
  if (!first) return { ip: '', mask: cfg.netmask || '' };
  const [ip, prefix] = first.split('/');
  return { ip, mask: prefix ? prefixToMask(+prefix) : (cfg.netmask || '') };
}

// 폼 컨트롤 묶음. 오류 문구 칸을 함께 만든다.
function formField(label, input, hint) {
  const err = h('small', { class: 'err', hidden: true });
  const el = h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'hint' }, hint) : null, err);
  return {
    el,
    setError(msg) {
      err.textContent = msg || '';
      err.hidden = !msg;
      input.classList.toggle('invalid', !!msg);
    },
  };
}

/* ---------- 페이지: 인터넷 설정 ---------- */

const WAN_PROTOS = [
  { value: 'dhcp', label: '자동 IP (DHCP)', desc: '대부분의 가정용 인터넷. 통신사 모뎀이 주소를 자동으로 줍니다.' },
  { value: 'static', label: '고정 IP', desc: '통신사에서 받은 IP 주소, 게이트웨이, DNS를 직접 입력합니다.' },
  { value: 'pppoe', label: 'PPPoE', desc: '통신사에서 받은 아이디와 비밀번호로 접속합니다.' },
];

function readWanForm(cfg) {
  const { ip, mask } = readAddr(cfg);
  const dns = asList(cfg.dns);
  return {
    proto: cfg.proto || 'dhcp',
    ipaddr: ip,
    netmask: mask || '255.255.255.0',
    gateway: cfg.gateway || '',
    dns1: dns[0] || '',
    dns2: dns[1] || '',
    customDns: cfg.peerdns === '0',
    username: cfg.username || '',
    password: cfg.password || '',
  };
}

// 폼 값 -> uci set에 넘길 값. 쓰지 않는 옵션은 ''로 지운다 (없는 옵션에 ''를 줘도 rpcd는 아무 일도 하지 않는다).
function wanValues(f) {
  const v = { proto: f.proto, ipaddr: '', netmask: '', gateway: '', username: '', password: '', dns: '', peerdns: '' };
  const dns = [f.dns1, f.dns2].map((s) => s.trim()).filter(Boolean);
  if (f.proto === 'static') {
    Object.assign(v, { ipaddr: f.ipaddr.trim(), netmask: f.netmask.trim(), gateway: f.gateway.trim(), dns: dns.length ? dns : '' });
  } else {
    if (f.proto === 'pppoe') Object.assign(v, { username: f.username.trim(), password: f.password });
    if (f.customDns) Object.assign(v, { peerdns: '0', dns });
  }
  return v;
}

function validateWan(f, lan) {
  const errors = {};
  const dnsNeeded = f.proto === 'static' || f.customDns;
  if (f.proto === 'static') {
    if (!isIPv4(f.ipaddr)) errors.ipaddr = 'IP 주소 형식이 올바르지 않습니다. (예: 203.0.113.10)';
    if (!isNetmask(f.netmask)) errors.netmask = '서브넷 마스크 형식이 올바르지 않습니다. (예: 255.255.255.0)';
    if (!isIPv4(f.gateway)) errors.gateway = '게이트웨이 형식이 올바르지 않습니다.';
    else if (!errors.ipaddr && !errors.netmask) {
      if (f.gateway === f.ipaddr) errors.gateway = '게이트웨이는 IP 주소와 달라야 합니다.';
      else if (!sameSubnet(f.ipaddr, f.gateway, f.netmask)) errors.gateway = '게이트웨이가 IP 주소와 같은 대역에 있지 않습니다.';
    }
    if (!errors.ipaddr && !errors.netmask && lan && lan.ip && isNetmask(lan.mask)
        && (sameSubnet(f.ipaddr, lan.ip, lan.mask) || sameSubnet(f.ipaddr, lan.ip, f.netmask))) {
      errors.ipaddr = `내부 네트워크(${lan.ip})와 같은 대역입니다. 다른 대역의 주소를 입력해 주세요.`;
    }
  }
  if (f.proto === 'pppoe') {
    if (!f.username.trim()) errors.username = '아이디를 입력해 주세요.';
    if (!f.password) errors.password = '비밀번호를 입력해 주세요.';
  }
  if (dnsNeeded) {
    if (!f.dns1.trim()) errors.dns1 = 'DNS 서버를 하나 이상 입력해 주세요.';
    else if (!isIPv4(f.dns1.trim())) errors.dns1 = 'DNS 주소 형식이 올바르지 않습니다.';
    if (f.dns2.trim() && !isIPv4(f.dns2.trim())) errors.dns2 = 'DNS 주소 형식이 올바르지 않습니다.';
  }
  return errors;
}

function wanStatusLine(dump) {
  const wan = dump && findWan(dump);
  if (!wan) return h('span', { class: 'muted' }, '현재 연결 상태를 알 수 없습니다.');
  const addr = (wan['ipv4-address'] || [])[0];
  const kind = wan.up && addr ? ['ok', '연결됨'] : (wan.up || wan.pending) ? ['warn', '연결 중'] : ['', '연결 안 됨'];
  return h('div', { class: 'status-line' },
    h('span', { class: 'pill' + (kind[0] ? ' ' + kind[0] : '') }, kind[1]),
    h('span', null, PROTO_LABEL[wan.proto] || wan.proto || '-'),
    addr ? h('span', { class: 'muted' }, addr.address) : null);
}

function internetPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('인터넷 설정'), body);
  let alive = true;

  async function load() {
    let wan, lan, dump;
    try {
      [wan, lan, dump] = await Promise.all([
        ubus('uci', 'get', { config: 'network', section: 'wan' }),
        ubus('uci', 'get', { config: 'network', section: 'lan' }),
        ubus('network.interface', 'dump').catch(() => null),
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(h('div', { class: 'card' }, h('span', { class: 'muted' }, text)));
      return;
    }
    if (!alive) return;
    if (!wan || !wan.values) {
      body.replaceChildren(h('div', { class: 'card' }, h('span', { class: 'muted' }, '인터넷(WAN) 설정을 찾을 수 없습니다.')));
      return;
    }
    render(wan.values, lan && lan.values ? readAddr(lan.values) : null, dump);
  }

  function render(cfg, lan, dump) {
    const initial = readWanForm(cfg);
    const known = WAN_PROTOS.some((p) => p.value === initial.proto);
    const f = { ...initial, proto: known ? initial.proto : 'dhcp' };

    const input = (key, attrs) => {
      const el = h('input', { type: 'text', value: f[key], autocomplete: 'off', spellcheck: 'false', ...attrs });
      el.addEventListener('input', () => { f[key] = el.value; });
      return el;
    };
    const fields = {
      ipaddr: formField('IP 주소', input('ipaddr', { inputmode: 'decimal', placeholder: '203.0.113.10' })),
      netmask: formField('서브넷 마스크', input('netmask', { inputmode: 'decimal' })),
      gateway: formField('게이트웨이', input('gateway', { inputmode: 'decimal', placeholder: '203.0.113.1' })),
      username: formField('아이디', input('username')),
      password: formField('비밀번호', input('password', { type: 'password', autocomplete: 'new-password' })),
      dns1: formField('기본 DNS', input('dns1', { inputmode: 'decimal', placeholder: '1.1.1.1' })),
      dns2: formField('보조 DNS (선택)', input('dns2', { inputmode: 'decimal', placeholder: '8.8.8.8' })),
    };

    const customDns = h('input', { type: 'checkbox' });
    customDns.checked = f.customDns;
    const customDnsRow = h('label', { class: 'check' }, customDns, h('span', null, 'DNS 서버를 직접 지정'));

    const staticBox = h('div', { class: 'fieldset' }, fields.ipaddr.el, fields.netmask.el, fields.gateway.el);
    const pppoeBox = h('div', { class: 'fieldset' }, fields.username.el, fields.password.el);
    const dnsBox = h('div', { class: 'fieldset' }, fields.dns1.el, fields.dns2.el);

    const radios = WAN_PROTOS.map((p) => {
      const r = h('input', { type: 'radio', name: 'wanproto', value: p.value });
      r.checked = f.proto === p.value;
      r.addEventListener('change', () => { f.proto = p.value; sync(); });
      return h('label', { class: 'choice' }, r, h('span', null, h('b', null, p.label), h('small', null, p.desc)));
    });

    customDns.addEventListener('change', () => { f.customDns = customDns.checked; sync(); });

    function sync() {
      staticBox.hidden = f.proto !== 'static';
      pppoeBox.hidden = f.proto !== 'pppoe';
      customDnsRow.hidden = f.proto === 'static';
      dnsBox.hidden = !(f.proto === 'static' || f.customDns);
      for (const fld of Object.values(fields)) fld.setError(null);
    }

    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const errors = validateWan(f, lan);
      for (const [k, fld] of Object.entries(fields)) fld.setError(errors[k]);
      if (Object.keys(errors).length) return;
      const values = wanValues(f);
      if (JSON.stringify(values) === JSON.stringify(wanValues(initial))) {
        showModal(h('h3', null, '설정 적용'), h('p', null, '바뀐 내용이 없습니다.'),
          h('button', { class: 'btn', type: 'button', onclick: closeModal }, '확인'));
        return;
      }
      applyBtn.disabled = true;
      const result = await runApply([{ op: 'set', config: 'network', section: 'wan', values }]);
      applyBtn.disabled = false;
      if (alive && (result === 'applied' || result === 'rolledback')) load();
    });

    body.replaceChildren(
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, '현재 상태')),
        wanStatusLine(dump)),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '연결 방식')),
        known ? null : h('p', { class: 'msg warn-msg' },
          `현재 연결 방식(${initial.proto})은 이 화면에서 지원하지 않습니다. 여기서 적용하면 기존 설정을 덮어씁니다.`),
        h('div', { class: 'choices' }, radios),
        staticBox, pppoeBox, customDnsRow, dnsBox,
        h('div', { class: 'actions' }, applyBtn)),
    );
    sync();
  }

  load();
  return () => { alive = false; };
}

/* ---------- 관리자 비밀번호 미설정 경고 ---------- */
// 순정 OpenWrt는 root 비밀번호가 비어 있고, 그 상태에선 어떤 비밀번호로도 로그인된다 (25.12.6 확인).
// 무작위 비밀번호로 로그인이 되는지로 미설정을 판단한다.

async function checkEmptyPassword() {
  const banner = state.banner;
  let empty = false;
  try {
    const probe = 'probe-' + Math.random().toString(36).slice(2) + Date.now();
    const d = await ubus('session', 'login', { username: 'root', password: probe, timeout: 5 }, NULL_SESSION);
    empty = true;
    ubus('session', 'destroy', {}, d.ubus_rpc_session).catch(() => {});
  } catch { /* 거부되면 비밀번호가 설정된 것 */ }
  if (!empty || banner !== state.banner) return;
  banner.replaceChildren(h('div', { class: 'banner' },
    h('span', null, '관리자 비밀번호가 설정되어 있지 않아 같은 네트워크의 누구나 이 화면에 들어올 수 있습니다.'),
    h('button', { class: 'btn btn-inline', type: 'button', onclick: showPasswordDialog }, '비밀번호 설정')));
}

function showPasswordDialog() {
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const f1 = formField('새 비밀번호', pw1, '8자 이상');
  const f2 = formField('새 비밀번호 확인', pw2);
  const err = h('p', { class: 'msg', hidden: true });
  const save = h('button', { class: 'btn', type: 'button' }, '저장');
  const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
  save.addEventListener('click', async () => {
    f1.setError(pw1.value.length < 8 ? '8자 이상 입력해 주세요.' : null);
    f2.setError(pw1.value !== pw2.value ? '두 비밀번호가 다릅니다.' : null);
    if (pw1.value.length < 8 || pw1.value !== pw2.value) return;
    save.disabled = true;
    err.hidden = true;
    try {
      await ubus('rpc-sys', 'password_set', { user: 'root', password: pw1.value });
    } catch (e) {
      if (await handleDenied(e) === 'expired') return;
      err.textContent = '비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.';
      err.hidden = false;
      save.disabled = false;
      return;
    }
    if (state.banner) state.banner.replaceChildren();
    showModal(h('h3', null, '비밀번호 설정 완료'),
      h('p', null, '다음 로그인부터 새 비밀번호를 사용하세요.'),
      h('button', { class: 'btn', type: 'button', onclick: closeModal }, '확인'));
  });
  showModal(h('h3', null, '관리자 비밀번호 설정'),
    h('p', { class: 'muted' }, '이 화면과 SSH(root) 로그인에 함께 쓰입니다.'),
    err, f1.el, f2.el, h('div', { class: 'actions' }, cancel, save));
  pw1.focus();
}

// 다른 페이지 파일(lan.js 등)이 여기에 자기를 등록한다. 시작은 main.js.
const PAGES = { '/': dashboardPage, '/internet': internetPage };
