// 무선 메시 구성도 (mesh.js의 '메시 구성' 카드)
//   메시에 참가한 공유기를 이 공유기 아래에 나무 모양으로 보여 주고, 이름과 관리 주소를 자동으로 찾은 뒤 고칠 수 있게 한다.
//
//   어떤 공유기가 있는지:
//     - 직접 연결된 공유기: iwinfo assoclist (신호, 속도, 연결 상태 'mesh plink')
//     - 다른 공유기를 거쳐 연결된 공유기까지: iw dev <메시> mpath dump (목적지, 다음 공유기, 단계 수)
//   이름과 IP를 자동으로 찾는 방법:
//     메시로 오가는 프레임의 출발 주소는 그 공유기의 내부 네트워크(br-lan) MAC이고, 메시 MAC과 다르다.
//     iw ... mpp dump가 'br-lan MAC -> 그것을 대신 보내는 메시 공유기'를 알려 주므로,
//     그 MAC을 ARP 표(/proc/net/arp)에서 찾아 IP를 얻고, DHCP 임대 목록에서 이름을 얻는다.
//     (메시 공유기는 보통 고정 IP라 임대 목록에 이름이 없을 수 있다. 그러면 '메시 공유기 XX:XX'로 부른다)
//   사용자가 고친 이름/IP는 /etc/wrttime-mesh.json에 저장한다 (백업과 펌웨어 업그레이드 때 유지).

const MESH_NAMES_FILE = '/etc/wrttime-mesh.json';
const IW_BIN = '/usr/sbin/iw';
const MESH_REFRESH_MS = 15000;

// iw의 표 출력 -> [{ 'DEST_ADDR': ..., ... }]. 머리글의 두 단어 이름을 한 단어로 바꿔 열을 맞춘다.
function parseIwTable(text) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const head = lines[0].replace(/DEST ADDR/g, 'DEST_ADDR').replace(/NEXT HOP/g, 'NEXT_HOP').replace(/PROXY NODE/g, 'PROXY_NODE')
    .trim().split(/\s+/);
  if (!head.includes('DEST_ADDR')) return [];
  return lines.slice(1).map((l) => {
    const v = l.trim().split(/\s+/);
    return Object.fromEntries(head.map((k, i) => [k, v[i]]));
  }).filter((r) => isMac(r.DEST_ADDR || ''));
}

// /proc/net/arp -> [{ ip, mac, dev }] (완성된 항목만)
function parseArp(text) {
  return String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && c[2] !== '0x0' && isMac(c[3]) && c[3] !== '00:00:00:00:00:00')
    .map((c) => ({ ip: c[0], mac: c[3].toLowerCase(), dev: c[5] }));
}

async function readMeshNames() {
  try {
    const d = JSON.parse((await ubus('file', 'read', { path: MESH_NAMES_FILE })).data || '{}');
    return d && typeof d.nodes === 'object' && d.nodes ? d.nodes : {};
  } catch {
    return {}; // 아직 저장한 적이 없다
  }
}

function writeMeshNames(nodes) {
  return ubus('file', 'write', { path: MESH_NAMES_FILE, data: JSON.stringify({ nodes }, null, 1) + '\n' });
}

// 메시 전체 정보를 모은다. 하나가 실패해도 나머지로 그린다.
async function meshSnapshot(ifname) {
  const iw = (what) => ubus('file', 'exec', { command: IW_BIN, params: ['dev', ifname, what, 'dump'] }, state.sid, 15000)
    .then((r) => (r.code === 0 ? parseIwTable(r.stdout) : []), () => []);
  const [assoc, mpath, mpp, arp, leases, saved] = await Promise.all([
    ifname ? ubus('iwinfo', 'assoclist', { device: ifname }).then((d) => d.results || [], () => []) : [],
    ifname ? iw('mpath') : [],
    ifname ? iw('mpp') : [],
    ubus('file', 'read', { path: '/proc/net/arp' }).then((d) => parseArp(d.data), () => []),
    readLeases(),
    readMeshNames(),
  ]);
  const lower = (m) => String(m || '').toLowerCase();
  const nodes = new Map();
  const node = (mac) => {
    const k = lower(mac);
    if (!nodes.has(k)) nodes.set(k, { mac: k, via: null, hops: 1, assoc: null, metric: null, live: true });
    return nodes.get(k);
  };
  for (const a of assoc) node(a.mac).assoc = a;
  for (const p of mpath) {
    const n = node(p.DEST_ADDR);
    const next = lower(p.NEXT_HOP);
    if (next && next !== n.mac && next !== '00:00:00:00:00:00') n.via = next;
    n.hops = +p.HOP_COUNT || (n.via ? 2 : 1);
    n.metric = p.METRIC != null ? +p.METRIC : null;
  }
  // 경유 공유기가 목록에 없으면(경로 정보가 오래됨) 바로 아래로 붙인다
  for (const n of nodes.values()) if (n.via && !nodes.has(n.via)) n.via = null;

  for (const n of nodes.values()) {
    // 이 공유기가 대신 보내는 내부 MAC들 + 메시 MAC 자신
    const macs = [n.mac, ...mpp.filter((r) => lower(r.PROXY_NODE) === n.mac).map((r) => lower(r.DEST_ADDR))];
    const hits = arp.filter((x) => macs.includes(x.mac));
    const hit = hits.find((x) => /^br-/.test(x.dev)) || hits[0];
    n.autoIp = hit ? hit.ip : '';
    const lease = leases.find((l) => (n.autoIp && l.ip === n.autoIp) || macs.includes(lower(l.mac)));
    n.autoName = lease && lease.name !== '이름 없음' ? lease.name : '';
    if (!n.autoIp && lease) n.autoIp = lease.ip;
  }
  // 저장해 둔 공유기 중 지금 안 보이는 것은 '연결 끊김'으로 보여 준다
  for (const mac of Object.keys(saved)) {
    if (!nodes.has(mac) && isMac(mac)) nodes.set(mac, { mac, via: null, hops: 0, assoc: null, metric: null, live: false, autoIp: '', autoName: '' });
  }
  for (const n of nodes.values()) {
    const s = saved[n.mac] || {};
    n.name = s.name || n.autoName || `메시 공유기 ${n.mac.slice(-5).toUpperCase()}`;
    n.ip = s.ip || n.autoIp;
    n.edited = !!(s.name || s.ip);
  }
  return { nodes: [...nodes.values()], saved };
}

function meshLinkQuality(n) {
  if (!n.live) return { cls: 'off', text: '연결 끊김' };
  const plink = n.assoc && (n.assoc['mesh plink'] || n.assoc.mesh_plink);
  if (plink && plink !== 'ESTAB') return { cls: 'warn', text: '연결 중' };
  const sig = n.assoc ? n.assoc.signal : null;
  if (sig == null) return { cls: 'ok', text: '연결됨' };
  if (sig >= -65) return { cls: 'ok', text: '좋음' };
  if (sig >= -75) return { cls: 'warn', text: '보통' };
  return { cls: 'bad', text: '약함' };
}

// 메시 구성 카드. self: 이 공유기 { name, model, meshId, clients }
function meshMapCard(ifname, self, isAlive) {
  const tree = h('div', { class: 'mesh-tree' }, h('span', { class: 'muted' }, '메시 공유기를 찾는 중...'));
  const refreshBtn = h('button', { class: 'btn btn-ghost btn-small', type: 'button' }, '새로고침');
  let snap = null;
  let timer = null;
  let busy = false;

  async function refresh() {
    if (busy || !isAlive()) return;
    busy = true;
    clearTimeout(timer);
    try {
      snap = await meshSnapshot(ifname);
      if (isAlive()) draw();
    } finally {
      busy = false;
      if (isAlive()) timer = setTimeout(refresh, MESH_REFRESH_MS);
    }
  }
  refreshBtn.addEventListener('click', refresh);

  function draw() {
    const pings = [];
    const row = (n) => {
      const q = meshLinkQuality(n);
      const via = n.via && snap.nodes.find((x) => x.mac === n.via);
      const status = h('span', { class: 'pill off' }, n.ip ? '확인 중' : 'IP 모름');
      if (n.ip && n.live) pings.push([n.ip, status]);
      else if (!n.live) status.textContent = '-';
      const rate = n.assoc && n.assoc.rx && n.assoc.rx.rate ? `${Math.round(n.assoc.rx.rate / 1000)} Mbps` : '';
      const where = !n.live ? '지금 보이지 않음' : via ? `${via.name} 경유 · ${n.hops}단계` : '직접 연결';
      const edit = h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editNode(n) }, '수정');
      return h('div', { class: 'mesh-row' + (n.live ? '' : ' gone') },
        h('div', { class: 'mesh-ico' }, icon('router')),
        h('div', { class: 'mesh-main' },
          h('div', { class: 'mesh-name' }, h('b', null, n.name), n.edited ? null : h('span', { class: 'muted' }, ' (자동)')),
          h('div', { class: 'muted' }, [n.ip || 'IP 모름', n.mac.toUpperCase()].join(' · '))),
        h('div', { class: 'mesh-link' },
          n.assoc ? wifiBars(n.assoc.signal) : null,
          h('span', { class: 'mesh-q ' + q.cls }, q.text),
          h('div', { class: 'muted' }, [where, n.assoc && n.assoc.signal != null ? `${n.assoc.signal} dBm` : '', rate].filter(Boolean).join(' · '))),
        h('div', { class: 'mesh-act' },
          status,
          n.ip && n.live ? h('a', { class: 'btn btn-ghost btn-small', href: `${location.protocol}//${n.ip}/`, target: '_blank', rel: 'noopener' }, '관리 화면') : null,
          edit));
    };
    // 나무 모양: 경유 공유기 아래로 붙인다
    const branch = (parent) => {
      const kids = snap.nodes.filter((n) => (parent ? n.via === parent : !n.via))
        .sort((a, b) => (b.live - a.live) || a.name.localeCompare(b.name));
      if (!kids.length) return null;
      return h('div', { class: 'mesh-children' }, kids.map((n) => h('div', { class: 'mesh-item' }, row(n), branch(n.mac))));
    };
    const liveCount = snap.nodes.filter((n) => n.live).length;
    tree.replaceChildren(
      h('div', { class: 'mesh-root' },
        h('div', { class: 'mesh-ico' }, icon('router')),
        h('div', { class: 'mesh-main' },
          h('div', { class: 'mesh-name' }, h('b', null, self.name), h('span', null, ' (이 공유기)')),
          h('div', null, [self.model, `메시 ID ${self.meshId}`].filter(Boolean).join(' · '))),
        h('div', { class: 'mesh-sum' }, `메시 공유기 ${liveCount}대`, self.clients != null ? ` · 무선 기기 ${self.clients}대` : '')),
      branch(null) || h('p', { class: 'muted mesh-empty' }, ifname
        ? '연결된 메시 공유기가 없습니다. 다른 공유기의 대역, 채널, 메시 ID, 암호가 같은지 확인해 주세요.'
        : '메시가 아직 켜지지 않았습니다. 패키지와 채널을 확인해 주세요.'));
    // 응답 확인은 그린 뒤에 하나씩 채운다
    for (const [ip, el] of pings) {
      meshPing(ip).then((ok) => {
        el.className = 'pill ' + (ok ? 'ok' : 'bad');
        el.textContent = ok ? '응답' : '응답 없음';
      });
    }
  }

  function editNode(n) {
    const name = h('input', { type: 'text', value: (snap.saved[n.mac] || {}).name || '', placeholder: n.autoName || n.name, spellcheck: 'false' });
    const ip = h('input', { type: 'text', value: (snap.saved[n.mac] || {}).ip || '', placeholder: n.autoIp || '예: 192.168.1.2', spellcheck: 'false', inputmode: 'decimal' });
    const fName = formField('이름', name, n.autoName ? `자동으로 찾은 이름: ${n.autoName}` : '비우면 자동 이름을 씁니다');
    const fIp = formField('관리 주소 (IP)', ip, n.autoIp ? `자동으로 찾은 주소: ${n.autoIp}` : '자동으로 찾지 못했습니다. 그 공유기의 내부 주소를 적어 주세요');
    const save = h('button', { class: 'btn', type: 'button' }, '저장');
    const reset = h('button', { class: 'btn btn-ghost', type: 'button' }, n.live ? '자동으로 되돌리기' : '목록에서 지우기');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    const store = async (entry) => {
      const nodes = await readMeshNames(); // 다른 화면에서 바꾼 것과 섞이지 않게 다시 읽는다
      if (entry) nodes[n.mac] = entry; else delete nodes[n.mac];
      try {
        await writeMeshNames(nodes);
        closeModal();
        refresh();
      } catch (e) {
        if (await handleDenied(e) !== 'expired') infoModal('메시 공유기', '저장하지 못했습니다. 최신 wrtTIME를 다시 설치해 주세요.', true);
      }
    };
    save.addEventListener('click', () => {
      fName.setError(null); fIp.setError(null);
      const v = { name: name.value.trim(), ip: ip.value.trim() };
      if (v.name.length > 40) { fName.setError('40자까지 쓸 수 있습니다.'); return; }
      if (v.ip && !isIPv4(v.ip)) { fIp.setError('IPv4 주소를 입력해 주세요.'); return; }
      store(v.name || v.ip ? Object.fromEntries(Object.entries(v).filter(([, x]) => x)) : null);
    });
    reset.addEventListener('click', () => store(null));
    showModal(h('h3', null, '메시 공유기 정보'),
      h('p', { class: 'muted' }, `메시 MAC ${n.mac.toUpperCase()}`),
      fName.el, fIp.el,
      h('div', { class: 'actions' }, cancel, reset, save));
    name.focus();
  }

  refresh();
  return {
    el: h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '메시 구성'), refreshBtn),
      tree,
      h('p', { class: 'muted' }, '이름과 주소는 자동으로 찾은 값입니다. 다르면 수정을 눌러 고쳐 주세요. 신호가 -70 dBm보다 약하면 공유기를 더 가깝게 두세요.')),
    stop() { clearTimeout(timer); },
  };
}

// 공유기에서 ping 한 번 (응답 여부만)
async function meshPing(ip) {
  for (const command of ['/bin/ping', '/usr/bin/ping']) {
    try {
      const r = await ubus('file', 'exec', { command, params: ['-c', '1', '-W', '1', '-4', ip] }, state.sid, 10000);
      return r.code === 0;
    } catch (e) {
      if (e instanceof RpcError && e.code === UBUS_NOT_FOUND) continue;
      return false;
    }
  }
  return false;
}
