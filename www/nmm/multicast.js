// IPTV / 멀티캐스트 설정 (특수 기능)
//   IGMP 프록시: igmpproxy 패키지. 인터넷 쪽(업스트림)에서 오는 멀티캐스트(IPTV 방송)를 내부 네트워크(다운스트림)로 전달한다.
//     igmpproxy 설정에는 켜고 끄는 옵션이 없으므로 서비스를 enable/disable하고 다시 시작한다.
//     phyint마다 zone을 적어 두면 igmpproxy 시작 스크립트가 필요한 방화벽 규칙(IGMP 허용, 멀티캐스트 전달)을 스스로 추가한다.
//   IGMP 스누핑: network 설정의 브리지 장치 옵션(igmp_snooping, multicast_querier). 패키지가 필요 없다.

const MC_INIT = '/etc/init.d/igmpproxy';
const MC_EXEC_TIMEOUT_MS = 30000;
const MC_ANY_SOURCE = '0.0.0.0/0';
const MC_PKG_DEFAULT_ALTNET = '192.168.1.0/24';

function isIPv4Cidr(s) {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(s);
  return !!m && isIPv4(m[1]) && +m[2] <= 32;
}

// 시작 스크립트가 켜져 있는지 (/etc/rc.d/S??igmpproxy가 있는지)
async function igmpproxyEnabled() {
  try {
    const d = await ubus('file', 'list', { path: '/etc/rc.d' });
    return (d.entries || []).some((e) => /^S\d+igmpproxy$/.test(e.name));
  } catch {
    return false;
  }
}

// 인터페이스가 들어 있는 방화벽 영역 이름
function zoneOf(fw, net) {
  const z = (fw || []).find((s) => s['.type'] === 'zone' && asList(s.network).includes(net));
  return z ? z.name : '';
}

function multicastPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('IPTV / 멀티캐스트 설정'), body);
  let alive = true;

  async function load() {
    let exists, proxy, net, fw, enabled;
    try {
      exists = await uciConfigExists('igmpproxy');
      [proxy, net, fw, enabled] = await Promise.all([
        exists ? uciSections('igmpproxy') : null,
        uciSections('network'),
        uciSections('firewall'),
        exists ? igmpproxyEnabled() : false,
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    body.replaceChildren(
      exists ? proxyCard(proxy || [], net || [], fw || [], enabled) : missingPackageCard('igmpproxy', 'IPTV(IGMP 프록시)', load),
      snoopCard(net || []),
      h('p', { class: 'muted' }, 'IPTV에 VLAN 태그가 필요한 통신사라면 ',
        h('a', { href: '#/vlan' }, 'VLAN 설정'), '에서 인터넷 VLAN을 먼저 맞춰 주세요.'));
  }

  /* ----- IGMP 프록시 ----- */

  function proxyCard(proxy, net, fw, enabled) {
    const global = proxy.find((s) => s['.type'] === 'igmpproxy') || null;
    const phys = proxy.filter((s) => s['.type'] === 'phyint');
    const upSec = phys.find((s) => s.direction === 'upstream') || null;
    const downSecs = phys.filter((s) => s.direction === 'downstream');

    // IPv4 인터페이스만 (루프백, IPv6 전용 인터페이스 제외)
    const ifaces = net.filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback'
      && !/^dhcpv6$|^6in4$|^6to4$|^6rd$/.test(s.proto || ''));
    const names = ifaces.map((s) => s['.name']);
    const label = (n) => {
      const z = zoneOf(fw, n);
      return n === 'wan' ? '인터넷 (wan)' : n === 'lan' ? '내부 네트워크 (lan)' : z ? `${n} (${z} 영역)` : n;
    };

    const on = toggleEl(enabled, 'IGMP 프록시 사용 (IPTV 셋톱박스를 공유기 뒤에 연결)');
    const upCur = upSec ? upSec.network : (names.includes('wan') ? 'wan' : names[0] || '');
    const up = selectEl(names.map((n) => [n, label(n)]), upCur);
    const fUp = formField('IPTV 방송을 받는 쪽 (업스트림)', up, '보통 인터넷 (wan)');
    const downCur = downSecs.length ? downSecs.map((s) => s.network) : names.filter((n) => n === 'lan');
    const down = multiSelect('IPTV 셋톱박스가 연결된 쪽 (다운스트림)', names.map((n) => [n, label(n)]), downCur,
      { chip: (v) => h('span', { class: 'ms-chip' }, label(v)), empty: '선택 안 함', hint: '보통 내부 네트워크 (lan)' });
    const quick = toggleEl(global ? global.quickleave === '1' : true, '빠른 채널 전환 (quickleave)');
    // 패키지 기본값(192.168.1.0/24)은 IPTV 방송 서버를 막으므로, 그대로면 모든 주소로 바꿔 보여 준다
    const curAlt = upSec ? asList(upSec.altnet).join(' ') : '';
    const alt = h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off',
      value: !curAlt || curAlt === MC_PKG_DEFAULT_ALTNET ? MC_ANY_SOURCE : curAlt });
    const fAlt = formField('허용할 방송 출발지 주소', alt,
      `통신사 방송 서버 주소 대역. 모르면 ${MC_ANY_SOURCE} (모든 주소). 여러 개는 띄어 쓰기로 구분`);

    const initExec = (action) => ubus('file', 'exec', { command: MC_INIT, params: [action] }, state.sid, MC_EXEC_TIMEOUT_MS);
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fUp.setError(null); down.setError(null); fAlt.setError(null);
      const want = on.input.checked;
      const downs = down.values();
      const alts = alt.value.trim().split(/\s+/).filter(Boolean);
      let bad = false;
      if (want) {
        if (!up.value) { fUp.setError('인터페이스를 골라 주세요.'); bad = true; }
        if (!downs.length) { down.setError('하나 이상 골라 주세요.'); bad = true; }
        if (downs.includes(up.value)) { down.setError('업스트림으로 고른 인터페이스는 여기에 넣을 수 없습니다.'); bad = true; }
        if (!alts.length || !alts.every(isIPv4Cidr)) { fAlt.setError('주소/길이 형식으로 입력해 주세요 (예: 0.0.0.0/0)'); bad = true; }
      }
      if (bad) return;

      applyBtn.disabled = true;
      if (want) {
        // phyint는 이 화면이 전부 다시 쓴다 (업스트림 1개 + 다운스트림 여러 개)
        const ops = phys.map((s) => ({ op: 'delete', config: 'igmpproxy', section: s['.name'] }));
        const globalValues = { quickleave: quick.input.checked ? '1' : '0' };
        ops.push(global
          ? { op: 'set', config: 'igmpproxy', section: global['.name'], values: globalValues }
          : { op: 'add', config: 'igmpproxy', type: 'igmpproxy', values: globalValues });
        ops.push({ op: 'add', config: 'igmpproxy', type: 'phyint', values: {
          network: up.value, zone: zoneOf(fw, up.value), direction: 'upstream', altnet: alts } });
        for (const n of downs) {
          ops.push({ op: 'add', config: 'igmpproxy', type: 'phyint', values: { network: n, zone: zoneOf(fw, n), direction: 'downstream' } });
        }
        const r = await runApply(ops);
        if (r !== 'applied' && r !== 'unchanged') { applyBtn.disabled = false; if (alive && r === 'rolledback') load(); return; }
      }
      try {
        const steps = want ? ['enable', 'restart'] : ['stop', 'disable'];
        for (const s of steps) {
          const res = await initExec(s);
          if (res.code !== 0) throw new Error(res.stderr || String(res.code));
        }
        infoModal('IGMP 프록시', want
          ? 'IGMP 프록시를 켰습니다. 셋톱박스를 다시 켜면 방송이 나오는지 확인해 주세요.'
          : 'IGMP 프록시를 껐습니다.');
      } catch (e) {
        if (await handleDenied(e) !== 'expired') infoModal('IGMP 프록시', '서비스를 다시 시작하지 못했습니다. 시스템 로그를 확인해 주세요.', true);
      }
      applyBtn.disabled = false;
      if (alive) load();
    });

    const fields = h('div', { class: 'fieldset' }, fUp.el, down.el, fAlt.el);
    const sync = () => { fields.hidden = !on.input.checked; quick.el.hidden = !on.input.checked; };
    on.input.addEventListener('change', sync);
    sync();

    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, 'IGMP 프록시 (IPTV)'),
        h('span', { class: 'pill ' + (enabled ? 'ok' : 'off') }, enabled ? '사용 중' : '꺼짐')),
      h('p', { class: 'muted' }, '통신사 IPTV처럼 인터넷으로 들어오는 멀티캐스트 방송을 공유기 안쪽의 셋톱박스로 전달합니다. 필요한 방화벽 규칙은 자동으로 추가됩니다.'),
      on.el, fields, quick.el,
      h('div', { class: 'actions' }, applyBtn));
  }

  /* ----- IGMP 스누핑 ----- */

  function snoopCard(net) {
    const bridges = net.filter((s) => s['.type'] === 'device' && s.type === 'bridge' && s.name);
    if (!bridges.length) {
      return card('IGMP 스누핑', h('p', { class: 'muted' }, '브리지 장치가 없어 설정할 수 없습니다.'));
    }
    const rows = bridges.map((b) => {
      const snoop = toggleEl(b.igmp_snooping === '1', `${b.name}: IGMP 스누핑`);
      const querier = toggleEl(b.multicast_querier === '1', '쿼리어 (IGMP 프록시를 쓰지 않을 때 켜 두세요)');
      const sub = h('div', { class: 'sub-check' }, querier.el);
      const sync = () => { sub.hidden = !snoop.input.checked; };
      snoop.input.addEventListener('change', sync);
      sync();
      return { b, snoop, querier, el: h('div', null, snoop.el, sub) };
    });

    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const ops = [];
      for (const r of rows) {
        const want = {
          igmp_snooping: r.snoop.input.checked ? '1' : '',
          multicast_querier: r.snoop.input.checked && r.querier.input.checked ? '1' : '',
        };
        const values = {};
        for (const [k, v] of Object.entries(want)) if ((r.b[k] === '1' ? '1' : '') !== v) values[k] = v;
        if (Object.keys(values).length) ops.push({ op: 'set', config: 'network', section: r.b['.name'], values });
      }
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      applyBtn.disabled = true;
      const r = await runApply(ops, { timeout: NET_EDIT_TIMEOUT });
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });

    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, 'IGMP 스누핑')),
      h('p', { class: 'muted' }, '멀티캐스트를 받겠다고 한 포트로만 보내서, IPTV를 보는 동안 다른 기기의 네트워크가 느려지는 것을 막습니다.'),
      ...rows.map((r) => r.el),
      h('p', { class: 'muted' }, '적용하는 동안 내부 네트워크가 잠깐 끊길 수 있습니다.'),
      h('div', { class: 'actions' }, applyBtn));
  }

  load();
  return () => { alive = false; };
}

PAGES['/multicast'] = multicastPage;
