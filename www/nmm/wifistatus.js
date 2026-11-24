// 무선 개요 (무선 관리): 무선 장치와 무선 네트워크의 상태, 연결된 기기 목록.
//   상태는 iwinfo info / assoclist로 읽고 5초마다 갱신한다. 기기 이름은 DHCP 임대 목록에서 찾는다.
//   연결 끊기는 hostapd의 del_client를 쓴다. 바로 다시 붙지 않도록 1분 동안 재접속을 막는다.

const WIFI_BAN_MS = 60000;
const WIFI_MODE_TEXT = { Master: 'AP', Client: '클라이언트', 'Ad-Hoc': '애드혹', 'Mesh Point': '메시', ap: 'AP', sta: '클라이언트', mesh: '메시' };

// 신호 세기 막대 (0~4칸)
function wifiBars(signal) {
  const q = signal && signal < 0 ? Math.min(((signal + 110) / 70) * 100, 100) : 0;
  const level = q <= 0 ? 0 : q < 25 ? 1 : q < 50 ? 2 : q < 75 ? 3 : 4;
  return h('span', { class: 'wifi-bars', role: 'img', 'aria-label': `신호 ${level}/4` },
    [1, 2, 3, 4].map((i) => h('i', { class: i <= level ? 'on' : '', style: `height:${3 + i * 4}px` })));
}

const wifiDbm = (signal, noise) => `${signal || '---'} / ${noise || '---'} dBm`;

function wifiEncText(enc, cfg) {
  if (!enc) {
    const key = String(cfg.encryption || 'none').split('+')[0];
    return (WIFI_SECURITY.find(([k]) => k === key) || [key, key])[1];
  }
  if (!enc.enabled) return '암호화 없음';
  const up = (l) => (l || []).map((x) => String(x).toUpperCase());
  const wpa = (enc.wpa || []).map((v) => (v === 1 ? 'WPA' : `WPA${v}`)).join('/');
  const ciphers = up(enc.ciphers).join(', ');
  return `${wpa} ${up(enc.authentication).join(', ')}${ciphers ? ` (${ciphers})` : ''}`.trim();
}

// 받기/보내기 속도 한 줄: '1729.6 Mbps, 160 MHz, HE-MCS 8, NSS 2'
function wifiRateText(r) {
  if (!r || !r.rate) return '-';
  const std = r.eht ? 'EHT-' : r.he ? 'HE-' : r.vht ? 'VHT-' : '';
  const parts = [`${(r.rate / 1000).toFixed(1)} Mbps`];
  if (r.mhz) parts.push(`${r.mhz} MHz`);
  if (r.mcs != null && (r.ht || r.vht || r.he || r.eht)) parts.push(`${std}MCS ${r.mcs}`);
  if (r.nss) parts.push(`NSS ${r.nss}`);
  if (r.short_gi) parts.push('Short GI');
  return parts.join(', ');
}

function wifiOverviewPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('무선 개요'), body);
  let stopped = false;
  let timer = null;
  let loaded = false;

  async function read() {
    const [sections, status, leases] = await Promise.all([uciSections('wireless'), wirelessStatus(), readLeases()]);
    const ifnameOf = {};
    for (const r of Object.values(status || {})) {
      for (const i of r.interfaces || []) if (i.ifname) ifnameOf[i.section] = i.ifname;
    }
    const names = Object.values(ifnameOf);
    const [infos, assocs] = await Promise.all([
      Promise.all(names.map((n) => ubus('iwinfo', 'info', { device: n }).catch(() => null))),
      Promise.all(names.map((n) => ubus('iwinfo', 'assoclist', { device: n }).then((d) => d.results || [], () => []))),
    ]);
    return {
      radios: (sections || []).filter((s) => s['.type'] === 'wifi-device'),
      ifaces: (sections || []).filter((s) => s['.type'] === 'wifi-iface'),
      status: status || {},
      ifnameOf,
      info: Object.fromEntries(names.map((n, i) => [n, infos[i]])),
      assoc: Object.fromEntries(names.map((n, i) => [n, assocs[i]])),
      hosts: new Map((leases || []).map((l) => [String(l.mac).toLowerCase(), l])),
    };
  }

  async function refresh() {
    let d;
    try {
      d = await read();
    } catch (e) {
      const text = await loadFailureText(e);
      if (!stopped && text && !loaded) body.replaceChildren(messageCard(text));
      return;
    }
    if (stopped) return;
    loaded = true;
    render(d);
  }

  async function setDisabled(section, disabled, title, text) {
    if (disabled && !await confirmDialog(title, [text, h('p', { class: 'msg warn-msg' }, '이 무선으로 접속 중이면 연결이 끊깁니다. 다시 연결되지 않으면 자동으로 되돌아갑니다.')], '중지', true)) return;
    const r = await runApply([{ op: 'set', config: 'wireless', section, values: { disabled: disabled ? '1' : '' } }], { timeout: WIFI_APPLY_TIMEOUT });
    if (r === 'applied' || r === 'rolledback') refresh();
  }

  async function disconnect(ifname, mac, name) {
    const ok = await confirmDialog('연결 끊기', [
      `'${name}' 기기의 무선 연결을 끊습니다. 1분 동안 다시 연결할 수 없습니다.`,
      h('p', { class: 'msg warn-msg' }, '지금 이 화면을 보는 기기라면 관리 화면 접속도 끊깁니다.'),
    ], '연결 끊기', true);
    if (!ok) return;
    try {
      await ubus(`hostapd.${ifname}`, 'del_client', { addr: mac, deauth: true, reason: 5, ban_time: WIFI_BAN_MS });
    } catch (e) {
      if (await handleDenied(e) !== 'expired') infoModal('연결 끊기', '연결을 끊지 못했습니다. 이 무선 방식에서는 지원하지 않을 수 있습니다.', true);
      return;
    }
    refresh();
  }

  function radioRow(d, r) {
    const nets = d.ifaces.filter((w) => w.device === r['.name']);
    const live = nets.map((w) => d.info[d.ifnameOf[w['.name']]]).find(Boolean);
    const off = r.disabled === '1';
    const up = !!(d.status[r['.name']] || {}).up;
    const band = BAND_LABEL[radioBand(r)] || '';
    const hw = live && live.hardware && live.hardware.name;
    const modes = live && live.hwmodes && live.hwmodes.length ? `802.11${live.hwmodes.join('/')}` : '';
    const chan = live && live.channel ? live.channel : r.channel;
    const facts = [
      `채널 ${chan === 'auto' || !chan ? '자동' : chan}${live && live.frequency ? ` (${(live.frequency / 1000).toFixed(3)} GHz)` : ''}`,
      live && live.bitrate ? `속도 ${(live.bitrate / 1000).toFixed(1)} Mbps` : null,
    ].filter(Boolean).join(' · ');
    return h('div', { class: 'wo-row wo-radio' },
      h('div', { class: 'wo-badge' }, h('b', null, r['.name']), band ? h('span', { class: 'muted' }, band) : null),
      h('div', { class: 'wo-main' },
        h('div', { class: 'wo-title' }, [hw, modes].filter(Boolean).join(' ') || `${band} 무선`),
        h('div', { class: 'muted' }, facts)),
      h('span', { class: 'pill ' + (off ? 'off' : up ? 'ok' : 'warn') }, off ? '꺼짐' : up ? '동작 중' : '시작 중'),
      h('div', { class: 'wo-actions' },
        h('button', { class: 'btn btn-ghost btn-small', type: 'button',
          onclick: () => setDisabled(r['.name'], !off, '무선 장치 중지', `${r['.name']}${band ? ` (${band})` : ''}의 모든 무선 네트워크를 중지합니다.`) }, off ? '사용' : '중지')));
  }

  function netRow(d, w) {
    const ifname = d.ifnameOf[w['.name']];
    const info = ifname ? d.info[ifname] : null;
    const off = w.disabled === '1';
    const nets = asList(w.network);
    const editPath = !nets.length || nets.some((n) => SYSTEM_NETS.includes(n)) ? '#/wireless' : '#/guest';
    const clients = ifname ? (d.assoc[ifname] || []).length : 0;
    return h('div', { class: 'wo-row' + (off ? ' wo-off' : '') },
      h('div', { class: 'wo-badge' }, wifiBars(info && info.signal), h('span', { class: 'muted' }, wifiDbm(info && info.signal, info && info.noise))),
      h('div', { class: 'wo-main' },
        h('div', null, h('b', null, w.ssid || w.mesh_id || '(이름 없음)'), ` · ${WIFI_MODE_TEXT[info && info.mode] || WIFI_MODE_TEXT[w.mode] || w.mode || 'AP'}`,
          nets.length ? ` · ${nets.map((n) => IFACE_LABEL[n] || n).join(', ')}` : ''),
        h('div', { class: 'muted' }, [info && info.bssid ? `BSSID ${info.bssid}` : null, wifiEncText(info && info.encryption, w), ifname ? `연결 ${clients}대` : null].filter(Boolean).join(' · '))),
      h('span', { class: 'pill ' + (off ? 'off' : ifname ? 'ok' : 'warn') }, off ? '꺼짐' : ifname ? '사용 중' : '시작 중'),
      h('div', { class: 'wo-actions' },
        h('button', { class: 'btn btn-ghost btn-small', type: 'button',
          onclick: () => setDisabled(w['.name'], !off, '무선 네트워크 중지', `'${w.ssid || w['.name']}' 무선 네트워크를 중지합니다.`) }, off ? '사용' : '중지'),
        h('a', { class: 'btn btn-ghost btn-small', href: editPath }, '설정')));
  }

  function stationRows(d) {
    return d.ifaces.flatMap((w) => {
      const ifname = d.ifnameOf[w['.name']];
      const band = BAND_LABEL[radioBand(d.radios.find((r) => r['.name'] === w.device))] || '';
      return (ifname ? d.assoc[ifname] || [] : []).map((s) => {
        const host = d.hosts.get(String(s.mac).toLowerCase());
        const name = host && host.name && host.name !== '*' ? host.name : '';
        const signal = s.signal_avg || s.signal;
        return h('tr', null,
          h('td', null, h('b', null, w.ssid || '-'), h('div', { class: 'muted' }, [band, ifname].filter(Boolean).join(' · '))),
          h('td', null, s.mac),
          h('td', null, name || '-', host && host.ip ? h('div', { class: 'muted' }, host.ip) : null),
          h('td', null, h('div', { class: 'wo-signal' }, wifiBars(signal), h('span', { class: 'muted' }, wifiDbm(signal, s.noise)))),
          h('td', { class: 'wo-rate' }, h('div', null, `↓ ${wifiRateText(s.rx)}`), h('div', null, `↑ ${wifiRateText(s.tx)}`)),
          h('td', null, s.connected_time ? fmtUptime(s.connected_time) : '-'),
          h('td', { class: 'actions-cell' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button',
            onclick: () => disconnect(ifname, s.mac, name || s.mac) }, '연결 끊기')));
      });
    });
  }

  function render(d) {
    if (!d.radios.length) { body.replaceChildren(messageCard('이 공유기에는 무선 장치가 없습니다.')); return; }
    const rows = stationRows(d);
    body.replaceChildren(
      h('section', { class: 'card', style: 'max-width:none' },
        h('div', { class: 'card-head' }, h('h3', null, '무선 상태')),
        d.radios.flatMap((r) => [radioRow(d, r), ...d.ifaces.filter((w) => w.device === r['.name']).map((w) => netRow(d, w))])),
      h('section', { class: 'card', style: 'max-width:none' },
        h('div', { class: 'card-head' }, h('h3', null, '연결된 기기'), h('span', { class: 'pill ' + (rows.length ? 'ok' : 'off') }, `${rows.length}대`)),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ...['무선 네트워크', 'MAC 주소', '기기', '신호 / 잡음', '받기 / 보내기 속도', '연결 시간', ''].map((x) => h('th', null, x)))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 7, class: 'muted' }, '연결된 기기가 없습니다.')))))));
  }

  let first = true;
  async function tick() {
    if (first || !document.hidden) await refresh();
    first = false;
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

PAGES['/wifi-overview'] = wifiOverviewPage;
