// 무선 메시 (무선 관리): 802.11s 메시로 공유기 여러 대를 무선으로 이어 내부 네트워크(lan)를 넓힌다.
//   wireless 설정에 mode 'mesh'인 wifi-iface를 하나 두고 lan 브리지에 붙인다. 암호화는 SAE(WPA3).
//   SAE 메시는 wpad-basic으로는 안 되고 wpad-mesh-* 또는 전체 wpad-*가 필요하다.
//   메시에 참여하는 공유기는 모두 같은 대역, 같은 고정 채널, 같은 메시 ID와 암호를 써야 한다.

const MESH_SECTION = 'wrttime_mesh';
const MESH_PKG = 'wpad-mesh-mbedtls';
// DFS 채널(레이더 감지)은 켜질 때 1분 넘게 걸리고 바뀔 수 있어 메시에 맞지 않으므로 뺀다
const MESH_CHANNELS = {
  '2g': ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
  '5g': ['36', '40', '44', '48', '149', '153', '157', '161'],
};

// 설치된 wpad/wpa_supplicant가 SAE 메시를 지원하는지. 'basic'/'mini'는 지원하지 않는다.
function meshCapable(installed) {
  const names = installed.map((p) => p.name);
  const supp = names.filter((n) => /^(wpad|wpa-supplicant)(-|$)/.test(n));
  return {
    ok: supp.some((n) => !/-(basic|mini)(-|$)/.test(n)),
    basic: supp.filter((n) => /-(basic|mini)(-|$)/.test(n)),
  };
}

function meshPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('무선 메시'), body);
  let alive = true;

  async function load() {
    let sections, status, installed;
    try {
      [sections, status, installed] = await Promise.all([
        uciSections('wireless'),
        wirelessStatus().catch(() => ({})),
        ubus('file', 'read', { path: APK_DB }).then((d) => parseApkDb(d.data || ''), () => null),
      ]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const radios = (sections || []).filter((s) => s['.type'] === 'wifi-device' && MESH_CHANNELS[radioBand(s)]);
    if (!radios.length) { body.replaceChildren(messageCard('메시에 쓸 수 있는 2.4GHz / 5GHz 무선 장치가 없습니다.')); return; }
    const mesh = (sections || []).find((s) => s['.type'] === 'wifi-iface' && s.mode === 'mesh') || null;
    let peers = [];
    const ifname = mesh && Object.values(status || {}).flatMap((r) => r.interfaces || [])
      .filter((i) => i.section === mesh['.name']).map((i) => i.ifname).find(Boolean);
    if (ifname) peers = await ubus('iwinfo', 'assoclist', { device: ifname }).then((d) => d.results || [], () => []);
    if (!alive) return;
    const cap = installed ? meshCapable(installed) : { ok: true, basic: [] }; // 목록을 못 읽으면 막지 않는다
    // replaceChildren는 null을 'null' 글자로 넣으므로 걸러 낸다
    body.replaceChildren(...[
      cap.ok ? null : packageCard(cap.basic),
      meshForm(radios, mesh, cap.ok),
      mesh ? peersCard(mesh, ifname, peers) : null,
      nodeGuide(),
    ].filter(Boolean));
  }

  // wpad-basic을 메시 지원 패키지로 바꾼다. 지우는 동안에도 돌고 있는 무선은 끊기지 않고, 무선을 다시 시작할 때 새 패키지를 쓴다.
  function packageCard(basic) {
    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '메시 지원 패키지로 바꾸기');
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog('메시 지원 패키지 설치', [
        `${basic.join(', ') || '지금 무선 패키지'}를 지우고 ${MESH_PKG}를 설치합니다.`,
        h('p', { class: 'msg warn-msg' }, '가능하면 유선으로 연결한 상태에서 진행하세요. 설치에 실패하면 원래 패키지를 다시 설치합니다.'),
      ], '설치');
      if (!ok) return;
      btn.disabled = true;
      const done = await apkRunSteps(`${MESH_PKG} 설치`, [
        { label: '패키지 목록을 받는', params: ['update'] },
        ...(basic.length ? [{ label: '기존 무선 패키지를 지우는', params: ['del', ...basic] }] : []),
        { label: `${MESH_PKG}를 설치하는`, params: ['add', MESH_PKG] },
      ]);
      if (!done && basic.length) {
        // 지운 뒤 설치에 실패했으면 원래 패키지를 되돌린다 (이미 있으면 apk가 그냥 넘어간다)
        await apkExec(['add', ...basic]).catch(() => {});
      }
      btn.disabled = false;
      if (done && alive) load();
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '패키지가 필요합니다')),
      h('p', null, `암호를 건 메시(WPA3-SAE)를 쓰려면 무선 패키지를 메시 지원판(${MESH_PKG})으로 바꿔야 합니다.`),
      h('div', { class: 'actions' }, btn));
  }

  function meshForm(radios, mesh, capable) {
    const cur = mesh || {};
    const defRadio = (radios.find((r) => r['.name'] === cur.device) || radios.find((r) => radioBand(r) === '5g') || radios[0]);
    const on = toggleEl(!!mesh && mesh.disabled !== '1', '무선 메시 사용');
    const radioSel = selectEl(radios.map((r) => [r['.name'], BAND_LABEL[radioBand(r)] + (radios.filter((x) => radioBand(x) === radioBand(r)).length > 1 ? ` (${r['.name']})` : '')]),
      defRadio['.name']);
    const meshId = h('input', { type: 'text', value: cur.mesh_id || 'wrttime-mesh', spellcheck: 'false', autocomplete: 'off' });
    const key = h('input', { type: 'password', value: cur.key || '', autocomplete: 'new-password', spellcheck: 'false' });
    const showKey = toggleEl(false, '암호 보기');
    showKey.input.addEventListener('change', () => { key.type = showKey.input.checked ? 'text' : 'password'; });
    const chan = h('select');
    const fRadio = formField('대역', radioSel, '보통 5GHz가 빠릅니다');
    const fChan = formField('채널', chan, '메시 공유기는 모두 같은 채널이어야 합니다');
    const fId = formField('메시 ID', meshId, '영문/숫자/-/_ 32자까지. 모든 메시 공유기에 같게');
    const fKey = formField('메시 암호', key, '8~63자. 모든 메시 공유기에 같게');
    const radioOf = () => radios.find((r) => r['.name'] === radioSel.value);
    const fillChans = () => {
      const r = radioOf();
      const list = MESH_CHANNELS[radioBand(r)];
      chan.replaceChildren(...list.map((c) => h('option', { value: c }, c + '번')));
      chan.value = list.includes(r.channel) ? r.channel : list[0];
    };
    radioSel.addEventListener('change', fillChans);
    fillChans();
    const fields = h('div', null, h('div', { class: 'fieldset' }, fRadio.el, fChan.el), h('div', { class: 'fieldset' }, fId.el, fKey.el), showKey.el);
    const sync = () => { fields.hidden = !on.input.checked; };
    on.input.addEventListener('change', sync);
    sync();

    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      [fId, fKey].forEach((f) => f.setError(null));
      const want = on.input.checked;
      const ops = [];
      if (want) {
        let bad = false;
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(meshId.value.trim())) { fId.setError('영문/숫자/-/_ 1~32자로 입력해 주세요.'); bad = true; }
        if (!/^[\x20-\x7e]{8,63}$/.test(key.value)) { fKey.setError('영문/숫자/기호 8~63자로 입력해 주세요.'); bad = true; }
        if (bad) return;
        if (!capable && !await confirmDialog('패키지 확인', '메시 지원 패키지가 없어 메시가 켜지지 않을 수 있습니다. 그래도 적용할까요?', '적용')) return;
        const r = radioOf();
        const devVals = {};
        if (r.channel !== chan.value) devVals.channel = chan.value;
        if (r.disabled === '1') devVals.disabled = '';
        if (Object.keys(devVals).length) ops.push({ op: 'set', config: 'wireless', section: r['.name'], values: devVals });
        const values = {
          device: r['.name'], mode: 'mesh', mesh_id: meshId.value.trim(), encryption: 'sae', key: key.value,
          network: 'lan', mesh_fwding: '1', mesh_rssi_threshold: '0', disabled: '',
        };
        ops.push(mesh
          ? { op: 'set', config: 'wireless', section: mesh['.name'], values }
          : { op: 'add', config: 'wireless', type: 'wifi-iface', name: MESH_SECTION, values });
      } else if (mesh && mesh.disabled !== '1') {
        ops.push({ op: 'set', config: 'wireless', section: mesh['.name'], values: { disabled: '1' } });
      }
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ok = await confirmDialog('무선 메시 적용', [
        '무선을 다시 시작하므로 무선으로 연결된 기기는 잠시 끊깁니다.',
        h('p', { class: 'msg warn-msg' }, `${WIFI_APPLY_TIMEOUT}초 안에 다시 접속하지 못하면 이전 설정으로 자동으로 되돌아갑니다.`),
      ], '적용');
      if (!ok) return;
      applyBtn.disabled = true;
      const res = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      applyBtn.disabled = false;
      if (alive && (res === 'applied' || res === 'rolledback')) load();
    });

    const live = mesh && mesh.disabled !== '1';
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '메시 설정'),
        h('span', { class: 'pill ' + (live ? 'ok' : 'off') }, live ? '사용 중' : '꺼짐')),
      h('p', { class: 'muted' }, '공유기 여러 대를 선 없이 무선으로 이어 집 전체에 같은 내부 네트워크를 넓힙니다. 메시에 참여하는 공유기마다 같은 설정으로 켜 주세요.'),
      on.el, fields,
      h('div', { class: 'actions' }, applyBtn));
  }

  function peersCard(mesh, ifname, peers) {
    const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${Math.floor(s / 60)}분`);
    const rows = peers.map((p) => h('tr', null,
      h('td', null, p.mac),
      h('td', null, p.signal != null ? `${p.signal} dBm` : '-'),
      h('td', null, p.rx && p.rx.rate ? `${Math.round(p.rx.rate / 1000)} Mbps` : '-'),
      h('td', null, p.connected_time != null ? fmtTime(p.connected_time) : '-')));
    return card('연결된 메시 공유기',
      !ifname
        ? h('p', { class: 'muted' }, mesh.disabled === '1' ? '메시가 꺼져 있습니다.' : '메시가 아직 켜지지 않았습니다. 패키지와 채널을 확인해 주세요.')
        : rows.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ...['MAC 주소', '신호', '속도', '연결 시간'].map((x) => h('th', null, x)))),
            h('tbody', null, rows)))
          : h('p', { class: 'muted' }, '연결된 메시 공유기가 없습니다. 다른 공유기의 대역, 채널, 메시 ID, 암호가 같은지 확인해 주세요.'),
      h('p', { class: 'muted' }, '신호가 -70 dBm보다 약하면 공유기를 더 가깝게 두세요.'));
  }

  function nodeGuide() {
    return card('다른 공유기를 메시에 추가하려면',
      h('ol', { class: 'steps' },
        h('li', null, '그 공유기에도 wrtTIME을 설치하고 이 화면에서 같은 대역, 채널, 메시 ID, 암호로 메시를 켭니다.'),
        h('li', null, h('a', { href: '#/lan' }, '내부 네트워크 설정'), '에서 그 공유기의 주소를 이 공유기와 겹치지 않게 바꿉니다. (예: 192.168.1.2)'),
        h('li', null, h('a', { href: '#/dhcp' }, 'DHCP 서버 설정'), '에서 그 공유기의 DHCP 서버를 끕니다. 주소는 이 공유기 하나만 나눠 줍니다.'),
        h('li', null, h('a', { href: '#/wireless' }, '무선 설정'), '에서 모든 공유기의 무선 이름과 암호를 같게 하고 빠른 로밍(802.11r)을 켜면, 기기가 가까운 공유기로 끊김 없이 옮겨 갑니다.')),
      h('p', { class: 'muted' }, '추가한 공유기의 인터넷(WAN) 포트는 쓰지 않습니다.'));
  }

  load();
  return () => { alive = false; };
}

PAGES['/mesh'] = meshPage;
