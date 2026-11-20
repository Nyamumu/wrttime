// NAT 규칙 (NAT/라우터 관리): LuCI의 Firewall > NAT Rules를 wrtTIME 방식으로 다시 만든 것. firewall의 nat 섹션 (fw4).
//   나가는 영역(src)으로 나가는 패킷의 출발 주소를 바꾼다: MASQUERADE(그 인터페이스 주소로), SNAT(정한 주소로), ACCEPT(바꾸지 않음).
//   이 화면이 다루지 않는 옵션(extra, mark 등)은 그대로 둔다. ruleList/okIp/ruleProtos는 fwrules.js의 것을 쓴다.

const NAT_TARGETS = [['MASQUERADE', '마스커레이드 (나가는 인터페이스 주소로)'], ['SNAT', 'SNAT (정한 주소로)'], ['ACCEPT', '주소 바꾸지 않음']];
const NAT_TARGET_TEXT = { MASQUERADE: '마스커레이드', SNAT: 'SNAT', ACCEPT: '바꾸지 않음' };
const NAT_FAMILY = [['', 'IPv4 + IPv6'], ['ipv4', 'IPv4'], ['ipv6', 'IPv6']];

const natProtos = (r) => (asList(r.proto).length ? asList(r.proto).map((p) => p.toLowerCase()) : ['all']);

function natMatch(r) {
  const fam = { ipv4: 'IPv4', ipv6: 'IPv6' }[String(r.family || '').toLowerCase()] || 'IPv4·IPv6';
  const protos = natProtos(r);
  const protoTxt = protos.includes('all') ? '모든 프로토콜' : protos.map((p) => p.toUpperCase()).join(', ');
  const extra = (parts) => parts.filter(([, v]) => v).map(([k, v]) => ` · ${k} ${v}`).join('');
  return h('div', { class: 'rule-match' },
    h('div', null, `${fam} · ${protoTxt}`),
    h('div', null, '나가는 영역 ', r.src ? (r.src === '*' ? h('span', { class: 'ms-chip' }, '모든 영역') : zonePill(r.src)) : h('span', { class: 'ms-chip' }, '없음'),
      extra([['장치', r.device]])),
    (r.src_ip || r.src_port) ? h('div', null, `출발${extra([['IP', ruleList(r.src_ip)], ['포트', ruleList(r.src_port)]]).replace(/^ ·/, '')}`) : null,
    (r.dest_ip || r.dest_port) ? h('div', null, `도착${extra([['IP', ruleList(r.dest_ip)], ['포트', ruleList(r.dest_port)]]).replace(/^ ·/, '')}`) : null);
}

function natRulesPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('NAT 규칙'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let fw;
    try {
      fw = await uciSections('firewall');
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!fw) { body.replaceChildren(messageCard('방화벽 설정(firewall)을 찾을 수 없습니다.')); return; }
    render({ rules: fw.filter((s) => s['.type'] === 'nat'), zones: fw.filter((s) => s['.type'] === 'zone' && s.name).map((s) => s.name) });
  }

  async function apply(ops) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    const r = await runApply(ops);
    if (r === 'applied' || r === 'rolledback') reload();
  }

  function render(ctx) {
    const rows = ctx.rules.map((r) => {
      const on = r.enabled !== '0';
      const t = String(r.target || 'MASQUERADE').toUpperCase();
      const snat = t === 'SNAT' ? `→ ${r.snat_ip || '?'}${r.snat_port ? `:${r.snat_port}` : ''}` : '';
      return h('tr', { class: on ? '' : 'row-off' },
        h('td', null, h('b', null, r.name || '(이름 없음)')),
        h('td', null, natMatch(r)),
        h('td', null, h('span', { class: 'pill ' + (t === 'ACCEPT' ? 'off' : 'ok') }, NAT_TARGET_TEXT[t] || t), snat ? h('div', { class: 'muted' }, snat) : null),
        h('td', null, h('span', { class: 'pill ' + (on ? 'ok' : 'off') }, on ? '사용' : '꺼짐')),
        h('td', { class: 'actions-cell' },
          enabledButton([r['.name']], on, reload),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editNat(ctx, r, false) }, '수정'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editNat(ctx, r, true) }, '복제'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteNat(r) }, '삭제')));
    });
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => editNat(ctx, null, false) }, 'NAT 규칙 추가');
    body.replaceChildren(h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'card-head' }, h('h3', null, 'NAT 규칙')),
      h('p', { class: 'muted' }, '특정 영역으로 나가는 패킷의 출발 주소를 바꾸는 규칙입니다 (예: VPN으로 나가는 연결만 마스커레이드). 보통의 인터넷 공유는 방화벽 설정의 영역 "마스커레이드"로 충분합니다.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['이름', '조건', '동작', '상태', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'NAT 규칙이 없습니다.'))))),
      h('div', { class: 'actions' }, addBtn)));
  }

  async function deleteNat(r) {
    if (!await confirmDialog('NAT 규칙 삭제', `'${r.name || '(이름 없음)'}' 규칙을 삭제합니다.`, '삭제', true)) return;
    apply([{ op: 'delete', config: 'firewall', section: r['.name'] }]);
  }

  function editNat(ctx, r, copy) {
    const isNew = !r || copy;
    const cur = r || { src: ctx.zones.includes('wan') ? 'wan' : '', target: 'MASQUERADE', family: 'ipv4' };
    const text = (v, ph) => h('input', { type: 'text', value: v || '', spellcheck: 'false', placeholder: ph || '' });
    const name = text(copy ? `${cur.name || 'NAT'} (복사)` : cur.name, '예: VPN-NAT');
    const family = selectEl(NAT_FAMILY, String(cur.family || '').toLowerCase().replace(/^any$/, ''));
    const curProtos = natProtos(cur);
    const protoOpts = [...RULE_PROTOS, ...curProtos.filter((p) => !RULE_PROTOS.some(([v]) => v === p)).map((p) => [p, p.toUpperCase()])];
    const proto = multiSelect('프로토콜', protoOpts, curProtos,
      { chip: (v) => h('span', { class: 'ms-chip' }, (protoOpts.find(([k]) => k === v) || [v, v])[1]), empty: '모든 프로토콜 (기본)' });
    const src = selectEl([['', '-'], ['*', '모든 영역'], ...ctx.zones.map((z) => [z, z])], cur.src || '');
    const device = text(cur.device, '비우면 그 영역의 모든 장치');
    const srcIp = text(ruleList(cur.src_ip), '비우면 모두');
    const srcPort = text(ruleList(cur.src_port), '비우면 모두');
    const destIp = text(ruleList(cur.dest_ip), '비우면 모두');
    const destPort = text(ruleList(cur.dest_port), '비우면 모두');
    const target = selectEl(NAT_TARGETS, String(cur.target || 'MASQUERADE').toUpperCase());
    const snatIp = text(cur.snat_ip, '예: 203.0.113.10');
    const snatPort = text(cur.snat_port, '비우면 그대로');
    const enabled = toggleEl(cur.enabled !== '0', '이 규칙 사용');
    const f = {
      name: formField('이름', name),
      family: formField('주소 종류', family),
      src: formField('나가는 영역', src, '이 영역으로 나가는 패킷에 적용'),
      device: formField('나가는 장치', device),
      srcIp: formField('출발 IP', srcIp, '여러 개는 띄어 쓰기'),
      srcPort: formField('출발 포트', srcPort),
      destIp: formField('도착 IP', destIp),
      destPort: formField('도착 포트', destPort),
      target: formField('동작', target),
      snatIp: formField('바꿀 주소 (SNAT)', snatIp),
      snatPort: formField('바꿀 포트 (SNAT)', snatPort),
    };
    const snatBox = h('div', { class: 'fieldset' }, f.snatIp.el, f.snatPort.el);
    const sync = () => { snatBox.hidden = target.value !== 'SNAT'; };
    target.addEventListener('change', sync);
    sync();

    const tokens = (s) => s.trim().split(/\s+/).filter(Boolean);
    const okPort = (t) => {
      const m = /^(\d{1,5})(?:[-:](\d{1,5}))?$/.exec(t);
      return !!m && +m[1] <= 65535 && (!m[2] || (+m[2] <= 65535 && +m[2] >= +m[1]));
    };
    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', () => {
      Object.values(f).forEach((x) => x.setError(null));
      proto.setError(null);
      let bad = false;
      const protos = proto.values();
      const portProto = protos.some((p) => p === 'tcp' || p === 'udp');
      if (!src.value) { f.src.setError('나가는 영역을 고르세요'); bad = true; }
      for (const [field, input] of [[f.srcPort, srcPort], [f.destPort, destPort], [f.snatPort, snatPort]]) {
        if (field === f.snatPort && target.value !== 'SNAT') continue;
        const ts = tokens(input.value);
        if (ts.some((t) => !okPort(t))) { field.setError('1~65535 숫자 또는 범위(8000-8100)'); bad = true; }
        else if (ts.length && !portProto) { field.setError('포트는 프로토콜에 TCP/UDP를 고를 때만 쓸 수 있습니다'); bad = true; }
      }
      for (const [field, input] of [[f.srcIp, srcIp], [f.destIp, destIp]]) {
        if (tokens(input.value).some((t) => !okIp(t))) { field.setError('IP 주소 형식이 올바르지 않습니다'); bad = true; }
      }
      if (target.value === 'SNAT' && !okIp(snatIp.value.trim())) { f.snatIp.setError('SNAT에는 바꿀 주소가 필요합니다'); bad = true; }
      if (device.value.trim() && !/^[A-Za-z0-9_.@-]{1,15}$/.test(device.value.trim())) { f.device.setError('장치 이름 형식이 올바르지 않습니다'); bad = true; }
      if (protos.includes('all') && protos.length > 1) { proto.setError('"모든 프로토콜"은 다른 것과 함께 고를 수 없습니다'); bad = true; }
      if (bad) return;

      const listVal = (s) => { const ts = tokens(s); return ts.length > 1 ? ts : (ts[0] || ''); };
      const snat = target.value === 'SNAT';
      const want = {
        name: name.value.trim(),
        family: family.value,
        proto: protos.length > 1 ? protos : (protos[0] || ''),
        src: src.value, device: device.value.trim(),
        src_ip: listVal(srcIp.value), src_port: listVal(srcPort.value),
        dest_ip: listVal(destIp.value), dest_port: listVal(destPort.value),
        target: target.value,
        snat_ip: snat ? snatIp.value.trim() : '', snat_port: snat ? snatPort.value.trim() : '',
        enabled: enabled.input.checked ? '' : '0',
      };
      const ops = [];
      if (isNew) {
        const base = copy ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('.'))) : {};
        const values = Object.fromEntries(Object.entries({ ...base, ...want })
          .filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length)));
        ops.push({ op: 'add', config: 'firewall', type: 'nat', values });
      } else {
        const changed = {};
        for (const [k, v] of Object.entries(want)) {
          const old = k === 'enabled' ? (r.enabled === '0' ? '0' : '') : k === 'target' ? String(r.target || '').toUpperCase() : ruleList(r[k]);
          const nv = Array.isArray(v) ? v.join(' ') : v;
          // proto가 없던 규칙은 모든 프로토콜과 같다
          if (k === 'proto' && !asList(r.proto).length && (!nv || nv === 'all')) continue;
          if (k === 'family' && !nv && /^any$/i.test(r.family || '')) continue;
          if (nv !== old) changed[k] = v;
        }
        if (Object.keys(changed).length) ops.push({ op: 'set', config: 'firewall', section: r['.name'], values: changed });
      }
      closeModal();
      apply(ops);
    });

    showModal(h('h3', null, !r ? 'NAT 규칙 추가' : copy ? 'NAT 규칙 복제' : 'NAT 규칙 수정'),
      f.name.el,
      h('div', { class: 'fieldset' }, f.family.el, f.target.el),
      snatBox,
      proto.el,
      h('div', { class: 'fieldset' }, f.src.el, f.device.el),
      h('div', { class: 'fieldset' }, f.srcIp.el, f.srcPort.el),
      h('div', { class: 'fieldset' }, f.destIp.el, f.destPort.el),
      enabled.el,
      h('div', { class: 'actions' }, cancel, save));
  }

  load();
  return () => { alive = false; };
}

PAGES['/fw-nat'] = natRulesPage;
