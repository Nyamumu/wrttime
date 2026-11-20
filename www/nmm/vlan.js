// VLAN 설정. 공유기의 스위치 방식에 따라 두 가지로 다룬다 (OpenWrt 25 이상).
//   DSA      : 포트가 각각 리눅스 장치(lan1, lan2, wan ...). network의 device(bridge) + bridge-vlan 섹션.
//   swconfig : 스위치 칩 하나에 포트 번호(0~6). network의 switch + switch_vlan 섹션, CPU 포트 장치는 eth0.<VID>.
// 포트 수/이름/역할은 /etc/board.json으로 알아낸다.

const VLAN_APPLY_TIMEOUT = 120; // 브리지/스위치를 다시 구성하면 내부 네트워크가 잠깐 끊길 수 있다
const PORT_MODES = [['', '사용 안 함'], ['u', '태그 없음 (U)'], ['t', '태그 (T)']];
const NET_NAME_RE = /^[a-z][a-z0-9_]{0,10}$/;

/* ---------- 공통 ---------- */

// DSA bridge-vlan 포트 'lan1:u*' -> { port, mode }
function parseVlanPort(s) {
  const m = String(s).match(/^([^:]+)(?::([ut]))?(\*)?$/);
  if (!m) return { port: s, mode: 'u' };
  return { port: m[1], mode: m[2] || 'u' };
}

// swconfig 포트 목록 '1 2 3 4 0t' -> [{ num, mode }]
function parseSwPorts(s) {
  return asList(s).map((t) => {
    const m = /^(\d+)([tu*]*)$/.exec(t);
    return m ? { num: +m[1], mode: m[2].includes('t') ? 't' : 'u' } : null;
  }).filter(Boolean);
}

function vlanIdOk(s, min) {
  return /^\d+$/.test(s) && +s >= min && +s <= 4094;
}

// VLAN 표의 포트 칸을 선택 상자로 만들고, 바뀐 VLAN만 골라 낸다.
// rows: [{ key, label(VLAN 번호), modes: {포트: ''|'u'|'t'} }], ports: [{ id, label }]
function portMatrix(rows, ports) {
  const cells = rows.map((r) => ({
    r,
    sels: Object.fromEntries(ports.map((p) => {
      const s = selectEl(PORT_MODES, r.modes[p.id] || '');
      s.classList.add('cell-select');
      return [p.id, s];
    })),
  }));
  return {
    cellsFor: (key) => ports.map((p) => cells.find((c) => c.r.key === key).sels[p.id]),
    // 검사 + 바뀐 행. 잘못되면 { error }
    collect() {
      const untagged = {};
      for (const c of cells) {
        for (const p of ports) {
          if (c.sels[p.id].value !== 'u') continue;
          if (untagged[p.id]) return { error: `${p.label} 포트가 VLAN ${untagged[p.id]}과 ${c.r.label}에 모두 태그 없음입니다. 태그 없음은 포트마다 하나만 가능합니다.` };
          untagged[p.id] = c.r.label;
        }
      }
      const changed = cells.filter((c) => ports.some((p) => (c.sels[p.id].value || '') !== (c.r.modes[p.id] || '')))
        .map((c) => ({ key: c.r.key, modes: Object.fromEntries(ports.map((p) => [p.id, c.sels[p.id].value])) }));
      return { changed };
    },
  };
}

// swconfig 스위치 정보. swconfig 공유기가 아니면 null.
function switchInfo(net, board) {
  const swSec = net.find((s) => s['.type'] === 'switch');
  const all = net.filter((s) => s['.type'] === 'switch_vlan');
  if (!swSec && !all.length) return null;
  const name = (swSec && swSec.name) || all[0].device;
  const vlans = all.filter((v) => v.device === name).sort((a, b) => +(a.vid || a.vlan) - +(b.vid || b.vlan));
  const bports = (((board || {}).switch || {})[name] || {}).ports || [];
  let cpus = bports.filter((p) => p.device);
  let users = bports.filter((p) => !p.device);
  if (!bports.length) {
    // board.json에 없으면: 모든 VLAN에 태그로 들어 있는 포트를 CPU 포트로 본다
    const parsed = vlans.map((v) => parseSwPorts(v.ports));
    const nums = [...new Set(parsed.flat().map((p) => p.num))].sort((a, b) => a - b);
    const cpuNums = nums.filter((n) => parsed.length && parsed.every((ps) => ps.some((p) => p.num === n && p.mode === 't')));
    const lanBr = net.find((s) => s['.type'] === 'device' && s.type === 'bridge');
    const guessDev = ((asList(lanBr && lanBr.ports)[0] || 'eth0').split('.')[0]);
    cpus = cpuNums.map((num) => ({ num, device: guessDev }));
    users = nums.filter((n) => !cpuNums.includes(n)).map((num) => ({ num }));
  }
  const label = (p) => (p.role === 'lan' ? `LAN ${p.index || ''}`.trim() : p.role === 'wan' ? 'WAN' : `포트 ${p.num}`);
  const vid = (v) => String(v.vid || v.vlan);
  // VLAN이 쓰는 CPU 쪽 리눅스 장치: CPU 포트의 장치 + '.' + VID
  const devOf = (v) => {
    const ps = parseSwPorts(v.ports);
    const cpu = cpus.find((c) => ps.some((p) => p.num === c.num)) || cpus[0];
    return cpu ? `${cpu.device}.${vid(v)}` : '';
  };
  return { name, vlans, cpus, users, label, vid, devOf };
}

// 새 네트워크 주소 검사: 형식, 네트워크/브로드캐스트 주소, 다른 인터페이스와 대역 겹침 (except: 자기 자신 이름)
// 문제가 있으면 { field: 'ip'|'mask', text }. guest.js도 쓴다.
function subnetError(ctx, a, mm, except) {
  if (!isIPv4(a)) return { field: 'ip', text: 'IP 주소 형식이 올바르지 않습니다.' };
  if (!isNetmask(mm)) return { field: 'mask', text: '서브넷 마스크 형식이 올바르지 않습니다.' };
  const host = (ipToInt(a) & ~ipToInt(mm)) >>> 0;
  if (host === 0 || host === ((~ipToInt(mm)) >>> 0)) return { field: 'ip', text: '네트워크/브로드캐스트 주소는 쓸 수 없습니다.' };
  const other = ctx.ifaces.filter((i) => i['.name'] !== except).map((i) => [i['.name'], readAddr(i)])
    .find(([, ad]) => ad.ip && isIPv4(ad.ip) && (sameSubnet(a, ad.ip, mm) || (isNetmask(ad.mask || '') && sameSubnet(a, ad.ip, ad.mask))));
  if (other) return { field: 'ip', text: `'${other[0]}' 네트워크(${other[1].ip})와 대역이 겹칩니다.` };
  return null;
}

// 어떤 장치를 쓰는 인터페이스 (장치를 직접 쓰거나, 그 장치를 포트로 가진 브리지를 쓰는 경우)
function ifaceUsingDev(ifaces, devs, dev) {
  const direct = ifaces.find((i) => ifaceDev(i) === dev);
  if (direct) return direct;
  const br = devs.find((d) => d.type === 'bridge' && asList(d.ports).includes(dev));
  return br ? ifaces.find((i) => ifaceDev(i) === br.name) : null;
}

/* ---------- 페이지 ---------- */

function vlanPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('VLAN 설정'), body);
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
    if (!ctx.net.length) { body.replaceChildren(messageCard('네트워크 설정을 찾을 수 없습니다.')); return; }
    render(ctx);
  }

  function render(ctx) {
    const lan = ctx.ifaces.find((s) => s['.name'] === 'lan');
    const wan = ctx.ifaces.find((s) => s['.name'] === 'wan');
    body.replaceChildren(
      wan ? wanVlanCard(ctx, wan) : messageCard('인터넷(WAN) 인터페이스가 없는 공유기입니다. 인터넷 VLAN 태그는 쓸 수 없습니다.'),
      ...guestStatusCards(ctx),
      lan ? (ctx.sw ? swconfigCard(ctx, lan) : dsaCard(ctx, lan)) : messageCard('내부 네트워크(LAN) 인터페이스가 없습니다.'),
    );
  }

  /* ----- 공통: 별도 네트워크 입력칸과 변경 목록 ----- */

  function networkForm() {
    const mk = toggleEl(true, '이 VLAN을 별도 내부 네트워크로 만들기 (주소 자동 할당)');
    const name = h('input', { type: 'text', placeholder: '예: iot', spellcheck: 'false' });
    const ip = h('input', { type: 'text', inputmode: 'decimal', placeholder: '예: 192.168.20.1' });
    const mask = h('input', { type: 'text', inputmode: 'decimal', value: '255.255.255.0' });
    const dhcpOn = toggleEl(true, '이 네트워크에 DHCP 서버 사용');
    const f = {
      name: formField('네트워크 이름 (영문 소문자/숫자)', name),
      ip: formField('공유기 주소', ip),
      mask: formField('서브넷 마스크', mask),
    };
    const pol = policyChecks(POLICY_DEFAULT);
    const box = h('div', null, h('div', { class: 'fieldset' }, f.name.el, f.ip.el, f.mask.el), dhcpOn.el, pol.el,
      h('p', { class: 'muted' }, '무선은 무선 관리 > 게스트 / VLAN 네트워크에서 붙일 수 있습니다. 접속 허용은 나중에 표의 "수정"으로 바꿀 수 있습니다.'));
    mk.input.addEventListener('change', () => { box.hidden = !mk.input.checked; });
    return {
      el: h('div', null, mk.el, box),
      clear() { Object.values(f).forEach((x) => x.setError(null)); },
      // 입력을 검사하고 변경 목록을 돌려준다. 만들지 않으면 [], 잘못되면 null.
      ops(ctx, dev) {
        if (!mk.input.checked) return [];
        const n = name.value.trim();
        const a = ip.value.trim();
        const mm = mask.value.trim();
        let bad = false;
        if (!NET_NAME_RE.test(n)) { f.name.setError('영문 소문자로 시작하는 1~11자 (소문자, 숫자, _)'); bad = true; }
        else if (SYSTEM_NETS.includes(n) || MANAGED_NETS.includes(n) || ctx.ifaces.some((i) => i['.name'] === n)
          || ctx.dhcp.some((d) => d['.name'] === n) || ctx.fw.some((z) => z['.type'] === 'zone' && z.name === n)) {
          f.name.setError('이미 있거나 쓸 수 없는 이름입니다.'); bad = true;
        }
        const err = subnetError(ctx, a, mm, null);
        if (err) { (err.field === 'mask' ? f.mask : f.ip).setError(err.text); bad = true; }
        if (bad) return null;
        return [
          { op: 'add', config: 'network', type: 'interface', name: n,
            values: { proto: 'static', device: dev, ipaddr: `${a}/${maskBits(mm)}` } },
          { op: 'add', config: 'dhcp', type: 'dhcp', name: n,
            values: dhcpOn.input.checked ? { interface: n, start: '100', limit: '150', leasetime: '12h' } : { interface: n, ignore: '1' } },
          ...policyOps(n, readPolicy(ctx, n, [], POLICY_DEFAULT), pol.value(), `VLAN ${n}`),
        ];
      },
    };
  }

  // VLAN을 지운다. 연결된 별도 네트워크(무선, 접속 허용 포함)도 함께 지운다.
  async function deleteVlan(ctx, section, vidText, iface) {
    const n = iface && iface['.name'];
    let text = `VLAN ${vidText}을 삭제합니다.`;
    if (n) text = `VLAN ${vidText}과 여기에 연결된 '${n}' 네트워크(주소, DHCP, 방화벽, 무선 설정)를 함께 삭제합니다.`;
    const ok = await confirmDialog('VLAN 삭제', text, '삭제', true);
    if (!ok) return;
    const ops = n ? vlanNetworkDeleteOps(ctx, n, section) : [{ op: 'delete', config: 'network', section }];
    const r = await runApply(ops, { timeout: VLAN_APPLY_TIMEOUT });
    if (r === 'applied' || r === 'rolledback') reload();
  }

  function netText(iface) {
    return iface ? `${IFACE_LABEL[iface['.name']] || iface['.name']} (${readAddr(iface).ip || iface.proto})` : '-';
  }

  // 표의 네트워크 칸: 이름(주소) + 고정 IP인 별도 네트워크면 '수정' 버튼
  function netCell(ctx, iface) {
    // 게스트 네트워크는 그 메뉴에서 고친다
    const editable = iface && iface.proto === 'static' && !SYSTEM_NETS.includes(iface['.name']) && !MANAGED_NETS.includes(iface['.name']);
    return h('td', null, netText(iface), editable
      ? h('button', { class: 'btn btn-ghost btn-small', type: 'button', style: 'margin-left:6px', onclick: () => editNetwork(ctx, iface) }, '수정')
      : null,
      editable ? h('div', { class: 'muted' }, `접속 허용: ${policySummary(readPolicy(ctx, iface['.name'], [], POLICY_DEFAULT).policy)}`) : null,
      netWifiLine(ctx, iface));
  }

  async function editNetwork(ctx, iface) {
    const n = iface['.name'];
    const cur = readAddr(iface);
    const dhcp = ctx.dhcp.find((s) => s['.type'] === 'dhcp' && s.interface === n);
    const ip = h('input', { type: 'text', inputmode: 'decimal', value: cur.ip });
    const mask = h('input', { type: 'text', inputmode: 'decimal', value: cur.mask || '255.255.255.0' });
    const fIp = formField('공유기 주소', ip);
    const fMask = formField('서브넷 마스크', mask);
    const dOn = toggleEl(dhcp ? dhcp.ignore !== '1' : false, 'DHCP 서버 사용');
    const st = readPolicy(ctx, n, [], POLICY_DEFAULT);
    const pol = policyChecks(st.policy);
    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', async () => {
      fIp.setError(null);
      fMask.setError(null);
      const a = ip.value.trim();
      const mm = mask.value.trim();
      const err = subnetError(ctx, a, mm, n);
      if (err) { (err.field === 'mask' ? fMask : fIp).setError(err.text); return; }
      const cidr = `${a}/${maskBits(mm)}`;
      const ops = [];
      if (a !== cur.ip || mm !== cur.mask) {
        ops.push({ op: 'set', config: 'network', section: n,
          values: { ipaddr: Array.isArray(iface.ipaddr) ? [cidr] : cidr, netmask: '' } });
      }
      const wantDhcp = dOn.input.checked;
      if (dhcp && wantDhcp !== (dhcp.ignore !== '1')) {
        ops.push({ op: 'set', config: 'dhcp', section: dhcp['.name'], values: { ignore: wantDhcp ? '' : '1' } });
      } else if (!dhcp && wantDhcp) {
        ops.push({ op: 'add', config: 'dhcp', type: 'dhcp', name: n, values: { interface: n, start: '100', limit: '150', leasetime: '12h' } });
      }
      ops.push(...policyOps(n, st, pol.value(), `VLAN ${n}`));
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const r = await runApply(ops);
      if (r === 'applied' || r === 'rolledback') reload();
    });
    showModal(h('h3', null, `'${n}' 네트워크 수정`),
      h('p', { class: 'muted' }, '주소를 바꾸면 이 네트워크의 기기는 다시 접속해야 새 주소를 받습니다.'),
      fIp.el, fMask.el, dOn.el, pol.el, h('div', { class: 'actions' }, cancel, save));
  }

  /* ----- 인터넷(WAN) VLAN 태그 ----- */

  function wanVlanCard(ctx, wan) {
    const wan6 = ctx.ifaces.find((s) => s['.name'] === 'wan6');
    const curDev = ifaceDev(wan);
    const sw = ctx.sw;
    // swconfig에서 WAN이 스위치 VLAN(eth0.2 등)이면 스위치 쪽에서 태그를 붙인다
    const swWan = sw && sw.vlans.find((v) => sw.devOf(v) === curDev);
    let tagged;
    let curVid;
    let base = curDev;
    if (swWan) {
      const wanPorts = parseSwPorts(swWan.ports).filter((p) => !sw.cpus.some((c) => c.num === p.num));
      tagged = wanPorts.length > 0 && wanPorts.every((p) => p.mode === 't');
      curVid = tagged ? sw.vid(swWan) : '';
    } else {
      const m = curDev.match(/^(.+)\.(\d+)$/);
      tagged = !!m;
      base = m ? m[1] : curDev;
      curVid = m ? m[2] : '';
    }
    const on = toggleEl(tagged, '인터넷 포트에 VLAN 태그 붙이기');
    const vid = h('input', { type: 'text', inputmode: 'numeric', value: curVid, placeholder: '예: 100' });
    const fVid = formField('VLAN ID (1~4094)', vid, '통신사에서 알려 준 번호');
    const box = h('div', { class: 'fieldset' }, fVid.el);
    const sync = () => { box.hidden = !on.input.checked; };
    on.input.addEventListener('change', sync);
    sync();
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fVid.setError(null);
      const want = on.input.checked;
      const id = vid.value.trim();
      if (want && !vlanIdOk(id, 1)) { fVid.setError('1~4094 사이의 숫자를 입력해 주세요.'); return; }
      if (want === tagged && (!want || id === curVid)) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ops = [];
      const setDev = (dev) => {
        ops.push({ op: 'set', config: 'network', section: 'wan', values: { device: dev } });
        if (wan6 && ifaceDev(wan6) === curDev) ops.push({ op: 'set', config: 'network', section: 'wan6', values: { device: dev } });
      };
      if (swWan) {
        if (want && sw.vlans.some((v) => v !== swWan && sw.vid(v) === id)) { fVid.setError('내부 VLAN에서 이미 쓰는 번호입니다.'); return; }
        const ports = parseSwPorts(swWan.ports).map((p) => {
          const isCpu = sw.cpus.some((c) => c.num === p.num);
          return `${p.num}${isCpu || want ? 't' : ''}`;
        }).join(' ');
        const values = { ports };
        if (want) values.vid = id;
        ops.push({ op: 'set', config: 'network', section: swWan['.name'], values });
        if (want) setDev(sw.devOf({ ...swWan, vid: id }));
      } else {
        const devs = ctx.devs;
        const newDev = want ? `${base}.${id}` : base;
        if (tagged) {
          const old = devs.find((d) => d.name === curDev && d.type === '8021q');
          if (old) ops.push({ op: 'delete', config: 'network', section: old['.name'] });
        }
        if (want && !devs.some((d) => d.name === newDev)) {
          ops.push({ op: 'add', config: 'network', type: 'device', values: { type: '8021q', ifname: base, vid: id, name: newDev } });
        }
        setDev(newDev);
      }
      applyBtn.disabled = true;
      const r = await runApply(ops);
      applyBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });
    const portText = swWan
      ? parseSwPorts(swWan.ports).filter((p) => !sw.cpus.some((c) => c.num === p.num))
        .map((p) => sw.label(sw.users.find((u) => u.num === p.num) || { num: p.num })).join(', ')
      : portLabel(base);
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '인터넷(WAN) VLAN 태그'),
        h('span', { class: 'pill ' + (tagged ? 'ok' : 'off') }, tagged ? `VLAN ${curVid}` : '사용 안 함')),
      h('p', { class: 'muted' }, `일부 통신사(광랜, IPTV 결합 등)는 인터넷 포트에 VLAN 번호를 붙여야 연결됩니다. 통신사 안내가 없으면 끄세요. (인터넷 포트: ${portText || '-'})`),
      on.el, box, h('div', { class: 'actions' }, applyBtn));
  }

  /* ----- DSA: bridge-vlan ----- */

  function dsaCard(ctx, lan) {
    const lanDev = ifaceDev(lan);
    const brName = lanDev.replace(/\.\d+$/, '');
    const bridge = ctx.devs.find((d) => d.name === brName && d.type === 'bridge');
    const head = h('div', { class: 'card-head' }, h('h3', null, '내부 VLAN'));

    // 브리지가 아닌 단일 포트(lan이 eth0 같은 장치를 바로 씀): 브리지를 만들면서 시작한다
    if (!bridge) {
      const port = lanDev;
      const newBr = ctx.devs.some((d) => d.name === 'br-lan') ? 'br-vlan' : 'br-lan';
      const start = h('button', { class: 'btn btn-inline', type: 'button' }, 'VLAN 사용 시작');
      start.addEventListener('click', async () => {
        const ok = await confirmDialog('VLAN 사용 시작', [
          `내부 포트 ${portLabel(port)}를 브리지(${newBr})로 묶고, 지금 내부 네트워크를 VLAN 1(태그 없음)로 옮깁니다.`,
          h('p', { class: 'msg warn-msg' }, `내부 네트워크가 잠깐 끊길 수 있습니다. ${VLAN_APPLY_TIMEOUT}초 안에 다시 연결되지 않으면 자동으로 되돌아갑니다.`),
        ], '시작');
        if (!ok) return;
        const r = await runApply([
          { op: 'add', config: 'network', type: 'device', values: { type: 'bridge', name: newBr, ports: [port] } },
          { op: 'add', config: 'network', type: 'bridge-vlan', values: { device: newBr, vlan: '1', ports: [`${port}:u*`] } },
          { op: 'set', config: 'network', section: 'lan', values: { device: `${newBr}.1` } },
        ], { timeout: VLAN_APPLY_TIMEOUT });
        if (r === 'applied' || r === 'rolledback') reload();
      });
      return h('section', { class: 'card form-card' }, head,
        h('p', null, `내부 네트워크가 포트 하나(${portLabel(port)})를 바로 쓰고 있습니다. VLAN을 쓰려면 브리지로 바꿔야 합니다.`),
        lanDev ? h('div', { class: 'actions' }, start) : null);
    }

    const ports = asList(bridge.ports);
    const vlans = ctx.net.filter((v) => v['.type'] === 'bridge-vlan' && v.device === brName).sort((a, b) => +a.vlan - +b.vlan);
    const portHead = (p) => h('th', null, portLabel(p), portLabel(p) !== p ? h('div', { class: 'muted' }, p) : null);

    if (!vlans.length) {
      const start = h('button', { class: 'btn btn-inline', type: 'button' }, 'VLAN 사용 시작');
      start.addEventListener('click', async () => {
        const ok = await confirmDialog('VLAN 사용 시작', [
          `지금 내부 네트워크를 VLAN 1로 옮기고(${ports.map(portLabel).join(', ')} 포트는 태그 없음), 그다음 VLAN을 추가할 수 있게 합니다.`,
          h('p', { class: 'msg warn-msg' }, `내부 네트워크가 잠깐 끊길 수 있습니다. ${VLAN_APPLY_TIMEOUT}초 안에 다시 연결되지 않으면 자동으로 되돌아갑니다.`),
        ], '시작');
        if (!ok) return;
        const r = await runApply([
          { op: 'add', config: 'network', type: 'bridge-vlan', values: { device: brName, vlan: '1', ports: ports.map((p) => `${p}:u*`) } },
          { op: 'set', config: 'network', section: 'lan', values: { device: `${brName}.1` } },
        ], { timeout: VLAN_APPLY_TIMEOUT });
        if (r === 'applied' || r === 'rolledback') reload();
      });
      return h('section', { class: 'card form-card' }, head,
        h('p', null, 'VLAN을 쓰면 하나의 공유기 안에서 네트워크를 여러 개로 나눌 수 있습니다. (예: IoT 기기, 손님용 유선 포트)'),
        h('p', { class: 'muted' }, `지금은 VLAN을 쓰지 않습니다. 내부 포트: ${ports.map(portLabel).join(', ') || '없음'}`),
        h('div', { class: 'actions' }, start));
    }

    const untaggedIn = {};
    for (const v of vlans) for (const p of asList(v.ports).map(parseVlanPort)) if (p.mode === 'u') untaggedIn[p.port] = v.vlan;

    const matrix = portMatrix(
      vlans.map((v) => ({ key: v['.name'], label: v.vlan,
        modes: Object.fromEntries(asList(v.ports).map(parseVlanPort).map((p) => [p.port, p.mode])) })),
      ports.map((p) => ({ id: p, label: portLabel(p) })));
    const rows = vlans.map((v) => {
      const dev = `${brName}.${v.vlan}`;
      const iface = ifaceUsingDev(ctx.ifaces, ctx.devs, dev);
      const protectedVlan = ifaceDev(lan) === dev;
      return h('tr', null,
        h('td', null, h('b', null, v.vlan)),
        ...matrix.cellsFor(v['.name']).map((s) => h('td', null, s)),
        netCell(ctx, iface),
        h('td', { class: 'actions-cell' }, protectedVlan ? null
          : h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteVlan(ctx, v['.name'], v.vlan, iface) }, '삭제')));
    });
    const matrixErr = h('p', { class: 'msg', hidden: true });
    const saveBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '포트 구성 적용');
    saveBtn.addEventListener('click', async () => {
      matrixErr.hidden = true;
      const res = matrix.collect();
      if (res.error) { matrixErr.textContent = res.error; matrixErr.hidden = false; return; }
      if (!res.changed.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ops = res.changed.map((c) => ({ op: 'set', config: 'network', section: c.key, values: {
        // 태그 없음 포트는 PVID(*)로 둔다: 그 포트로 들어오는 태그 없는 프레임이 이 VLAN으로 간다
        ports: ports.filter((p) => c.modes[p]).map((p) => (c.modes[p] === 'u' ? `${p}:u*` : `${p}:t`)),
      } }));
      const ok = await confirmDialog('포트 구성 적용', [
        '바뀐 포트에 연결된 기기는 잠시 끊기고, 다른 네트워크로 옮겨질 수 있습니다.',
        h('p', { class: 'msg warn-msg' }, `지금 접속에 쓰는 포트를 내부 네트워크에서 빼면 접속이 끊깁니다. ${VLAN_APPLY_TIMEOUT}초 안에 다시 연결되지 않으면 자동으로 되돌아갑니다.`),
      ], '적용');
      if (!ok) return;
      const r = await runApply(ops, { timeout: VLAN_APPLY_TIMEOUT });
      if (r === 'applied' || r === 'rolledback') reload();
    });

    const stopBtn = vlans.length === 1 && ifaceDev(lan) === `${brName}.${vlans[0].vlan}`
      ? h('button', { class: 'btn btn-ghost btn-inline', type: 'button' }, 'VLAN 사용 중지') : null;
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        if (!await confirmDialog('VLAN 사용 중지', '내부 네트워크를 원래의 브리지로 되돌리고 VLAN 설정을 지웁니다.', '중지')) return;
        const r = await runApply([
          { op: 'delete', config: 'network', section: vlans[0]['.name'] },
          { op: 'set', config: 'network', section: 'lan', values: { device: brName } },
        ], { timeout: VLAN_APPLY_TIMEOUT });
        if (r === 'applied' || r === 'rolledback') reload();
      });
    }

    // VLAN 추가
    const vid = h('input', { type: 'text', inputmode: 'numeric', placeholder: '예: 20' });
    const fVid = formField('VLAN ID (2~4094)', vid);
    const portSel = ports.map((p) => ({ p, sel: selectEl(PORT_MODES, '') }));
    const portErr = h('p', { class: 'msg', hidden: true });
    const nf = networkForm();
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
    addBtn.addEventListener('click', async () => {
      fVid.setError(null);
      nf.clear();
      portErr.hidden = true;
      let bad = false;
      const id = vid.value.trim();
      if (!vlanIdOk(id, 2)) { fVid.setError('2~4094 사이의 숫자를 입력해 주세요.'); bad = true; }
      else if (vlans.some((v) => v.vlan === id)) { fVid.setError('이미 있는 VLAN입니다.'); bad = true; }
      const chosen = portSel.filter((x) => x.sel.value);
      const clash = chosen.find((x) => x.sel.value === 'u' && untaggedIn[x.p]);
      if (clash) {
        portErr.textContent = `${portLabel(clash.p)} 포트는 이미 VLAN ${untaggedIn[clash.p]}의 태그 없음 포트입니다. 태그 없음은 포트마다 하나의 VLAN만 가능합니다. 위 표에서 먼저 그 VLAN에서 빼 주세요.`;
        portErr.hidden = false;
        bad = true;
      }
      const netOps = nf.ops(ctx, `${brName}.${id}`);
      if (bad || netOps === null) return;
      addBtn.disabled = true;
      const r = await runApply([
        { op: 'add', config: 'network', type: 'bridge-vlan', values: { device: brName, vlan: id, ports: chosen.map((x) => (x.sel.value === 'u' ? `${x.p}:u*` : `${x.p}:t`)) } },
        ...netOps,
      ], { timeout: VLAN_APPLY_TIMEOUT });
      addBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });

    return h('div', null, // 간격은 app.css의 '.card + div > .card:first-child'
      h('section', { class: 'card' }, head,
        h('p', { class: 'muted' }, '태그 없음(U): 그 포트에 꽂은 일반 기기가 이 VLAN에 들어갑니다 (포트마다 하나만). 태그(T): VLAN을 아는 스위치/AP로 여러 VLAN을 한 선으로 보낼 때.'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'VLAN'), ...ports.map(portHead), h('th', null, '네트워크'), h('th', null, ''))),
          h('tbody', null, rows))),
        matrixErr,
        h('div', { class: 'actions' }, stopBtn, saveBtn)),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, 'VLAN 추가')),
        h('div', { class: 'fieldset' }, fVid.el, ...portSel.map((x) => formField(`${portLabel(x.p)} 포트`, x.sel).el)),
        portErr, nf.el,
        h('div', { class: 'actions' }, addBtn)));
  }

  /* ----- swconfig: switch_vlan ----- */

  function swconfigCard(ctx, lan) {
    const sw = ctx.sw;
    const head = h('div', { class: 'card-head' }, h('h3', null, `내부 VLAN (스위치 ${sw.name})`));
    if (!sw.cpus.length) {
      return h('section', { class: 'card' }, head, h('p', { class: 'muted' }, '스위치의 CPU 포트를 알아낼 수 없어 VLAN을 편집할 수 없습니다.'));
    }
    const wan = ctx.ifaces.find((s) => s['.name'] === 'wan');
    const wan6 = ctx.ifaces.find((s) => s['.name'] === 'wan6');
    const users = sw.users;
    const untaggedIn = {};
    for (const v of sw.vlans) for (const p of parseSwPorts(v.ports)) if (p.mode === 'u') untaggedIn[p.num] = sw.vid(v);

    const matrix = portMatrix(
      sw.vlans.map((v) => ({ key: v['.name'], label: sw.vid(v),
        modes: Object.fromEntries(parseSwPorts(v.ports).map((p) => [String(p.num), p.mode])) })),
      users.map((u) => ({ id: String(u.num), label: sw.label(u) })));
    const rows = sw.vlans.map((v) => {
      const dev = sw.devOf(v);
      const iface = ifaceUsingDev(ctx.ifaces, ctx.devs, dev);
      const isSystem = [lan, wan, wan6].some((i) => i && iface && i['.name'] === iface['.name']);
      return h('tr', null,
        h('td', null, h('b', null, sw.vid(v))),
        ...matrix.cellsFor(v['.name']).map((s) => h('td', null, s)),
        netCell(ctx, iface),
        h('td', { class: 'actions-cell' }, isSystem ? null
          : h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteVlan(ctx, v['.name'], sw.vid(v), iface) }, '삭제')));
    });
    const matrixErr = h('p', { class: 'msg', hidden: true });
    const saveBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '포트 구성 적용');
    saveBtn.addEventListener('click', async () => {
      matrixErr.hidden = true;
      const res = matrix.collect();
      if (res.error) { matrixErr.textContent = res.error; matrixErr.hidden = false; return; }
      if (!res.changed.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      const ops = res.changed.map((c) => {
        const v = sw.vlans.find((x) => x['.name'] === c.key);
        // CPU 포트 항목은 원래대로 둔다
        const cpuPart = parseSwPorts(v.ports).filter((p) => sw.cpus.some((cp) => cp.num === p.num)).map((p) => `${p.num}t`);
        const userPart = users.filter((u) => c.modes[String(u.num)]).map((u) => `${u.num}${c.modes[String(u.num)] === 't' ? 't' : ''}`);
        return { op: 'set', config: 'network', section: c.key, values: { ports: [...userPart, ...cpuPart].join(' ') } };
      });
      const ok = await confirmDialog('포트 구성 적용', [
        '바뀐 포트에 연결된 기기는 잠시 끊기고, 다른 네트워크로 옮겨질 수 있습니다.',
        h('p', { class: 'msg warn-msg' }, `지금 접속에 쓰는 포트를 내부 네트워크에서 빼면 접속이 끊깁니다. ${VLAN_APPLY_TIMEOUT}초 안에 다시 연결되지 않으면 자동으로 되돌아갑니다.`),
      ], '적용');
      if (!ok) return;
      const r = await runApply(ops, { timeout: VLAN_APPLY_TIMEOUT });
      if (r === 'applied' || r === 'rolledback') reload();
    });

    const vid = h('input', { type: 'text', inputmode: 'numeric', placeholder: '예: 20' });
    const fVid = formField('VLAN ID (3~4094)', vid);
    const portSel = users.map((u) => ({ u, sel: selectEl(PORT_MODES, '') }));
    const portErr = h('p', { class: 'msg', hidden: true });
    const nf = networkForm();
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
    addBtn.addEventListener('click', async () => {
      fVid.setError(null);
      nf.clear();
      portErr.hidden = true;
      let bad = false;
      const id = vid.value.trim();
      if (!vlanIdOk(id, 3)) { fVid.setError('3~4094 사이의 숫자를 입력해 주세요.'); bad = true; }
      else if (sw.vlans.some((v) => sw.vid(v) === id)) { fVid.setError('이미 있는 VLAN입니다.'); bad = true; }
      const chosen = portSel.filter((x) => x.sel.value);
      const clash = chosen.find((x) => x.sel.value === 'u' && untaggedIn[x.u.num]);
      if (clash) {
        portErr.textContent = `${sw.label(clash.u)}는 이미 VLAN ${untaggedIn[clash.u.num]}의 태그 없음 포트입니다. 태그 없음은 포트마다 하나의 VLAN만 가능합니다.`;
        portErr.hidden = false;
        bad = true;
      }
      // 내부 네트워크가 쓰는 CPU 포트로 새 VLAN을 올린다
      const lanVlan = sw.vlans.find((v) => ifaceUsingDev(ctx.ifaces, ctx.devs, sw.devOf(v)) === lan);
      const cpu = (lanVlan && sw.cpus.find((c) => parseSwPorts(lanVlan.ports).some((p) => p.num === c.num))) || sw.cpus[0];
      const netOps = nf.ops(ctx, `${cpu.device}.${id}`);
      if (bad || netOps === null) return;
      // 'vlan'은 스위치 안의 순번(칩마다 최대 개수가 달라 작은 수를 쓴다), 실제 번호는 'vid'
      const used = sw.vlans.map((v) => +v.vlan);
      let index = 1;
      while (used.includes(index)) index += 1;
      const ports = [...chosen.map((x) => `${x.u.num}${x.sel.value === 't' ? 't' : ''}`), `${cpu.num}t`].join(' ');
      addBtn.disabled = true;
      const r = await runApply([
        { op: 'add', config: 'network', type: 'switch_vlan', values: { device: sw.name, vlan: String(index), vid: id, ports } },
        ...netOps,
      ], { timeout: VLAN_APPLY_TIMEOUT });
      addBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });

    return h('div', null,
      h('section', { class: 'card' }, head,
        h('p', { class: 'muted' }, '이 공유기는 스위치 칩 방식(swconfig)입니다. CPU 포트는 모든 VLAN에 태그로 자동 포함됩니다. 태그 없음(U)은 포트마다 하나의 VLAN만 가능합니다.'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'VLAN'), ...users.map((u) => h('th', null, sw.label(u))), h('th', null, '네트워크'), h('th', null, ''))),
          h('tbody', null, rows))),
        matrixErr,
        h('div', { class: 'actions' }, saveBtn)),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, 'VLAN 추가')),
        h('div', { class: 'fieldset' }, fVid.el, ...portSel.map((x) => formField(sw.label(x.u), x.sel).el)),
        portErr, nf.el,
        h('p', { class: 'muted' }, '스위치 칩에 따라 큰 VLAN 번호(16 이상)를 쓰려면 스위치 설정에서 4K VLAN 지원이 켜져 있어야 할 수 있습니다.'),
        h('div', { class: 'actions' }, addBtn)));
  }

  load();
  return () => { alive = false; };
}

/* ---------- VLAN 설정과 게스트/VLAN 네트워크 메뉴가 같이 쓰는 함수 ---------- */
// ctx: { net, fw, dhcp, wl, board, ifaces, devs, sw } — makeNetCtx()로 만든다.

const SYSTEM_NETS = ['lan', 'wan', 'wan6', 'loopback'];

async function makeNetCtx() {
  const [net, fw, dhcp, wl, board] = await Promise.all([
    uciSections('network'), uciSections('firewall'), uciSections('dhcp'), uciSections('wireless'), readBoard()]);
  const ctx = { net: net || [], fw: fw || [], dhcp: dhcp || [], wl: wl || [], board };
  ctx.ifaces = ctx.net.filter((s) => s['.type'] === 'interface');
  ctx.devs = ctx.net.filter((s) => s['.type'] === 'device');
  ctx.sw = switchInfo(ctx.net, board);
  return ctx;
}

/* ---------- 접속 허용 (VLAN 설정의 별도 네트워크, 게스트 네트워크가 같이 쓴다) ---------- */
// 정책: wan(이 네트워크 -> 인터넷), lanTo(내부 -> 이 네트워크), toLan(이 네트워크 -> 내부), input(공유기 관리 화면), isolate(무선 격리)
// 방화벽 이름은 'wrtTIME <prefix> 인터넷/내부 접근/내부로/DNS/DHCP' (VLAN 설정: prefix = 'VLAN <이름>', 게스트: 'guest')

const NET_POLICY_ITEMS = [
  ['wan', '인터넷 사용 허용'],
  ['lanTo', '내부 네트워크에서 이 네트워크로 접속 허용 (예: 휴대폰 앱으로 기기 제어)'],
  ['toLan', '이 네트워크에서 내부 네트워크로 접속 허용'],
  ['input', '이 네트워크에서 공유기 관리 화면 접속 허용'],
];
const POLICY_DEFAULT = { wan: true, lanTo: false, toLan: false, input: false, isolate: false };

// 네트워크 n이 속한 방화벽 zone (zone 이름이 네트워크 이름과 다를 수 있다)
function zoneOf(ctx, n) {
  return ctx.fw.find((s) => s['.type'] === 'zone' && asList(s.network).includes(n))
    || ctx.fw.find((s) => s['.type'] === 'zone' && s.name === n) || null;
}

// 지금 정책 읽기 (zone 이름 기준). wifis: 이 네트워크의 무선(격리 여부), fallback: zone이 없을 때
function readPolicy(ctx, n, wifis, fallback) {
  const zone = zoneOf(ctx, n);
  const z = zone ? zone.name : n;
  const lanZ = (zoneOf(ctx, 'lan') || { name: 'lan' }).name;
  const wanZ = (zoneOf(ctx, 'wan') || { name: 'wan' }).name;
  const fwd = (src, dest) => ctx.fw.find((s) => s['.type'] === 'forwarding' && s.src === src && s.dest === dest) || null;
  const fwds = { wan: fwd(z, wanZ), lanTo: fwd(lanZ, z), toLan: fwd(z, lanZ) };
  const policy = zone ? {
    wan: !!fwds.wan, lanTo: !!fwds.lanTo, toLan: !!fwds.toLan, input: zone.input === 'ACCEPT',
    isolate: wifis.length ? wifis.every((w) => w.isolate === '1') : fallback.isolate,
  } : { ...fallback };
  return { zone, z, lanZ, wanZ, fwds, policy };
}

// 정책 변경: zone input, 포워딩. zone이 없으면 zone과 DNS/DHCP 허용 규칙부터 만든다.
function policyOps(n, st, policy, prefix) {
  const fwName = (what) => `wrtTIME ${prefix} ${what}`;
  const ops = [];
  const spec = {
    wan: [st.z, st.wanZ, fwName('인터넷')],
    lanTo: [st.lanZ, st.z, fwName('내부 접근')],
    toLan: [st.z, st.lanZ, fwName('내부로')],
  };
  if (!st.zone) {
    ops.push({ op: 'add', config: 'firewall', type: 'zone',
      values: { name: n, network: [n], input: policy.input ? 'ACCEPT' : 'REJECT', output: 'ACCEPT', forward: 'REJECT' } });
    // 관리 화면을 막아도 주소 받기(DHCP)와 이름 찾기(DNS)는 되게 한다
    ops.push({ op: 'add', config: 'firewall', type: 'rule', values: { name: fwName('DNS'), src: n, dest_port: '53', proto: ['tcp', 'udp'], target: 'ACCEPT' } });
    ops.push({ op: 'add', config: 'firewall', type: 'rule', values: { name: fwName('DHCP'), src: n, dest_port: '67', proto: 'udp', family: 'ipv4', target: 'ACCEPT' } });
  } else if (policy.input !== (st.zone.input === 'ACCEPT')) {
    ops.push({ op: 'set', config: 'firewall', section: st.zone['.name'], values: { input: policy.input ? 'ACCEPT' : 'REJECT' } });
  }
  for (const [id, [src, dest, name]] of Object.entries(spec)) {
    if (policy[id] && !st.fwds[id]) ops.push({ op: 'add', config: 'firewall', type: 'forwarding', values: { name, src, dest } });
    if (!policy[id] && st.fwds[id]) ops.push({ op: 'delete', config: 'firewall', section: st.fwds[id]['.name'] });
  }
  return ops;
}

// '인터넷, 내부→' 같은 짧은 요약
function policySummary(p) {
  const parts = [];
  if (p.wan) parts.push('인터넷');
  if (p.lanTo) parts.push('내부 → 이 네트워크');
  if (p.toLan) parts.push('이 네트워크 → 내부');
  if (p.input) parts.push('관리 화면');
  return parts.length ? parts.join(', ') : '모두 막힘';
}

// 접속 허용 체크 묶음. { el, value() }
function policyChecks(policy) {
  const items = NET_POLICY_ITEMS.map(([id, label]) => ({ id, t: toggleEl(policy[id], label) }));
  return {
    el: h('div', { class: 'field' }, h('span', null, '접속 허용'), ...items.map((x) => x.t.el)),
    value: () => ({ ...policy, ...Object.fromEntries(items.map((x) => [x.id, x.t.input.checked])) }),
  };
}

// 네트워크 n과 거기에 딸린 것(주소, DHCP, 방화벽, 무선, 우리가 만든 브리지 br-<n>)을 지운다.
// VLAN을 지울 때(vlanSection)와 게스트 네트워크를 끌 때 쓴다.
function vlanNetworkDeleteOps(ctx, n, vlanSection) {
  const ops = [];
  const add = (config, section) => { if (!ops.some((o) => o.config === config && o.section === section)) ops.push({ op: 'delete', config, section }); };
  if (vlanSection) add('network', vlanSection);
  const iface = ctx.ifaces.find((i) => i['.name'] === n);
  if (!iface) return ops;
  add('network', n);
  const br = ctx.devs.find((d) => d.type === 'bridge' && d.name === `br-${n}`);
  if (br) add('network', br['.name']);
  for (const w of ctx.wl.filter((s) => s['.type'] === 'wifi-iface' && asList(s.network).includes(n))) add('wireless', w['.name']);
  for (const d of ctx.dhcp.filter((s) => s['.type'] === 'dhcp' && s.interface === n)) add('dhcp', d['.name']);
  for (const s of ctx.fw) {
    const mine = (s['.type'] === 'zone' && s.name === n)
      || (s['.type'] === 'forwarding' && (s.src === n || s.dest === n))
      || (s['.type'] === 'rule' && s.src === n && /^(wrtTIME|NMMWrt) /.test(String(s.name || '')));  // 이름을 바꾸기 전(NMMWrt) 규칙도 포함
    if (mine) add('firewall', s['.name']);
  }
  return ops;
}

/* ---------- VLAN 설정 화면의 무선 상태 표시 ---------- */

// 네트워크 n에 붙은 무선 중 실제로 켜진 것 (무선 네트워크와 무선 장치가 모두 켜져 있어야 한다)
function netWifiState(ctx, n) {
  const radioOf = (w) => ctx.wl.find((s) => s['.type'] === 'wifi-device' && s['.name'] === w.device);
  const wifis = ctx.wl.filter((s) => s['.type'] === 'wifi-iface' && asList(s.network).includes(n));
  const on = wifis.filter((w) => w.disabled !== '1' && radioOf(w) && radioOf(w).disabled !== '1');
  return {
    wifis,
    on,
    ssids: [...new Set(on.map((w) => w.ssid).filter(Boolean))],
    bands: [...new Set(on.map((w) => BAND_LABEL[radioBand(radioOf(w))] || w.device))],
  };
}

// VLAN 표의 네트워크 칸: 이 VLAN 네트워크에 붙은 무선 상태. 내부 네트워크처럼 시스템 네트워크는 표시하지 않는다.
function netWifiLine(ctx, iface) {
  if (!iface || SYSTEM_NETS.includes(iface['.name'])) return null;
  const st = netWifiState(ctx, iface['.name']);
  if (!st.wifis.length) return null;
  return h('div', { style: 'margin-top:4px' },
    h('span', { class: 'pill ' + (st.on.length ? 'ok' : 'off') }, st.on.length ? '무선 활성화' : '무선 꺼짐'),
    st.on.length ? h('span', { class: 'muted', style: 'margin-left:6px' }, `${st.ssids.join(', ')} · ${st.bands.join(', ')}`) : null);
}

// 게스트 네트워크는 VLAN 없이 무선으로만 동작하므로 VLAN 표와 따로 상태를 보여 준다. 무선 장치가 없는 공유기는 표시하지 않는다.
function guestStatusCards(ctx) {
  const iface = ctx.ifaces.find((i) => i['.name'] === 'guest');
  if (!iface && !ctx.wl.some((s) => s['.type'] === 'wifi-device')) return [];
  const st = netWifiState(ctx, 'guest');
  const active = !!iface && st.on.length > 0;
  const addr = iface ? readAddr(iface).ip : '';
  const text = active ? `무선 이름 ${st.ssids.join(', ') || '-'} · ${st.bands.join(', ')}${addr ? ` · 공유기 주소 ${addr}` : ''}`
    : iface ? '게스트 네트워크는 만들어져 있지만 켜진 무선이 없습니다.'
      : '게스트 네트워크를 사용하지 않습니다.';
  return [h('section', { class: 'card form-card' },
    h('div', { class: 'card-head' }, h('h3', null, '무선 게스트 네트워크'),
      h('span', { class: 'pill ' + (active ? 'ok' : iface ? 'warn' : 'off') }, active ? '활성화' : iface ? '무선 꺼짐' : '비활성화')),
    h('p', null, text),
    h('p', { class: 'muted' }, 'VLAN을 쓰지 않는 무선 전용 네트워크입니다. ', h('a', { href: '#/guest' }, '게스트 / VLAN 네트워크에서 설정')))];
}

PAGES['/vlan'] = vlanPage;
