// 무선 설정 (대역별: 켜기/끄기, 이름, 숨기기, 보안, 암호, 빠른 로밍(802.11r), 채널, 모드, 대역폭)

const WIFI_APPLY_TIMEOUT = 120; // 무선으로 접속 중이면 새 이름/암호로 다시 붙을 시간이 필요하다

const WIFI_SECURITY = [
  ['psk2', 'WPA2-PSK (권장)'],
  ['sae-mixed', 'WPA2/WPA3 혼합'],
  ['sae', 'WPA3-SAE'],
  ['none', '암호 없음 (권장하지 않음)'],
];

const WIFI_CHANNELS = {
  '2g': ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
  '5g': ['36', '40', '44', '48', '52', '56', '60', '64', '100', '104', '108', '112', '116', '120', '124', '149', '153', '157', '161'],
  '6g': ['1', '5', '21', '37', '53', '69', '85', '101', '117', '133', '149', '165', '181', '197', '213', '229'],
  '60g': ['1', '2', '3', '4'],
};

// 무선 모드(htmode 앞부분)와 대역폭. OpenWrt는 둘을 합쳐 htmode 하나로 쓴다 (예: HE80 = AX, 80MHz).
const WIFI_MODES = [
  ['NOHT', '레거시 (802.11a/b/g)'],
  ['HT', 'N (Wi-Fi 4)'],
  ['VHT', 'AC (Wi-Fi 5)'],
  ['HE', 'AX (Wi-Fi 6)'],
  ['EHT', 'BE (Wi-Fi 7)'],
];
// 장치가 지원하는 htmode 목록(iwinfo info의 htmodes)을 모를 때 대역별 기본값
const DEFAULT_HTMODES = {
  '2g': ['HT20', 'HT40', 'HE20', 'HE40'],
  '5g': ['HT20', 'HT40', 'VHT20', 'VHT40', 'VHT80', 'VHT160', 'HE20', 'HE40', 'HE80', 'HE160'],
  '6g': ['HE20', 'HE40', 'HE80', 'HE160'],
  '60g': [],
};

// 'HE80' -> { mode: 'HE', width: '80' }. 옛 'HT40+'도 받는다. 모르는 값이면 null.
function parseHtmode(s) {
  const m = /^(NOHT|EHT|VHT|HE|HT)(\d+)?[+-]?$/.exec(String(s || ''));
  if (!m) return null;
  return { mode: m[1], width: m[1] === 'NOHT' ? '' : (m[2] || '20') };
}

// 고를 수 있는 { 모드: [대역폭...] }. htmodes: 장치가 지원하는 목록(없으면 대역 기본값)
function htmodeChoices(band, htmodes) {
  const list = (htmodes && htmodes.length ? htmodes : DEFAULT_HTMODES[band] || []);
  const out = {};
  for (const x of list) {
    const p = parseHtmode(x);
    if (!p || p.mode === 'NOHT') continue;
    if (band === '2g' && p.mode === 'VHT') continue; // AC는 5GHz 전용
    (out[p.mode] = out[p.mode] || []).includes(p.width) || out[p.mode].push(p.width);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => +a - +b);
  if (band !== '6g') out.NOHT = [''];
  return out;
}

function utf8Len(s) {
  return new TextEncoder().encode(s).length;
}

function wirelessPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('무선 설정'), body);
  let alive = true;

  async function load() {
    let sections, status;
    try {
      sections = await uciSections('wireless');
      status = await wirelessStatus().catch(() => null);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const radios = (sections || []).filter((s) => s['.type'] === 'wifi-device');
    if (!radios.length) {
      body.replaceChildren(messageCard('이 공유기에서 무선 장치를 찾지 못했습니다.'));
      return;
    }
    // 장치가 지원하는 모드/대역폭 (iwinfo info의 htmodes). 무선이 꺼져 있으면 모르므로 대역 기본값을 쓴다.
    const infos = {};
    await Promise.all(radios.map(async (r) => {
      const ifn = (((status || {})[r['.name']] || {}).interfaces || []).map((i) => i.ifname).find(Boolean);
      if (ifn) infos[r['.name']] = await ubus('iwinfo', 'info', { device: ifn }).catch(() => null);
    }));
    if (!alive) return;
    render(radios, sections.filter((s) => s['.type'] === 'wifi-iface'), status || {}, infos);
  }

  function render(radios, ifaces, status, infos) {
    // 같은 대역의 무선 장치가 여러 개인 공유기(예: 5GHz 두 개)는 장치 이름을 함께 보여 준다
    const bandCount = {};
    for (const r of radios) bandCount[radioBand(r)] = (bandCount[radioBand(r)] || 0) + 1;
    const forms = radios.map((radio) => radioForm(radio, ifaces, status[radio['.name']], bandCount[radioBand(radio)] > 1, infos[radio['.name']]));
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      let bad = false;
      const ops = [];
      for (const f of forms) {
        const r = f.collect();
        if (r === null) bad = true;
        else ops.push(...r);
      }
      if (bad) return;
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ok = await confirmDialog('무선 설정 적용', [
        '무선을 다시 시작하므로 무선으로 연결된 기기는 잠시 끊깁니다.',
        h('p', { class: 'msg warn-msg' }, `무선으로 접속 중이라면 바뀐 이름/암호로 다시 연결해 주세요. ${WIFI_APPLY_TIMEOUT}초 안에 다시 접속하지 못하면 이전 설정으로 자동으로 되돌아갑니다.`),
      ], '적용');
      if (!ok) return;
      applyBtn.disabled = true;
      const res = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      applyBtn.disabled = false;
      if (alive && (res === 'applied' || res === 'rolledback')) load();
    });
    body.replaceChildren(...forms.map((f) => f.el),
      h('section', { class: 'card' }, h('div', { class: 'actions', style: 'margin:0' }, applyBtn)));
  }

  load();
  return () => { alive = false; };
}

function radioForm(radio, ifaces, st, showName, info) {
  const band = radioBand(radio) || '2g';
  const bandLabel = (BAND_LABEL[band] || radio['.name']) + (showName ? ` (${radio['.name']})` : '');
  // 게스트/VLAN 네트워크(내부 네트워크가 아닌 별도 네트워크)의 무선은 그 메뉴에서 관리하므로 여기서는 뺀다
  const aps = ifaces.filter((i) => i.device === radio['.name'] && (i.mode || 'ap') === 'ap'
    && !(asList(i.network).length && asList(i.network).every((n) => !SYSTEM_NETS.includes(n))));
  const iface = aps[0];
  const live = st ? (st.up ? ['ok', '동작 중'] : ['off', '꺼짐']) : ['off', '상태 모름'];
  const head = h('div', { class: 'card-head' },
    h('h3', null, `${bandLabel} 무선`), h('span', { class: 'pill ' + live[0] }, live[1]));
  const extraNote = aps.length > 1
    ? h('p', { class: 'msg warn-msg' }, `이 대역에는 무선 네트워크가 ${aps.length}개 있습니다. 여기서는 첫 번째('${aps[0].ssid || aps[0]['.name']}')만 바꿉니다.`)
    : null;

  if (!iface) {
    return { el: card(null, head, h('p', { class: 'muted' }, '이 무선 장치에 설정된 네트워크가 없습니다.')), collect: () => [] };
  }

  // 무선 장치(wifi-device)와 무선 네트워크(wifi-iface) 둘 다 켜져 있어야 실제로 켜진 것이다.
  // OpenWrt를 처음 설치하면 장치는 켜져 있고 네트워크만 disabled 1이다.
  const wasOn = radio.disabled !== '1' && iface.disabled !== '1';
  const on = toggleEl(wasOn, '무선 사용');
  const ssid = h('input', { type: 'text', value: iface.ssid || '', spellcheck: 'false' });
  const hidden = toggleEl(iface.hidden === '1', '네트워크 이름 숨기기');
  // 802.11r: 같은 이름/암호의 공유기(또는 메시 노드) 여러 대 사이를 옮길 때 다시 인증하지 않고 바로 넘어간다.
  //   mobility_domain을 비워 두면 hostapd가 SSID로 정하므로 같은 SSID끼리는 자동으로 맞는다.
  const ft = toggleEl(iface.ieee80211r === '1', '빠른 로밍 (802.11r)');
  const ftHint = h('small', { class: 'hint check-hint' }, '같은 이름과 암호를 쓰는 공유기 여러 대 사이를 끊김 없이 옮겨 다닙니다. 오래된 기기가 접속하지 못하면 꺼 주세요.');
  const ftBox = h('div', null, ft.el, ftHint);
  const enc = selectEl(WIFI_SECURITY, (iface.encryption || 'none').split('+')[0]);
  const key = h('input', { type: 'password', value: iface.key || '', autocomplete: 'new-password', spellcheck: 'false' });
  const showKey = toggleEl(false, '암호 보기');
  showKey.input.addEventListener('change', () => { key.type = showKey.input.checked ? 'text' : 'password'; });
  const channels = [['auto', '자동'], ...(WIFI_CHANNELS[band] || []).map((c) => [c, c + '번'])];
  const chan = selectEl(channels, radio.channel || 'auto');

  const fSsid = formField('네트워크 이름 (SSID)', ssid);
  const fEnc = formField('보안 방식', enc);
  const fKey = formField('무선 암호', key, '8~63자');
  const fChan = formField('채널', chan);

  // 모드 / 대역폭 (htmode)
  const curHt = parseHtmode(radio.htmode);
  const choices = htmodeChoices(band, info && info.htmodes);
  if (curHt && !choices[curHt.mode]) choices[curHt.mode] = [curHt.width]; // 지금 값은 목록에 없어도 보존
  else if (curHt && !choices[curHt.mode].includes(curHt.width)) choices[curHt.mode].push(curHt.width);
  const modeList = WIFI_MODES.filter(([k]) => choices[k]);
  const modeSel = selectEl(curHt ? modeList : [['', '드라이버 기본값'], ...modeList], curHt ? curHt.mode : '');
  const widthSel = h('select');
  const fMode = formField('모드', modeSel);
  const fWidth = formField('대역폭', widthSel, band === '5g' ? '160MHz는 DFS 채널(레이더 감지)을 써서 켜질 때 1분쯤 걸리고, 레이더가 잡히면 채널이 바뀔 수 있습니다' : '');
  const fillWidths = (keep) => {
    const ws = choices[modeSel.value] || [];
    widthSel.replaceChildren(...ws.map((w) => h('option', { value: w }, `${w}MHz`)));
    widthSel.value = ws.includes(keep) ? keep : (ws[ws.length - 1] || '');
    fWidth.el.hidden = !ws.length || modeSel.value === 'NOHT';
  };
  fillWidths(curHt ? curHt.width : '');
  modeSel.addEventListener('change', () => fillWidths(widthSel.value));
  const wantHtmode = () => (modeSel.value === 'NOHT' ? 'NOHT' : (modeSel.value ? modeSel.value + widthSel.value : ''));

  const keyBox = h('div', null, fKey.el, showKey.el);
  const detail = h('div', null,
    h('div', { class: 'fieldset' }, fSsid.el, fEnc.el), hidden.el, keyBox, ftBox, h('div', { class: 'fieldset' }, fChan.el),
    band === '60g' ? null : h('div', { class: 'fieldset' }, fMode.el, fWidth.el));
  const sync = () => {
    detail.hidden = !on.input.checked;
    keyBox.hidden = enc.value === 'none';
    ftBox.hidden = enc.value === 'none';
  };
  on.input.addEventListener('change', sync);
  enc.addEventListener('change', sync);
  sync();

  function collect() {
    [fSsid, fKey, fEnc].forEach((f) => f.setError(null));
    const ops = [];
    const devVals = {};
    const ifVals = {};
    const wantOn = on.input.checked;
    if (wantOn !== wasOn) {
      if (wantOn) {
        if (radio.disabled === '1') devVals.disabled = '';
        if (iface.disabled === '1') ifVals.disabled = '';
      } else {
        devVals.disabled = '1';
      }
    }
    if (wantOn) {
      const s = ssid.value;
      let bad = false;
      if (!s.trim() || utf8Len(s) > 32) { fSsid.setError('1~32바이트로 입력해 주세요. (한글은 1자에 3바이트)'); bad = true; }
      if (enc.value !== 'none' && !/^[\x20-\x7e]{8,63}$/.test(key.value)) {
        fKey.setError('영문/숫자/기호 8~63자로 입력해 주세요.'); bad = true;
      }
      if (band === '6g' && !['sae', 'owe'].includes(enc.value)) {
        fEnc.setError('6GHz 대역은 WPA3-SAE만 쓸 수 있습니다.'); bad = true;
      }
      if (bad) return null;
      if (s !== (iface.ssid || '')) ifVals.ssid = s;
      // 'psk2+ccmp'처럼 뒤에 암호화 방식이 붙어 있을 수 있으므로 앞부분만 비교한다
      if (enc.value !== (iface.encryption || 'none').split('+')[0]) ifVals.encryption = enc.value;
      const wantKey = enc.value === 'none' ? '' : key.value;
      if (wantKey !== (iface.key || '')) ifVals.key = wantKey;
      const wantFt = enc.value !== 'none' && ft.input.checked;
      if (wantFt !== (iface.ieee80211r === '1')) {
        Object.assign(ifVals, wantFt
          ? { ieee80211r: '1', ft_over_ds: '0', ft_psk_generate_local: '1' }
          : { ieee80211r: '', ft_over_ds: '', ft_psk_generate_local: '' });
      }
      const wantHidden = hidden.input.checked ? '1' : '';
      if (wantHidden !== (iface.hidden || '')) ifVals.hidden = wantHidden;
      if (chan.value !== (radio.channel || 'auto')) devVals.channel = chan.value;
      const ht = wantHtmode();
      if (band !== '60g' && ht && ht !== (radio.htmode || '')) devVals.htmode = ht;
    }
    if (Object.keys(devVals).length) ops.push({ op: 'set', config: 'wireless', section: radio['.name'], values: devVals });
    if (Object.keys(ifVals).length) ops.push({ op: 'set', config: 'wireless', section: iface['.name'], values: ifVals });
    return ops;
  }

  return { el: h('section', { class: 'card form-card' }, head, extraNote, on.el, detail), collect };
}

/* ---------- 무선 고급 설정 (대역별 국가 코드, 최대 출력) ---------- */

// 게스트 네트워크 메뉴(guest.js)가 직접 만들고 관리하는 네트워크 이름
const MANAGED_NETS = ['guest'];

// 자주 쓰는 국가. 목록에 없는 기존 값은 selectEl이 그대로 보존한다.
const COUNTRIES = [
  ['', '지정 안 함 (드라이버 기본값)'], ['KR', '대한민국 (KR)'], ['US', '미국 (US)'], ['JP', '일본 (JP)'],
  ['CN', '중국 (CN)'], ['TW', '대만 (TW)'], ['HK', '홍콩 (HK)'], ['SG', '싱가포르 (SG)'], ['VN', '베트남 (VN)'],
  ['TH', '태국 (TH)'], ['PH', '필리핀 (PH)'], ['ID', '인도네시아 (ID)'], ['MY', '말레이시아 (MY)'], ['IN', '인도 (IN)'],
  ['AU', '호주 (AU)'], ['NZ', '뉴질랜드 (NZ)'], ['CA', '캐나다 (CA)'], ['MX', '멕시코 (MX)'], ['PA', '파나마 (PA)'],
  ['BR', '브라질 (BR)'], ['GB', '영국 (GB)'], ['DE', '독일 (DE)'], ['FR', '프랑스 (FR)'], ['IT', '이탈리아 (IT)'],
  ['ES', '스페인 (ES)'], ['NL', '네덜란드 (NL)'], ['00', '국제 공통 (00, 가장 보수적)'],
];

// 공유기가 아는 전체 국가 목록 (iwinfo countrylist). 자주 쓰는 나라(한글 이름)를 위에, 나머지는 코드 순으로 뒤에 붙인다.
async function countryOptions(ifname) {
  if (!ifname) return COUNTRIES;
  try {
    const d = await ubus('iwinfo', 'countrylist', { device: ifname });
    const known = new Set(COUNTRIES.map(([c]) => c));
    const rest = ((d && d.results) || [])
      .filter((x) => x.code && !known.has(x.code))
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((x) => [x.code, `${x.country || x.code} (${x.code})`]);
    return rest.length ? [...COUNTRIES, ['-sep-', '──────────'], ...rest] : COUNTRIES;
  } catch {
    return COUNTRIES;
  }
}

// iwinfo(rpcd-mod-iwinfo)로 이 무선 장치가 지원하는 출력 목록을 받는다. 없으면 null.
async function txPowerOptions(ifname) {
  if (!ifname) return null;
  try {
    const d = await ubus('iwinfo', 'txpowerlist', { device: ifname });
    const list = (d && d.results) || [];
    if (!list.length) return null;
    return { list: list.map((x) => x.dbm), active: (list.find((x) => x.active) || {}).dbm };
  } catch {
    return null;
  }
}

function wirelessAdvancedPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('무선 고급 설정'), body);
  let alive = true;

  async function load() {
    let sections, status;
    try {
      sections = await uciSections('wireless');
      status = await wirelessStatus().catch(() => ({}));
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const radios = (sections || []).filter((s) => s['.type'] === 'wifi-device');
    if (!radios.length) { body.replaceChildren(messageCard('이 공유기에서 무선 장치를 찾지 못했습니다.')); return; }
    // 각 무선 장치의 실제 인터페이스 이름(phy0-ap0 등)으로 지원 출력 목록을 묻는다
    const ifnames = radios.map((r) => {
      const st = (status || {})[r['.name']];
      return st && (st.interfaces || []).map((i) => i.ifname).find(Boolean);
    });
    const [powers, countries] = await Promise.all([
      Promise.all(ifnames.map(txPowerOptions)),
      countryOptions(ifnames.find(Boolean)),
    ]);
    if (alive) render(radios, powers, countries);
  }

  function render(radios, powers, countries) {
    const bandCount = {};
    for (const r of radios) bandCount[radioBand(r)] = (bandCount[radioBand(r)] || 0) + 1;
    const forms = radios.map((radio, idx) => {
      const band = radioBand(radio) || '2g';
      const title = (BAND_LABEL[band] || radio['.name']) + (bandCount[band] > 1 ? ` (${radio['.name']})` : '');
      const country = selectEl(countries, radio.country || '');
      // 구분선은 고를 수 없게
      [...country.options].filter((o) => o.value === '-sep-').forEach((o) => { o.disabled = true; });
      const pw = powers[idx];
      const dbms = pw ? pw.list : Array.from({ length: 30 }, (_, i) => i + 1);
      const power = selectEl([['', '최대 (기본값)'], ...[...dbms].sort((a, b) => b - a).map((d) => [String(d), `${d} dBm (${Math.round(10 ** (d / 10))} mW)`])],
        radio.txpower || '');
      const fCountry = formField('국가 코드', country, '이 나라 전파법에 맞는 채널과 출력만 씁니다');
      const fPower = formField('최대 출력', power, pw && pw.active != null ? `지금 출력: ${pw.active} dBm` : '국가별 허용 한도를 넘지 않습니다');
      return {
        radio,
        country,
        el: h('section', { class: 'card form-card' },
          h('div', { class: 'card-head' }, h('h3', null, `${title} 무선`),
            radio.disabled === '1' ? h('span', { class: 'pill off' }, '꺼짐') : null),
          h('div', { class: 'fieldset' }, fCountry.el, fPower.el)),
        values() {
          const v = {};
          if (country.value !== (radio.country || '')) v.country = country.value;
          if (power.value !== (radio.txpower || '')) v.txpower = power.value;
          return v;
        },
      };
    });
    const warn = h('p', { class: 'msg warn-msg', hidden: true }, '대역마다 국가 코드가 다릅니다. 보통은 모든 대역에 같은 국가를 쓰세요.');
    const syncWarn = () => { warn.hidden = new Set(forms.map((f) => f.country.value)).size <= 1; };
    forms.forEach((f) => f.country.addEventListener('change', syncWarn));
    syncWarn();
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const ops = forms.map((f) => ({ f, v: f.values() })).filter((x) => Object.keys(x.v).length)
        .map((x) => ({ op: 'set', config: 'wireless', section: x.f.radio['.name'], values: x.v }));
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ok = await confirmDialog('무선 고급 설정 적용', [
        '무선을 다시 시작하므로 무선으로 연결된 기기는 잠시 끊깁니다. 국가를 바꾸면 쓸 수 있는 채널이 달라져 채널이 자동으로 바뀔 수 있습니다.',
        h('p', { class: 'msg warn-msg' }, `${WIFI_APPLY_TIMEOUT}초 안에 다시 접속하지 못하면 이전 설정으로 자동으로 되돌아갑니다.`),
      ], '적용');
      if (!ok) return;
      applyBtn.disabled = true;
      const r = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });
    body.replaceChildren(
      h('p', { class: 'muted' }, '공유기를 쓰는 나라에 맞게 국가 코드를 정하세요. 출력을 낮추면 전파가 닿는 범위가 줄어 이웃과의 간섭이 줄어듭니다.'),
      warn, ...forms.map((f) => f.el),
      h('section', { class: 'card' }, h('div', { class: 'actions', style: 'margin:0' }, applyBtn)));
  }

  load();
  return () => { alive = false; };
}

PAGES['/wireless'] = wirelessPage;
PAGES['/wireless-advanced'] = wirelessAdvancedPage;
