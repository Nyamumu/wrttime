// 게스트 / VLAN 네트워크
//   게스트 네트워크 (guest): 무선 전용. 인터넷만, 무선 기기 간 격리. 정책 고정. 이 화면이 네트워크(주소/DHCP/방화벽)까지 만든다.
//     network: interface guest(고정 IP, 장치 = 빈 브리지 br-guest) / dhcp: guest / firewall: zone guest + 포워딩 + DNS/DHCP 규칙
//     wireless: wifi-iface guest_<radio>
//   VLAN 네트워크: VLAN 설정 메뉴에서 '별도 내부 네트워크'로 이미 만든 VLAN을 골라 무선을 붙이고 무선 격리를 고른다.
//     주소/DHCP/포트와 접속 허용(인터넷/내부 접근/관리 화면)은 VLAN 설정 메뉴에서 정한다 (사용자 요청).
// 방화벽 규칙/포워딩 이름은 'wrtTIME ...'로 붙여서 우리 것을 알아본다.

const GUEST = {
  key: 'guest', title: '게스트 네트워크', ip: '192.168.30.1', suffix: '-Guest', lease: '2h',
  desc: '손님용 무선입니다. 인터넷만 쓸 수 있고, 내부 네트워크의 기기와 다른 손님 기기에는 접근할 수 없습니다.',
  policy: { wan: true, lanTo: false, toLan: false, input: false, isolate: true },
};

// VLAN 설정 메뉴에 있는 VLAN 전부와, 각 VLAN을 쓰는 네트워크.
// [{ vid, dev, ports(문자열), iface, usable, why }]  usable: 여기서 고를 수 있는지, why: 못 고르는 이유
function vlanNetChoices(ctx) {
  const list = [];
  const push = (vid, dev, ports) => {
    const iface = dev ? ifaceUsingDev(ctx.ifaces, ctx.devs, dev) : null;
    const n = iface && iface['.name'];
    let why = '';
    if (!iface) why = '네트워크 없음';
    else if (n === 'lan') why = '내부 네트워크';
    else if (SYSTEM_NETS.includes(n)) why = IFACE_LABEL[n] || n;
    else if (MANAGED_NETS.includes(n)) why = IFACE_LABEL[n] || n;
    else if (iface.proto !== 'static') why = `${n}: 고정 IP 아님`;
    list.push({ vid, dev, ports, iface, usable: !why, why });
  };
  if (ctx.sw) {
    const sw = ctx.sw;
    for (const v of sw.vlans) {
      const ports = parseSwPorts(v.ports).filter((p) => !sw.cpus.some((c) => c.num === p.num))
        .map((p) => `${sw.label(sw.users.find((u) => u.num === p.num) || { num: p.num })} ${p.mode === 't' ? '태그' : '태그 없음'}`);
      push(sw.vid(v), sw.devOf(v), ports.join(', '));
    }
    return list;
  }
  const lan = ctx.ifaces.find((i) => i['.name'] === 'lan');
  const br = lan ? ifaceDev(lan).replace(/\.\d+$/, '') : '';
  ctx.net.filter((s) => s['.type'] === 'bridge-vlan' && s.device === br)
    .sort((a, b) => +a.vlan - +b.vlan)
    .forEach((v) => {
      const ports = asList(v.ports).map(parseVlanPort).map((p) => `${portLabel(p.port)} ${p.mode === 't' ? '태그' : '태그 없음'}`);
      push(String(v.vlan), `${br}.${v.vlan}`, ports.join(', '));
    });
  return list;
}


function guestPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('게스트 / VLAN 네트워크'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let ctx;
    try {
      ctx = await makeNetCtx();
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    ctx.radios = ctx.wl.filter((s) => s['.type'] === 'wifi-device');
    body.replaceChildren(guestCard(ctx), ...vlanNetCards(ctx));
  }

  /* ---------- 공통: 무선 입력칸 ---------- */

  // n: 네트워크 이름, wifis: 지금 붙은 무선, policy: 지금 정책(고정이면 fixed), defaults: { ssid, bands(대역 기본 선택 함수) }
  function wifiPolicyForm(ctx, wifis, policy, fixed, defaults) {
    const lanWifi = ctx.wl.find((s) => s['.type'] === 'wifi-iface' && asList(s.network).includes('lan') && s.ssid);
    const first = wifis[0] || {};
    const ssid = h('input', { type: 'text', value: first.ssid || `${(lanWifi && lanWifi.ssid) || 'OpenWrt'}${defaults.suffix}`, spellcheck: 'false' });
    const enc = selectEl(WIFI_SECURITY, (first.encryption || 'psk2').split('+')[0]);
    const key = h('input', { type: 'password', value: first.key || '', autocomplete: 'new-password', spellcheck: 'false' });
    const f = {
      ssid: formField('무선 이름 (SSID)', ssid),
      enc: formField('보안 방식', enc),
      key: formField('무선 암호', key, '8~63자'),
    };
    const radioChecks = ctx.radios.map((r) => {
      const band = radioBand(r) || '2g';
      const c = h('input', { type: 'checkbox' });
      c.checked = wifis.length ? wifis.some((w) => w.device === r['.name']) : defaults.bands(band);
      return { r, c, el: h('label', null, c, (BAND_LABEL[band] || r['.name']) + (r.disabled === '1' ? ' (꺼짐)' : '')) };
    });
    // 무선 격리만 여기서 고른다 (게스트는 고정). 인터넷/내부/관리 화면 접속 허용은 VLAN 설정 메뉴에서.
    const isolate = toggleEl(policy.isolate, '무선 기기끼리 서로 보이지 않게 격리');
    const bandErr = h('p', { class: 'msg', hidden: true });
    const keyBox = h('div', null, f.key.el);
    const credBox = h('div', null, h('div', { class: 'fieldset' }, f.ssid.el, f.enc.el), keyBox);
    const sync = () => {
      keyBox.hidden = enc.value === 'none';
      credBox.hidden = !radioChecks.some((x) => x.c.checked);
    };
    enc.addEventListener('change', sync);
    radioChecks.forEach((x) => x.c.addEventListener('change', sync));
    sync();
    const has6g = ctx.radios.some((r) => radioBand(r) === '6g');
    const el = h('div', null,
      ctx.radios.length ? h('div', { class: 'field' }, h('span', null, defaults.bandTitle),
        h('div', { class: 'days' }, radioChecks.map((x) => x.el))) : null,
      bandErr, credBox,
      has6g ? h('p', { class: 'muted' }, '6GHz 대역은 규격상 WPA3만 쓸 수 있어 자동으로 WPA3(SAE)로 설정됩니다.') : null,
      fixed ? null : isolate.el);
    return {
      el,
      radioChecks,
      // 검사 후 { chosen, wifiVals, policy } 또는 null
      read(needBand) {
        Object.values(f).forEach((x) => x.setError(null));
        bandErr.hidden = true;
        const chosen = radioChecks.filter((x) => x.c.checked);
        let bad = false;
        if (needBand && !chosen.length) { bandErr.textContent = '대역을 하나 이상 고르세요.'; bandErr.hidden = false; bad = true; }
        if (chosen.length) {
          if (!ssid.value.trim() || utf8Len(ssid.value) > 32) { f.ssid.setError('1~32바이트로 입력해 주세요.'); bad = true; }
          if (enc.value !== 'none' && !/^[\x20-\x7e]{8,63}$/.test(key.value)) { f.key.setError('영문/숫자/기호 8~63자로 입력해 주세요.'); bad = true; }
        }
        if (bad) return null;
        const pol = fixed ? { ...policy } : { ...policy, isolate: isolate.input.checked };
        return {
          chosen,
          policy: pol,
          wifiVals: { ssid: ssid.value, encryption: enc.value, key: enc.value === 'none' ? '' : key.value, isolate: pol.isolate ? '1' : '' },
        };
      },
    };
  }

  // 무선 변경: 대역별로 추가/삭제/수정
  function wifiOps(ctx, n, wifis, radioChecks, wifiVals) {
    const ops = [];
    for (const x of radioChecks) {
      const w = wifis.find((s) => s.device === x.r['.name']);
      const vals = wifiValsFor(x.r, wifiVals);
      if (x.c.checked && !w) {
        const name = `${n}_${x.r['.name']}`;
        // 같은 이름이 이미 있으면 uci add가 그 섹션의 타입을 바꿔 버리므로 이름 없이 만든다
        const named = !ctx.wl.some((s) => s['.name'] === name);
        ops.push({ op: 'add', config: 'wireless', type: 'wifi-iface', ...(named ? { name } : {}),
          values: { device: x.r['.name'], mode: 'ap', network: n, ...dropEmpty(vals) } });
      } else if (!x.c.checked && w) {
        ops.push({ op: 'delete', config: 'wireless', section: w['.name'] });
      } else if (w) {
        const v = {};
        for (const [opt, val] of Object.entries(vals)) {
          const old = opt === 'encryption' ? (w.encryption || 'none').split('+')[0] : (w[opt] || '');
          if (val !== old) v[opt] = val;
        }
        if (Object.keys(v).length) ops.push({ op: 'set', config: 'wireless', section: w['.name'], values: v });
      }
    }
    return ops;
  }

  // readPolicy / policyOps (접속 허용 읽기/바꾸기)는 VLAN 설정 메뉴와 같이 쓰므로 vlan.js에 있다.

  /* ---------- 게스트 네트워크 ---------- */

  function guestCard(ctx) {
    const k = GUEST;
    const key = k.key;
    const iface = ctx.ifaces.find((i) => i['.name'] === key);
    const bridge = ctx.devs.find((s) => s.type === 'bridge' && s.name === `br-${key}`);
    const ourFw = ctx.fw.some((s) => ['wrtTIME', 'NMMWrt'].some((p) => String(s.name || '').startsWith(`${p} ${key} `)));
    const foreign = iface && ifaceDev(iface) !== `br-${key}` && !ourFw;
    const enabled = !!iface && !foreign;
    const head = h('div', { class: 'card-head' }, h('h3', null, k.title),
      h('span', { class: 'pill ' + (enabled ? 'ok' : 'off') }, enabled ? '사용 중' : '꺼짐'));
    if (foreign) {
      return h('section', { class: 'card form-card' }, head, h('p', null, k.desc),
        h('p', { class: 'msg warn-msg' }, `'${key}' 이름의 다른 네트워크가 이미 있어 여기서 관리할 수 없습니다.`));
    }
    if (!ctx.radios.length) {
      return h('section', { class: 'card form-card' }, head, h('p', null, k.desc),
        h('p', { class: 'muted' }, '이 공유기에는 무선 장치가 없어 쓸 수 없습니다.'));
    }
    const wifis = ctx.wl.filter((s) => s['.type'] === 'wifi-iface' && asList(s.network).includes(key));
    const cur = iface ? readAddr(iface) : { ip: k.ip, mask: '255.255.255.0' };
    const on = toggleEl(enabled, `${k.title} 사용`);
    const form = wifiPolicyForm(ctx, wifis, k.policy, true, { suffix: k.suffix, bandTitle: '사용할 대역', bands: () => true });
    const ip = h('input', { type: 'text', inputmode: 'decimal', value: cur.ip });
    const mask = h('input', { type: 'text', inputmode: 'decimal', value: cur.mask || '255.255.255.0' });
    const fIp = formField('공유기 주소 (이 네트워크)', ip);
    const fMask = formField('서브넷 마스크', mask);
    const detail = h('div', null, form.el, h('div', { class: 'fieldset' }, fIp.el, fMask.el));
    const sync = () => { detail.hidden = !on.input.checked; };
    on.input.addEventListener('change', sync);
    sync();

    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fIp.setError(null);
      fMask.setError(null);
      const want = on.input.checked;
      if (!want && !enabled) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      let ops;
      if (!want) {
        if (!await confirmDialog(`${k.title} 끄기`, `${k.title}의 무선, 주소, 방화벽 설정을 모두 지웁니다. 연결된 기기는 끊깁니다.`, '끄기', true)) return;
        ops = vlanNetworkDeleteOps(ctx, key, null);
      } else {
        const v = form.read(true);
        const a = ip.value.trim();
        const mm = mask.value.trim();
        const err = subnetError(ctx, a, mm, key);
        if (err) (err.field === 'mask' ? fMask : fIp).setError(err.text);
        if (!v || err) return;
        ops = [];
        if (!enabled) {
          ops.push(
            { op: 'add', config: 'network', type: 'device', values: { type: 'bridge', name: `br-${key}`, bridge_empty: '1' } },
            { op: 'add', config: 'network', type: 'interface', name: key,
              values: { proto: 'static', device: `br-${key}`, ipaddr: `${a}/${maskBits(mm)}` } },
            { op: 'add', config: 'dhcp', type: 'dhcp', name: key, values: { interface: key, start: '100', limit: '150', leasetime: k.lease } });
        } else if (a !== cur.ip || mm !== cur.mask) {
          const cidr = `${a}/${maskBits(mm)}`;
          ops.push({ op: 'set', config: 'network', section: key, values: { ipaddr: Array.isArray(iface.ipaddr) ? [cidr] : cidr, netmask: '' } });
        }
        if (!bridge && enabled && ifaceDev(iface) === `br-${key}`) {
          ops.push({ op: 'add', config: 'network', type: 'device', values: { type: 'bridge', name: `br-${key}`, bridge_empty: '1' } });
        }
        ops.push(...policyOps(key, readPolicy(ctx, key, wifis, k.policy), v.policy, key));
        ops.push(...wifiOps(ctx, key, wifis, form.radioChecks, v.wifiVals));
        if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      }
      applyBtn.disabled = true;
      const r = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      applyBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });

    return h('section', { class: 'card form-card' }, head, h('p', { class: 'muted' }, k.desc), on.el, detail,
      h('div', { class: 'actions' }, applyBtn));
  }

  /* ---------- VLAN 네트워크 ---------- */

  // VLAN 네트워크: 맨 위 카드(상태 + 추가 버튼) 다음에 무선이 붙은 VLAN 네트워크마다 카드 하나씩.
  // 무선이 붙은 VLAN 네트워크가 없으면 '꺼짐'. 추가는 창(모달)에서 VLAN을 골라 무선을 정한다.
  // 접속 허용은 VLAN 설정 메뉴에서 정하므로 여기서는 지금 값을 안내만 하고 그대로 둔다 (policyOps는 zone이 없을 때만 만든다).
  function vlanNetCards(ctx) {
    const choices = vlanNetChoices(ctx);
    const wifisOf = (n) => ctx.wl.filter((s) => s['.type'] === 'wifi-iface' && asList(s.network).includes(n));
    const active = choices.filter((c) => c.usable && wifisOf(c.iface['.name']).length);
    const free = choices.filter((c) => c.usable && !wifisOf(c.iface['.name']).length);
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => openAdd(ctx, choices, free, wifisOf) }, '추가');
    const head = h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, 'VLAN 네트워크'),
        h('span', { class: 'pill ' + (active.length ? 'ok' : 'off') }, active.length ? `${active.length}개 사용 중` : '꺼짐')),
      h('p', { class: 'muted' }, 'VLAN 설정 메뉴에서 만든 VLAN 네트워크에 무선을 붙입니다. 네트워크마다 무선 이름과 암호를 따로 정합니다. 주소, 포트, 접속 허용(인터넷·내부 네트워크·관리 화면)은 VLAN 설정 메뉴에서 바꿉니다.'),
      ctx.radios.length ? null : h('p', { class: 'muted' }, '이 공유기에는 무선 장치가 없어 쓸 수 없습니다.'),
      ctx.radios.length && !active.length ? h('p', null, '무선이 붙은 VLAN 네트워크가 없습니다. "추가"를 눌러 만드세요.') : null,
      ctx.radios.length ? h('div', { class: 'actions' }, addBtn) : null);
    return [head, ...active.map((c) => vlanWifiCard(ctx, c, wifisOf(c.iface['.name'])))];
  }

  const vlanTitle = (c) => `VLAN ${c.vid} — ${c.iface['.name']} · ${readAddr(c.iface).ip || c.iface.proto}`;
  const netInfo = (ctx, c) => {
    const addr = readAddr(c.iface);
    const dhcp = ctx.dhcp.find((s) => s['.type'] === 'dhcp' && s.interface === c.iface['.name']);
    const pol = readPolicy(ctx, c.iface['.name'], [], POLICY_DEFAULT).policy;
    return h('div', null,
      h('p', { class: 'muted', style: 'margin-bottom:2px' }, `주소 ${addr.ip || '-'}${addr.mask ? ` / ${addr.mask}` : ''} · DHCP ${dhcp && dhcp.ignore !== '1' ? '켜짐' : '꺼짐'}`),
      h('p', { class: 'muted' }, `접속 허용: ${policySummary(pol)} `,
        h('a', { href: '#/vlan', onclick: closeModal }, 'VLAN 설정에서 바꾸기')));
  };

  // 무선이 붙은 VLAN 네트워크 하나
  function vlanWifiCard(ctx, c, wifis) {
    const n = c.iface['.name'];
    const st = readPolicy(ctx, n, wifis, POLICY_DEFAULT);
    const form = wifiPolicyForm(ctx, wifis, st.policy, false, { suffix: `-VLAN${c.vid}`, bandTitle: '무선 대역', bands: () => false });
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const v = form.read(true);
      if (!v) return;
      const ops = [...bridgeOps(ctx, c, true), ...policyOps(n, st, v.policy, `VLAN ${n}`), ...wifiOps(ctx, n, wifis, form.radioChecks, v.wifiVals)];
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      applyBtn.disabled = true;
      const r = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      applyBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });
    const delBtn = h('button', { class: 'btn btn-ghost btn-inline', type: 'button' }, '무선 삭제');
    delBtn.addEventListener('click', async () => {
      if (!await confirmDialog('무선 삭제', `VLAN ${c.vid}(${n})의 무선을 지웁니다. 이 무선에 연결된 기기는 끊깁니다. VLAN과 유선 포트, 접속 허용 설정은 그대로 남습니다.`, '삭제', true)) return;
      const r = await runApply(wifis.map((w) => ({ op: 'delete', config: 'wireless', section: w['.name'] })), { timeout: WIFI_APPLY_TIMEOUT });
      if (r === 'applied' || r === 'rolledback') reload();
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, vlanTitle(c)), h('span', { class: 'pill ok' }, '사용 중')),
      netInfo(ctx, c), form.el, h('div', { class: 'actions' }, delBtn, applyBtn));
  }

  // 추가: VLAN 고르기 + 무선 + 접속 허용 (창)
  async function openAdd(ctx, choices, free, wifisOf) {
    if (!free.length) {
      const go = await confirmDialog('VLAN 네트워크 추가',
        choices.some((c) => c.usable)
          ? '무선을 붙일 수 있는 VLAN 네트워크가 모두 이미 쓰이고 있습니다. 새 VLAN은 VLAN 설정 메뉴에서 "별도 내부 네트워크로 만들기"를 골라 추가하세요.'
          : '무선을 붙일 VLAN 네트워크가 없습니다. 먼저 VLAN 설정 메뉴에서 VLAN을 추가할 때 "별도 내부 네트워크로 만들기"를 고르세요.',
        'VLAN 설정으로 가기');
      if (go) location.hash = '#/vlan';
      return;
    }
    const label = (c) => {
      if (!c.usable) return `VLAN ${c.vid} — ${c.why} (고를 수 없음)`;
      return vlanTitle(c) + (wifisOf(c.iface['.name']).length ? ' (이미 무선 사용 중)' : '');
    };
    const sel = h('select', null, choices.map((c) => h('option', {
      value: c.usable ? c.iface['.name'] : '', disabled: !free.includes(c),
    }, label(c))));
    sel.value = free[0].iface['.name'];
    const box = h('div');
    let cur = null;
    const draw = () => {
      const c = free.find((x) => x.iface['.name'] === sel.value);
      const n = c.iface['.name'];
      const st = readPolicy(ctx, n, [], POLICY_DEFAULT);
      const form = wifiPolicyForm(ctx, [], st.policy, false,
        { suffix: `-VLAN${c.vid}`, bandTitle: '무선 대역', bands: (band) => band === '2g' });
      cur = { c, n, st, form };
      box.replaceChildren(netInfo(ctx, c), form.el);
    };
    sel.addEventListener('change', draw);
    draw();
    const save = h('button', { class: 'btn', type: 'button' }, '추가');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', async () => {
      const v = cur.form.read(true);
      if (!v) return;
      const ops = [...bridgeOps(ctx, cur.c, true), ...policyOps(cur.n, cur.st, v.policy, `VLAN ${cur.n}`), ...wifiOps(ctx, cur.n, [], cur.form.radioChecks, v.wifiVals)];
      closeModal();
      const r = await runApply(ops, { timeout: WIFI_APPLY_TIMEOUT });
      if (r === 'applied' || r === 'rolledback') reload();
    });
    showModal(h('h3', null, 'VLAN 네트워크 추가'),
      formField('연결할 VLAN', sel, 'VLAN 설정에서 "별도 내부 네트워크"로 만든 VLAN만 고를 수 있습니다').el,
      box, h('div', { class: 'actions' }, cancel, save));
  }

  // 무선을 붙이려면 인터페이스 장치가 브리지(또는 브리지의 VLAN 장치 br-lan.20)여야 한다.
  // swconfig의 eth0.20 같은 장치를 바로 쓰면 브리지 br-<이름>으로 감싼다.
  function bridgeOps(ctx, c, needWifi) {
    if (!needWifi) return [];
    const n = c.iface['.name'];
    const dev = ifaceDev(c.iface);
    const isBridge = (name) => ctx.devs.some((d) => d.type === 'bridge' && d.name === name);
    if (isBridge(dev) || isBridge(dev.replace(/\.\d+$/, ''))) return [];
    const brName = `br-${n}`;
    const ops = [];
    const old = ctx.devs.find((d) => d.name === brName);
    if (old) ops.push({ op: 'set', config: 'network', section: old['.name'], values: { type: 'bridge', ports: [dev], bridge_empty: '' } });
    else ops.push({ op: 'add', config: 'network', type: 'device', values: { type: 'bridge', name: brName, ports: [dev] } });
    ops.push({ op: 'set', config: 'network', section: n, values: { device: brName } });
    return ops;
  }

  load();
  return () => { alive = false; };
}

function dropEmpty(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));
}

// 6GHz는 WPA3(SAE)만 허용한다 (암호 없음은 OWE). 다른 대역은 고른 그대로.
function wifiValsFor(radio, vals) {
  if (radioBand(radio) !== '6g') return vals;
  return { ...vals, encryption: vals.encryption === 'none' ? 'owe' : 'sae' };
}

PAGES['/guest'] = guestPage;
