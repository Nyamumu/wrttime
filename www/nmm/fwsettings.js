// 방화벽 설정 (NAT/라우터 관리): LuCI의 Firewall > General Settings를 wrtTIME 방식으로 다시 만든 것.
//   기본 정책: firewall의 defaults 섹션 (SYN-flood 방어, 잘못된 패킷 버리기, input/output/forward)
//   오프로딩: defaults의 flow_offloading(소프트웨어), flow_offloading_hw(하드웨어)
//   영역(zone): 정책/마스커레이드/MSS 클램핑/포함 네트워크 + 영역 간 전달(forwarding 섹션)
// 포트포워드와 접속 차단은 각자의 메뉴(firewall.js)에 있다.

const FW_POLICIES = [['ACCEPT', '허용'], ['REJECT', '거부 (응답함)'], ['DROP', '버림 (응답 없음)']];
const FW_POLICY_TEXT = { ACCEPT: '허용', REJECT: '거부', DROP: '버림' };
const FW_ZONE_RE = /^[A-Za-z0-9_]{1,11}$/;

const fwPolicy = (v, dflt) => String(v || dflt || 'REJECT').toUpperCase();

function zoneClass(name) {
  if (name === 'lan') return 'zone-lan';
  if (name === 'wan') return 'zone-wan';
  return 'zone-other';
}

function zonePill(name) {
  return h('span', { class: 'zone-pill ' + zoneClass(name) }, name);
}

function firewallSettingsPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('방화벽 설정'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let fw, net;
    try {
      [fw, net] = await Promise.all([uciSections('firewall'), uciSections('network')]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!fw) { body.replaceChildren(messageCard('방화벽 설정(firewall)을 찾을 수 없습니다.')); return; }
    const ctx = {
      fw,
      defaults: fw.find((s) => s['.type'] === 'defaults') || null,
      zones: fw.filter((s) => s['.type'] === 'zone' && s.name),
      fwds: fw.filter((s) => s['.type'] === 'forwarding'),
      ifaces: (net || []).filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback').map((s) => s['.name']),
    };
    body.replaceChildren(defaultsCard(ctx), offloadCard(ctx), zonesCard(ctx));
  }

  // defaults 섹션에 값을 넣는 변경 (섹션이 없으면 만든다)
  function defaultsOps(ctx, values) {
    if (ctx.defaults) return [{ op: 'set', config: 'firewall', section: ctx.defaults['.name'], values }];
    return [{ op: 'add', config: 'firewall', type: 'defaults', values: dropEmpty(values) }];
  }

  async function apply(ops, btn) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    if (btn) btn.disabled = true;
    const r = await runApply(ops);
    if (btn) btn.disabled = false;
    if (r === 'applied' || r === 'rolledback') reload();
  }

  /* ---------- 기본 정책 ---------- */

  function defaultsCard(ctx) {
    const d = ctx.defaults || {};
    // 25.12(fw4)는 synflood_protect, 예전 설정은 syn_flood
    const synCur = (d.synflood_protect || d.syn_flood) === '1';
    const syn = toggleEl(synCur, 'SYN-flood 공격 막기');
    const inval = toggleEl(d.drop_invalid === '1', '잘못된 패킷 버리기');
    const sel = {
      input: selectEl(FW_POLICIES, fwPolicy(d.input)),
      output: selectEl(FW_POLICIES, fwPolicy(d.output, 'ACCEPT')),
      forward: selectEl(FW_POLICIES, fwPolicy(d.forward)),
    };
    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    btn.addEventListener('click', () => {
      const v = {};
      if (syn.input.checked !== synCur) {
        v.synflood_protect = syn.input.checked ? '1' : '';
        if (d.syn_flood) v.syn_flood = '';
      }
      if (inval.input.checked !== (d.drop_invalid === '1')) v.drop_invalid = inval.input.checked ? '1' : '';
      if (sel.input.value !== fwPolicy(d.input)) v.input = sel.input.value;
      if (sel.output.value !== fwPolicy(d.output, 'ACCEPT')) v.output = sel.output.value;
      if (sel.forward.value !== fwPolicy(d.forward)) v.forward = sel.forward.value;
      apply(Object.keys(v).length ? defaultsOps(ctx, v) : [], btn);
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '기본 정책')),
      h('p', { class: 'muted' }, '영역(zone)에 따로 정하지 않은 경우에 쓰는 기본 동작입니다.'),
      syn.el, inval.el,
      h('div', { class: 'fieldset' },
        formField('들어오는 연결 (Input)', sel.input, '공유기 자신으로 들어오는 연결').el,
        formField('나가는 연결 (Output)', sel.output, '공유기 자신이 내보내는 연결').el,
        formField('전달 (Forward)', sel.forward, '공유기를 거쳐 다른 네트워크로 가는 연결').el),
      h('div', { class: 'actions' }, btn));
  }

  /* ---------- 오프로딩 ---------- */

  function offloadCard(ctx) {
    const d = ctx.defaults || {};
    const cur = d.flow_offloading === '1' ? (d.flow_offloading_hw === '1' ? 'hw' : 'sw') : '';
    const sel = selectEl([['', '사용 안 함'], ['sw', '소프트웨어 오프로딩'], ['hw', '하드웨어 오프로딩']], cur);
    const btn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    btn.addEventListener('click', () => {
      if (sel.value === cur) { apply([], btn); return; }
      apply(defaultsOps(ctx, { flow_offloading: sel.value ? '1' : '', flow_offloading_hw: sel.value === 'hw' ? '1' : '' }), btn);
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '라우팅/NAT 오프로딩')),
      h('p', { class: 'muted' }, '이미 연결된 흐름을 빠른 경로로 넘겨 인터넷 속도를 높이고 CPU 사용을 줄입니다. 속도 관리(SQM)와는 함께 쓰기 어렵습니다. 하드웨어 오프로딩은 지원하는 공유기에서만 동작합니다.'),
      h('div', { class: 'fieldset' }, formField('오프로딩 방식', sel).el),
      h('div', { class: 'actions' }, btn));
  }

  /* ---------- 영역 ---------- */

  function zonesCard(ctx) {
    const rows = ctx.zones.map((z) => {
      const dests = ctx.fwds.filter((f) => f.src === z.name).map((f) => f.dest);
      return h('tr', null,
        h('td', null, zonePill(z.name), h('div', { class: 'muted' }, asList(z.network).join(', ') || '네트워크 없음')),
        h('td', null, dests.length ? h('div', { class: 'zone-dests' }, dests.map(zonePill)) : h('span', { class: 'muted' }, '없음')),
        h('td', null, FW_POLICY_TEXT[fwPolicy(z.input)] || z.input),
        h('td', null, FW_POLICY_TEXT[fwPolicy(z.output, 'ACCEPT')] || z.output),
        h('td', null, FW_POLICY_TEXT[fwPolicy(z.forward)] || z.forward),
        h('td', null, h('span', { class: 'pill ' + (z.masq === '1' ? 'ok' : 'off') }, z.masq === '1' ? '켜짐' : '꺼짐')),
        h('td', { class: 'actions-cell' },
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editZone(ctx, z) }, '수정'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteZone(ctx, z) }, '삭제')));
    });
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => editZone(ctx, null) }, '영역 추가');
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, '영역 (Zone)')),
      h('p', { class: 'muted' }, '네트워크를 영역으로 묶고, 영역마다 들어오는 연결과 다른 영역으로 보내는 것을 허용할지 정합니다. "보낼 수 있는 영역"에 없는 곳으로는 막힙니다.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['영역', '보낼 수 있는 영역', '들어오는 연결', '나가는 연결', '영역 안 전달', '마스커레이드', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 7, class: 'muted' }, '영역이 없습니다.'))))),
      h('div', { class: 'actions' }, addBtn));
  }

  async function deleteZone(ctx, z) {
    const n = z.name;
    const related = ctx.fw.filter((s) => (s['.type'] === 'forwarding' && (s.src === n || s.dest === n))
      || (['rule', 'redirect'].includes(s['.type']) && (s.src === n || s.dest === n)));
    const rules = related.filter((s) => s['.type'] !== 'forwarding').length;
    const text = [
      `'${n}' 영역을 삭제합니다. 이 영역의 전달 설정${rules ? `과 이 영역을 쓰는 규칙/포트포워드 ${rules}개` : ''}도 함께 지웁니다.`,
      ['lan', 'wan'].includes(n) ? h('p', { class: 'msg warn-msg' }, `'${n}'은 기본 영역입니다. 지우면 ${n === 'lan' ? '내부 네트워크에서 공유기와 인터넷에 접속하지 못할' : '인터넷 연결이 보호되지 않거나 동작하지 않을'} 수 있습니다.`) : null,
    ];
    if (!await confirmDialog('영역 삭제', text, '삭제', true)) return;
    apply([{ op: 'delete', config: 'firewall', section: z['.name'] },
      ...related.map((s) => ({ op: 'delete', config: 'firewall', section: s['.name'] }))]);
  }

  // 영역 추가/수정 (z = null이면 추가)
  function editZone(ctx, z) {
    const isNew = !z;
    const cur = z || { input: 'ACCEPT', output: 'ACCEPT', forward: 'REJECT', network: [] };
    const others = ctx.zones.filter((x) => !z || x['.name'] !== z['.name']);
    const name = h('input', { type: 'text', value: z ? z.name : '', spellcheck: 'false', placeholder: '예: iot', disabled: !isNew });
    const fName = formField('영역 이름', name, isNew ? '영문/숫자/_ 11자까지' : '이름은 바꿀 수 없습니다 (삭제 후 다시 만드세요)');
    const sel = {
      input: selectEl(FW_POLICIES, fwPolicy(cur.input)),
      output: selectEl(FW_POLICIES, fwPolicy(cur.output, 'ACCEPT')),
      forward: selectEl(FW_POLICIES, fwPolicy(cur.forward)),
    };
    const masq = toggleEl(cur.masq === '1', '마스커레이드 (NAT, 보통 인터넷 영역에서 켬)');
    const mss = toggleEl(cur.mtu_fix === '1', 'MSS 클램핑 (PPPoE 등에서 일부 사이트가 안 열릴 때)');
    const curNets = asList(cur.network);
    const ownerOf = (n) => ctx.zones.find((x) => x !== z && asList(x.network).includes(n));
    const netSel = multiSelect('포함할 네트워크',
      ctx.ifaces.map((n) => [n, n, ownerOf(n) ? `지금 '${ownerOf(n).name}' 영역 (고르면 이 영역으로 옮김)` : '']),
      curNets, { empty: '네트워크 없음' });
    const fwdOf = (src, dest) => ctx.fwds.find((f) => f.src === src && f.dest === dest);
    const zoneOpts = others.map((o) => [o.name, o.name]);
    const destSel = multiSelect('이 영역에서 보낼 수 있는 영역', zoneOpts,
      others.filter((o) => z && fwdOf(z.name, o.name)).map((o) => o.name), { chip: zonePill, empty: '없음 (모두 막힘)' });
    const srcSel = multiSelect('이 영역으로 보낼 수 있는 영역', zoneOpts,
      others.filter((o) => z && fwdOf(o.name, z.name)).map((o) => o.name), { chip: zonePill, empty: '없음 (모두 막힘)' });
    const err = h('p', { class: 'msg', hidden: true });

    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', () => {
      fName.setError(null);
      err.hidden = true;
      const n = isNew ? name.value.trim() : z.name;
      if (isNew) {
        if (!FW_ZONE_RE.test(n)) { fName.setError('영문/숫자/_로 1~11자'); return; }
        if (ctx.zones.some((x) => x.name === n)) { fName.setError('이미 있는 영역입니다.'); return; }
      }
      const nets = netSel.values();
      const ops = [];
      const v = {
        input: sel.input.value, output: sel.output.value, forward: sel.forward.value,
        masq: masq.input.checked ? '1' : '', mtu_fix: mss.input.checked ? '1' : '',
      };
      if (isNew) {
        ops.push({ op: 'add', config: 'firewall', type: 'zone', values: { name: n, ...(nets.length ? { network: nets } : {}), ...dropEmpty(v) } });
      } else {
        const changed = {};
        if (v.input !== fwPolicy(z.input)) changed.input = v.input;
        if (v.output !== fwPolicy(z.output, 'ACCEPT')) changed.output = v.output;
        if (v.forward !== fwPolicy(z.forward)) changed.forward = v.forward;
        if (v.masq !== (z.masq === '1' ? '1' : '')) changed.masq = v.masq;
        if (v.mtu_fix !== (z.mtu_fix === '1' ? '1' : '')) changed.mtu_fix = v.mtu_fix;
        if (nets.join(' ') !== curNets.join(' ')) changed.network = nets.length ? nets : '';
        if (Object.keys(changed).length) ops.push({ op: 'set', config: 'firewall', section: z['.name'], values: changed });
      }
      // 네트워크는 한 영역에만 속한다: 다른 영역에서 뺀다
      const moved = {}; // 영역 섹션 -> 남는 네트워크
      for (const m of nets) {
        const owner = ownerOf(m);
        if (!owner || curNets.includes(m)) continue;
        moved[owner['.name']] = (moved[owner['.name']] || asList(owner.network)).filter((x) => x !== m);
      }
      for (const [section, left] of Object.entries(moved)) {
        ops.push({ op: 'set', config: 'firewall', section, values: { network: left.length ? left : '' } });
      }
      // 영역 간 전달
      const syncFwd = (picked, srcOf, destOf) => {
        for (const o of others) {
          const src = srcOf(o.name);
          const dest = destOf(o.name);
          const f = z ? fwdOf(src, dest) : null;
          const want = picked.includes(o.name);
          if (want && !f) ops.push({ op: 'add', config: 'firewall', type: 'forwarding', values: { src, dest } });
          if (!want && f) ops.push({ op: 'delete', config: 'firewall', section: f['.name'] });
        }
      };
      syncFwd(destSel.values(), () => n, (o) => o);
      syncFwd(srcSel.values(), (o) => o, () => n);
      closeModal();
      apply(ops);
    });

    showModal(h('h3', null, isNew ? '영역 추가' : `'${z.name}' 영역 수정`),
      fName.el,
      netSel.el,
      formField('들어오는 연결 (Input)', sel.input).el,
      formField('나가는 연결 (Output)', sel.output).el,
      formField('영역 안 전달 (Forward)', sel.forward).el,
      masq.el, mss.el,
      destSel.el,
      srcSel.el,
      err, h('div', { class: 'actions' }, cancel, save));
  }

  load();
  return () => { alive = false; };
}

PAGES['/firewall'] = firewallSettingsPage;
