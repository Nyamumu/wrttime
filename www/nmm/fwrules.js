// 트래픽 규칙 (NAT/라우터 관리): LuCI의 Firewall > Traffic Rules를 wrtTIME 방식으로 다시 만든 것. firewall의 rule 섹션.
//   방향: 도착(dest)이 없으면 공유기로 들어옴(input), 출발(src)이 없으면 공유기에서 나감(output), 둘 다 있으면 전달(forward).
//   '*'는 모든 영역. 이 화면이 다루지 않는 옵션(예: helper, set_mark, extra)은 건드리지 않고 그대로 둔다.

const RULE_TARGETS = [['ACCEPT', '허용'], ['REJECT', '거부 (응답함)'], ['DROP', '버림 (응답 없음)'], ['NOTRACK', '연결 추적 안 함']];
const RULE_TARGET_TEXT = { ACCEPT: '허용', REJECT: '거부', DROP: '버림', NOTRACK: '추적 안 함', MARK: '표시(MARK)', DSCP: 'DSCP 지정', HELPER: '도우미' };
const RULE_PROTOS = [['tcp', 'TCP'], ['udp', 'UDP'], ['icmp', 'ICMP'], ['igmp', 'IGMP'], ['esp', 'IPSec ESP'], ['ah', 'IPSec AH'], ['all', '모든 프로토콜']];
const RULE_FAMILY = [['', 'IPv4 + IPv6'], ['ipv4', 'IPv4'], ['ipv6', 'IPv6']];
const LIMIT_UNIT = { sec: '초', second: '초', min: '분', minute: '분', hour: '시간', day: '일' };
const RULE_SET_MODES = [['', '세트에 있는 항목에 적용'], ['!', '세트에 없는 항목에 적용']];
const RULE_SET_DIRS = [['', '세트에 정한 방향'], ['src', '출발 쪽과 비교'], ['dest', '도착 쪽과 비교']];

const ruleList = (v) => asList(v).join(' ');

// IPv4/IPv6 주소 또는 대역 (앞에 !를 붙이면 '이 주소 빼고')
function okIp(t) {
  const [addr, mask, more] = t.replace(/^!/, '').split('/');
  if (more !== undefined) return false;
  if (isIPv4(addr)) return mask === undefined || (/^\d{1,2}$/.test(mask) && +mask <= 32) || isNetmask(mask);
  const v6 = addr.includes(':') && /^[0-9A-Fa-f:]+$/.test(addr) && (addr.match(/::/g) || []).length <= 1 && addr.split(':').length <= 8;
  return v6 && (mask === undefined || (/^\d{1,3}$/.test(mask) && +mask <= 128));
}
const ruleProtos = (r) => (asList(r.proto).length ? asList(r.proto).map((p) => p.toLowerCase()) : ['tcp', 'udp']);

function ruleDirection(r) {
  if (!r.dest) return ['input', '공유기로 들어옴'];
  if (!r.src) return ['output', '공유기에서 나감'];
  return ['forward', '전달'];
}

// 표의 '조건' 칸
function ruleMatch(r, sets) {
  const [, dirText] = ruleDirection(r);
  const fam = { ipv4: 'IPv4', ipv6: 'IPv6' }[String(r.family || '').toLowerCase()] || 'IPv4·IPv6';
  const protos = ruleProtos(r);
  const protoTxt = protos.includes('all') ? '모든 프로토콜' : protos.map((p) => p.toUpperCase()).join(', ');
  const zone = (z, self) => (!z ? h('span', { class: 'ms-chip' }, self) : z === '*' ? h('span', { class: 'ms-chip' }, '모든 영역') : zonePill(z));
  const extra = (parts) => parts.filter(([, v]) => v).map(([k, v]) => ` · ${k} ${v}`).join('');
  const lines = [
    h('div', null, `${dirText} · ${fam} · ${protoTxt}`),
    h('div', null, '출발 ', zone(r.src, '이 공유기'),
      extra([['IP', ruleList(r.src_ip)], ['MAC', ruleList(r.src_mac)], ['포트', ruleList(r.src_port)]])),
    h('div', null, '도착 ', zone(r.dest, '이 공유기'),
      extra([['IP', ruleList(r.dest_ip)], ['포트', ruleList(r.dest_port)]])),
  ];
  for (const v of ipsetRefList(r.ipset)) {
    const ref = ipsetRef(v);
    if (!ref) continue;
    const set = sets.find((s) => s.name === ref.name);
    // fw4는 없거나 꺼진 세트를 쓰는 규칙을 통째로 적용하지 않는다
    const broken = !set || set.enabled === '0';
    const dirText = { src: ' · 출발', dest: ' · 도착' }[ref.dir] || '';
    lines.push(h('div', null, `IP 세트 ${ref.neg ? '제외 ' : ''}`, h('span', { class: 'ms-chip' }, ref.name), dirText,
      broken ? [' ', h('span', { class: 'pill bad' }, set ? '세트 꺼짐 · 규칙 미적용' : '세트 없음 · 규칙 미적용')] : null));
  }
  if (r.icmp_type) lines.push(h('div', { class: 'muted' }, `ICMP 종류: ${ruleList(r.icmp_type)}`));
  const lim = /^(\d+)\/(\w+)$/.exec(r.limit || '');
  if (lim) lines.push(h('div', { class: 'muted' }, `${LIMIT_UNIT[lim[2]] || lim[2]}당 ${lim[1]}개까지`));
  return h('div', { class: 'rule-match' }, lines);
}

function trafficRulesPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('트래픽 규칙'), body);
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
    const ctx = {
      rules: fw.filter((s) => s['.type'] === 'rule'),
      zones: fw.filter((s) => s['.type'] === 'zone' && s.name).map((s) => s.name),
      sets: fw.filter((s) => s['.type'] === 'ipset' && s.name),
    };
    render(ctx);
  }

  async function apply(ops) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    const r = await runApply(ops);
    if (r === 'applied' || r === 'rolledback') reload();
  }

  function render(ctx) {
    const rows = ctx.rules.map((r) => {
      const on = r.enabled !== '0';
      const [dir] = ruleDirection(r);
      const t = String(r.target || 'DROP').toUpperCase();
      return h('tr', { class: on ? '' : 'row-off' },
        h('td', null, h('b', null, r.name || '(이름 없음)')),
        h('td', null, ruleMatch(r, ctx.sets)),
        h('td', null, h('span', { class: 'pill ' + (t === 'ACCEPT' ? 'ok' : t === 'REJECT' || t === 'DROP' ? 'bad' : 'off') }, RULE_TARGET_TEXT[t] || t),
          h('div', { class: 'muted' }, dir)),
        h('td', null, h('span', { class: 'pill ' + (on ? 'ok' : 'off') }, on ? '사용' : '꺼짐')),
        h('td', { class: 'actions-cell' },
          enabledButton([r['.name']], on, reload),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editRule(ctx, r, false) }, '수정'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editRule(ctx, r, true) }, '복제'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteRule(r) }, '삭제')));
    });
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => editRule(ctx, null, false) }, '규칙 추가');
    body.replaceChildren(h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'card-head' }, h('h3', null, '트래픽 규칙')),
      h('p', { class: 'muted' }, '영역 사이 또는 공유기로 오가는 패킷을 허용하거나 막는 규칙입니다. 위에서부터 차례로 검사합니다. (포트포워드는 포트포워드 설정 메뉴에서)'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['이름', '조건', '동작', '상태', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 5, class: 'muted' }, '규칙이 없습니다.'))))),
      h('div', { class: 'actions' }, addBtn)));
  }

  async function deleteRule(r) {
    if (!await confirmDialog('규칙 삭제', `'${r.name || '(이름 없음)'}' 규칙을 삭제합니다.`, '삭제', true)) return;
    apply([{ op: 'delete', config: 'firewall', section: r['.name'] }]);
  }

  // 규칙 추가/수정/복제 (r = null이면 새 규칙, copy면 r을 복사해 새로 만든다)
  function editRule(ctx, r, copy) {
    const isNew = !r || copy;
    const cur = r || { src: 'wan', proto: ['tcp', 'udp'], target: 'ACCEPT' };
    const text = (v, ph) => h('input', { type: 'text', value: v || '', spellcheck: 'false', placeholder: ph || '' });
    const name = text(copy ? `${cur.name || '규칙'} (복사)` : cur.name, '예: Allow-SSH');
    const family = selectEl(RULE_FAMILY, String(cur.family || '').toLowerCase().replace(/^any$/, ''));
    const curProtos = ruleProtos(cur);
    const protoOpts = [...RULE_PROTOS, ...curProtos.filter((p) => !RULE_PROTOS.some(([v]) => v === p)).map((p) => [p, p.toUpperCase()])];
    const proto = multiSelect('프로토콜', protoOpts, curProtos,
      { chip: (v) => h('span', { class: 'ms-chip' }, (protoOpts.find(([k]) => k === v) || [v, v])[1]), empty: 'TCP + UDP (기본)' });
    const icmp = text(ruleList(cur.icmp_type), '예: echo-request');
    const zoneOpts = (self) => [['', self], ['*', '모든 영역'], ...ctx.zones.map((z) => [z, z])];
    const src = selectEl(zoneOpts('이 공유기 (나가는 연결)'), cur.src || '');
    const srcIp = text(ruleList(cur.src_ip), '비우면 모두');
    const srcMac = text(ruleList(cur.src_mac), '비우면 모두');
    const srcPort = text(ruleList(cur.src_port), '비우면 모두');
    const dest = selectEl(zoneOpts('이 공유기 (들어오는 연결)'), cur.dest || '');
    const destIp = text(ruleList(cur.dest_ip), '비우면 모두');
    const destPort = text(ruleList(cur.dest_port), '예: 22 또는 8000-8100');
    const target = selectEl(RULE_TARGETS, String(cur.target || 'DROP').toUpperCase());
    const limit = text(cur.limit, '예: 10/sec');
    // 세트를 여러 개 쓰는 규칙은 이 화면에서 바꾸지 않고 그대로 둔다
    const setRefs = ipsetRefList(cur.ipset);
    const setEditable = setRefs.length <= 1;
    const setRef = setRefs.length === 1 ? ipsetRef(setRefs[0]) : null;
    const setSel = selectEl([['', '사용 안 함'], ...ctx.sets.map((s) => [s.name, s.enabled === '0' ? `${s.name} (꺼짐)` : s.name])], setRef ? setRef.name : '');
    const setMode = selectEl(RULE_SET_MODES, setRef && setRef.neg ? '!' : '');
    const setDir = selectEl(RULE_SET_DIRS, setRef ? setRef.dir : '');
    const enabled = toggleEl(cur.enabled !== '0', '이 규칙 사용');
    const f = {
      name: formField('이름', name),
      family: formField('주소 종류', family),
      icmp: formField('ICMP 종류', icmp, 'ICMP일 때만. 여러 개는 띄어 쓰기'),
      src: formField('출발 영역', src),
      srcIp: formField('출발 IP', srcIp, '여러 개는 띄어 쓰기, 대역은 192.168.1.0/24'),
      srcMac: formField('출발 MAC', srcMac),
      srcPort: formField('출발 포트', srcPort),
      dest: formField('도착 영역', dest),
      destIp: formField('도착 IP', destIp),
      destPort: formField('도착 포트', destPort),
      target: formField('동작', target),
      limit: formField('횟수 제한', limit, '단위: sec, minute, hour, day'),
      set: formField('IP 세트', setSel, ctx.sets.length ? '' : 'NAT/라우터 관리 > IP 세트에서 먼저 만드세요'),
      setMode: formField('세트 조건', setMode),
      setDir: formField('비교 방향', setDir),
    };
    const setOptions = h('div', { class: 'fieldset' }, f.setMode.el, f.setDir.el);
    const syncSet = () => { setOptions.hidden = !setSel.value; };
    setSel.addEventListener('change', syncSet);
    syncSet();
    const err = h('p', { class: 'msg', hidden: true });

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
      err.hidden = true;
      let bad = false;
      const protos = proto.values();
      const portProto = !protos.length || protos.some((p) => p === 'tcp' || p === 'udp');
      for (const [field, input] of [[f.srcPort, srcPort], [f.destPort, destPort]]) {
        const ts = tokens(input.value);
        if (ts.some((t) => !okPort(t))) { field.setError('1~65535 숫자 또는 범위(8000-8100)'); bad = true; }
        else if (ts.length && !portProto) { field.setError('포트는 TCP/UDP일 때만 쓸 수 있습니다'); bad = true; }
      }
      for (const [field, input] of [[f.srcIp, srcIp], [f.destIp, destIp]]) {
        if (tokens(input.value).some((t) => !okIp(t))) { field.setError('IP 주소 형식이 올바르지 않습니다 (예: 192.168.1.10, 192.168.1.0/24)'); bad = true; }
      }
      if (tokens(srcMac.value).some((t) => !/^!?([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(t))) { f.srcMac.setError('예: 00:11:22:33:44:55'); bad = true; }
      if (limit.value.trim() && !/^\d+\/(sec|second|min|minute|hour|day)$/.test(limit.value.trim())) { f.limit.setError('예: 10/sec'); bad = true; }
      if (!src.value && !dest.value) { err.textContent = '출발과 도착이 모두 "이 공유기"일 수는 없습니다.'; err.hidden = false; bad = true; }
      if (protos.includes('all') && protos.length > 1) { proto.setError('"모든 프로토콜"은 다른 것과 함께 고를 수 없습니다'); bad = true; }
      // fw4가 규칙을 통째로 건너뛰는 조합은 미리 막는다
      const chosenSet = setEditable ? ctx.sets.find((s) => s.name === setSel.value) : null;
      if (chosenSet) {
        const setFields = ipsetFields(chosenSet);
        const setFam = ipsetFamily(chosenSet);
        const dirs = setDir.value ? setDir.value.split(/\s+/) : [];
        if (chosenSet.enabled === '0') { f.set.setError('꺼진 세트를 쓰면 이 규칙이 적용되지 않습니다. 세트를 먼저 켜 주세요'); bad = true; }
        else if (setFields.some((x, i) => x.type === 'mac' && (dirs[i] || x.dir) !== 'src')) { f.setDir.setError('MAC 주소는 출발 쪽만 비교할 수 있습니다'); bad = true; }
        else if (setFields.some((x) => x.type === 'port') && protos.some((p) => p !== 'tcp' && p !== 'udp')) { f.set.setError('포트 세트는 프로토콜이 TCP/UDP일 때만 쓸 수 있습니다'); bad = true; }
        else if (family.value && setFam !== 'any' && family.value !== setFam) { f.set.setError('규칙의 주소 종류와 세트의 주소 종류가 다릅니다'); bad = true; }
      }
      if (bad) return;

      const listVal = (s) => { const ts = tokens(s); return ts.length > 1 ? ts : (ts[0] || ''); };
      const setValue = setSel.value ? ipsetRefText({ neg: setMode.value === '!', name: setSel.value, dir: setDir.value }) : '';
      const want = {
        ...(setEditable ? { ipset: setValue } : {}),
        name: name.value.trim(),
        family: family.value,
        proto: protos.length > 1 ? protos : (protos[0] || ''),
        icmp_type: listVal(icmp.value),
        src: src.value, src_ip: listVal(srcIp.value), src_mac: listVal(srcMac.value), src_port: listVal(srcPort.value),
        dest: dest.value, dest_ip: listVal(destIp.value), dest_port: listVal(destPort.value),
        target: target.value,
        limit: limit.value.trim(),
        enabled: enabled.input.checked ? '' : '0',
      };
      const ops = [];
      if (isNew) {
        // 복제는 이 화면이 다루지 않는 옵션까지 그대로 가져간다
        const base = copy ? Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('.'))) : {};
        const values = Object.fromEntries(Object.entries({ ...base, ...want })
          .filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length)));
        ops.push({ op: 'add', config: 'firewall', type: 'rule', values });
      } else {
        const changed = {};
        for (const [k, v] of Object.entries(want)) {
          const old = k === 'enabled' ? (r.enabled === '0' ? '0' : '') : k === 'proto' ? (asList(r.proto).join(' ')) : k === 'target' ? String(r.target || '').toUpperCase() : ruleList(r[k]);
          const nv = Array.isArray(v) ? v.join(' ') : v;
          // proto가 없던 규칙은 TCP+UDP와 같다
          if (k === 'proto' && !asList(r.proto).length && (!nv || nv === 'tcp udp')) continue;
          if (k === 'family' && !nv && /^any$/i.test(r.family || '')) continue;
          if (nv !== old) changed[k] = v;
        }
        if (Object.keys(changed).length) ops.push({ op: 'set', config: 'firewall', section: r['.name'], values: changed });
      }
      if (!ops.length) { closeModal(); infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      closeModal();
      apply(ops);
    });

    showModal(h('h3', null, !r ? '규칙 추가' : copy ? '규칙 복제' : '규칙 수정'),
      f.name.el,
      h('div', { class: 'fieldset' }, f.family.el, f.target.el),
      proto.el, f.icmp.el,
      h('div', { class: 'fieldset' }, f.src.el, f.srcPort.el),
      h('div', { class: 'fieldset' }, f.srcIp.el, f.srcMac.el),
      h('div', { class: 'fieldset' }, f.dest.el, f.destPort.el),
      f.destIp.el,
      setEditable ? f.set.el : h('p', { class: 'muted' }, `IP 세트 ${setRefs.length}개를 쓰는 규칙입니다. 세트 조건은 그대로 유지됩니다.`),
      setEditable ? setOptions : null,
      f.limit.el, enabled.el,
      err, h('div', { class: 'actions' }, cancel, save));
  }

  load();
  return () => { alive = false; };
}

PAGES['/fw-rules'] = trafficRulesPage;
