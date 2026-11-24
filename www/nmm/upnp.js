// UPnP (NAT/라우터 관리): miniupnpd-nftables 패키지. 게임기나 P2P 앱이 필요한 포트를 스스로 열게 한다.
//   설정은 upnpd 설정의 'upnpd' 섹션. 패키지 버전에 따라 옵션 이름이 조금씩 달라서,
//   켜기(enabled)와 보안 모드(secure_mode) 말고는 설정 파일에 있는 옵션만 화면에 보여 준다.
//   적용 뒤에는 서비스를 다시 시작한다 (끄면 멈춘다).
//   지금 열린 포트는 miniupnpd가 적는 임대 파일(upnp_lease_file)에서 읽는다.

const UPNP_INIT = '/etc/init.d/miniupnpd';
const UPNP_PKG = 'miniupnpd-nftables';
const UPNP_DEFAULT_LEASES = '/var/run/miniupnpd.leases';

// 'TCP:51413:192.168.1.50:51413:1700000000:Transmission' -> 항목. 설명에는 ':'가 들어 있을 수 있다.
function parseUpnpLeases(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const p = line.split(':');
    if (p.length < 5) return null;
    return { proto: p[0], ext: p[1], ip: p[2], port: p[3], expires: +p[4] || 0, desc: p.slice(5).join(':') };
  }).filter(Boolean);
}

function upnpPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('UPnP 설정'), body);
  let alive = true;

  async function load() {
    let exists, sections, leases, names;
    try {
      exists = await uciConfigExists('upnpd');
      sections = exists ? await uciSections('upnpd') : null;
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!exists) { body.replaceChildren(missingPackageCard(UPNP_PKG, 'UPnP', load)); return; }
    const cfg = (sections || []).find((s) => s['.type'] === 'upnpd') || null;
    const path = (cfg && cfg.upnp_lease_file) || UPNP_DEFAULT_LEASES;
    [leases, names] = await Promise.all([
      ubus('file', 'read', { path }).then((d) => parseUpnpLeases(d.data || ''), () => []),
      readLeases(),
    ]);
    if (alive) render(cfg, leases, names);
  }

  function render(cfg, leases, names) {
    const cur = cfg || {};
    const has = (k) => k in cur;
    const on = toggleEl(cur.enabled === '1', 'UPnP 사용');
    const secure = toggleEl(cur.secure_mode !== '0', '보안 모드: 요청한 기기 자신에게만 포트를 열 수 있음 (권장)');
    const pmpKey = has('enable_pcp_pmp') ? 'enable_pcp_pmp' : has('enable_natpmp') ? 'enable_natpmp' : null;
    const pmp = pmpKey ? toggleEl(cur[pmpKey] !== '0', 'NAT-PMP / PCP도 허용 (Apple 기기, 일부 게임기)') : null;
    const opts = h('div', null, secure.el, pmp ? pmp.el : null);
    const sync = () => { opts.hidden = !on.input.checked; };
    on.input.addEventListener('change', sync);
    sync();

    const initExec = (action) => ubus('file', 'exec', { command: UPNP_INIT, params: [action] }, state.sid, 30000);
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const want = on.input.checked;
      const values = { enabled: want ? '1' : '0', secure_mode: secure.input.checked ? '1' : '0' };
      if (want && has('enable_upnp')) values.enable_upnp = '1';
      if (pmp) values[pmpKey] = pmp.input.checked ? '1' : '0';
      for (const k of Object.keys(values)) if ((cur[k] || '') === values[k]) delete values[k];
      applyBtn.disabled = true;
      if (Object.keys(values).length) {
        const ops = cfg
          ? [{ op: 'set', config: 'upnpd', section: cfg['.name'], values }]
          : [{ op: 'add', config: 'upnpd', type: 'upnpd', name: 'config', values: { internal_iface: 'lan', ...values } }];
        const r = await runApply(ops);
        if (r !== 'applied') { applyBtn.disabled = false; if (alive && r === 'rolledback') load(); return; }
      }
      try {
        for (const a of want ? ['enable', 'restart'] : ['stop']) {
          const res = await initExec(a);
          if (res.code !== 0) throw new Error(res.stderr || String(res.code));
        }
        infoModal('UPnP', want ? 'UPnP를 켰습니다. 게임기나 앱을 다시 시작하면 포트를 새로 엽니다.' : 'UPnP를 껐습니다. 앱이 열어 둔 포트도 모두 닫힙니다.');
      } catch (e) {
        if (await handleDenied(e) !== 'expired') infoModal('UPnP', '서비스를 다시 시작하지 못했습니다. 시스템 로그를 확인해 주세요.', true);
      }
      applyBtn.disabled = false;
      if (alive) load();
    });

    const nameOf = (ip) => (names.find((l) => l.ip === ip) || {}).name;
    const rows = leases.map((l) => h('tr', null,
      h('td', null, l.desc || '-'),
      h('td', null, l.proto),
      h('td', null, l.ext),
      h('td', null, nameOf(l.ip) ? `${nameOf(l.ip)} (${l.ip})` : l.ip),
      h('td', null, l.port)));

    body.replaceChildren(
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, 'UPnP'),
          h('span', { class: 'pill ' + (cur.enabled === '1' ? 'ok' : 'off') }, cur.enabled === '1' ? '사용 중' : '꺼짐')),
        h('p', { class: 'muted' }, '게임기, 화상 통화, P2P 앱이 필요한 포트를 직접 열 수 있게 합니다. 포트포워드를 일일이 만들지 않아도 됩니다.'),
        on.el, opts,
        h('p', { class: 'msg warn-msg' }, '내부 기기가 허락 없이 포트를 열 수 있게 되므로, 필요할 때만 켜 두세요.'),
        h('div', { class: 'actions' }, applyBtn)),
      card('지금 열린 포트',
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ...['설명', '프로토콜', '외부 포트', '내부 기기', '내부 포트'].map((x) => h('th', null, x)))),
            h('tbody', null, rows)))
          : h('p', { class: 'muted' }, cur.enabled === '1' ? '앱이 연 포트가 없습니다.' : 'UPnP가 꺼져 있습니다.')));
  }

  load();
  return () => { alive = false; };
}

PAGES['/upnp'] = upnpPage;
