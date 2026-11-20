// 포트포워드 설정, 인터넷 접속 차단 (firewall uci)

const PROTO_CHOICES = [['tcp udp', 'TCP + UDP'], ['tcp', 'TCP'], ['udp', 'UDP']];

function protoText(p) {
  const list = asList(p).map((x) => x.toLowerCase());
  if (!list.length || list.includes('all')) return '전체';
  return list.map((x) => x.toUpperCase()).join(' + ');
}

function portRange(s) {
  const [a, b] = String(s).split(/[-:]/);
  return [+a, +(b || a)];
}

function protosOverlap(a, b) {
  const la = asList(a).map((x) => x.toLowerCase());
  const lb = asList(b).map((x) => x.toLowerCase());
  if (!la.length || !lb.length || la.includes('all') || lb.includes('all')) return true;
  return la.some((x) => lb.includes(x));
}

// 섹션의 enabled 옵션: 없거나 '1'이면 사용
const isEnabled = (s) => s.enabled !== '0';

function enabledButton(sectionNames, enabled, reload) {
  const btn = h('button', { class: 'btn btn-ghost btn-small', type: 'button' }, enabled ? '중지' : '사용');
  btn.addEventListener('click', async () => {
    const r = await runApply(sectionNames.map((section) => ({
      op: 'set', config: 'firewall', section, values: { enabled: enabled ? '0' : '' },
    })));
    if (r === 'applied' || r === 'rolledback') reload();
  });
  return btn;
}

// 내부 기기 IP 입력칸 + 접속 기기에서 고르기
function deviceIpPicker(leases, placeholder) {
  const input = h('input', { type: 'text', inputmode: 'decimal', spellcheck: 'false', placeholder });
  const pick = h('select', null, h('option', { value: '' }, '접속 중인 기기에서 고르기...'),
    leases.map((l, i) => h('option', { value: String(i) }, `${l.name} (${l.ip})`)));
  pick.addEventListener('change', () => { if (leases[+pick.value]) input.value = leases[+pick.value].ip; });
  return { input, pick };
}

async function loadFirewallBase() {
  const [sections, lan, leases] = await Promise.all([
    uciSections('firewall'),
    ubus('uci', 'get', { config: 'network', section: 'lan' }),
    readLeases(),
  ]);
  return { sections: sections || [], lan: lan && lan.values ? readAddr(lan.values) : null, leases };
}

/* ---------- 포트포워드 ---------- */

function portForwardPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('포트포워드 설정'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let base;
    try {
      base = await loadFirewallBase();
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (alive) render(base);
  }

  function render({ sections, lan, leases }) {
    const rules = sections.filter((s) => s['.type'] === 'redirect' && (s.target || 'DNAT') === 'DNAT' && (s.src || 'wan') === 'wan');
    const rows = rules.map((r) => {
      const del = h('button', { class: 'btn btn-ghost btn-small', type: 'button' }, '삭제');
      del.addEventListener('click', async () => {
        if (!await confirmDialog('포트포워드 삭제', `'${r.name || r.src_dport}' 규칙을 삭제할까요?`, '삭제', true)) return;
        const res = await runApply([{ op: 'delete', config: 'firewall', section: r['.name'] }]);
        if (res === 'applied' || res === 'rolledback') reload();
      });
      return h('tr', null,
        h('td', null, r.name || '-'),
        h('td', null, protoText(r.proto || 'tcp udp')),
        h('td', null, r.src_dport || '-'),
        h('td', null, r.dest_ip || '-'),
        h('td', null, r.dest_port || r.src_dport || '-'),
        h('td', null, h('span', { class: 'pill ' + (isEnabled(r) ? 'ok' : 'off') }, isEnabled(r) ? '사용' : '중지')),
        h('td', { class: 'actions-cell' }, enabledButton([r['.name']], isEnabled(r), reload), ' ', del));
    });

    const name = h('input', { type: 'text', placeholder: '예: 게임 서버' });
    const proto = selectEl(PROTO_CHOICES, 'tcp udp');
    const ext = h('input', { type: 'text', inputmode: 'numeric', placeholder: '예: 8080 또는 8000-8010' });
    const dev = deviceIpPicker(leases, lan ? lan.ip.replace(/\d+$/, '50') : '192.168.1.50');
    const intPort = h('input', { type: 'text', inputmode: 'numeric', placeholder: '비우면 외부 포트와 같음' });
    const f = {
      name: formField('규칙 이름', name),
      proto: formField('프로토콜', proto),
      ext: formField('외부 포트', ext),
      ip: formField('내부 IP 주소', dev.input),
      intPort: formField('내부 포트 (선택)', intPort),
    };
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
    addBtn.addEventListener('click', async () => {
      Object.values(f).forEach((x) => x.setError(null));
      const v = { name: name.value.trim(), ext: ext.value.trim(), ip: dev.input.value.trim(), intPort: intPort.value.trim() };
      let bad = false;
      if (!v.name) { f.name.setError('규칙 이름을 입력해 주세요.'); bad = true; }
      if (!isPortRange(v.ext)) { f.ext.setError('1~65535 사이의 포트 또는 범위(예: 8000-8010)를 입력해 주세요.'); bad = true; }
      if (v.intPort && !isPortRange(v.intPort)) { f.intPort.setError('포트 형식이 올바르지 않습니다.'); bad = true; }
      if (!isIPv4(v.ip)) { f.ip.setError('IP 주소 형식이 올바르지 않습니다.'); bad = true; }
      else if (lan && !sameSubnet(v.ip, lan.ip, lan.mask)) { f.ip.setError(`내부 네트워크(${lan.ip}) 대역의 주소여야 합니다.`); bad = true; }
      else if (lan && v.ip === lan.ip) { f.ip.setError('공유기 자신의 주소입니다. 공유기 서비스는 포트포워드가 필요 없습니다.'); bad = true; }
      if (!bad && isPortRange(v.ext)) {
        const [a1, a2] = portRange(v.ext);
        const clash = rules.find((r) => r.src_dport && protosOverlap(r.proto || 'tcp udp', proto.value)
          && (() => { const [b1, b2] = portRange(r.src_dport); return a1 <= b2 && b1 <= a2; })());
        if (clash) { f.ext.setError(`'${clash.name || clash.src_dport}' 규칙과 외부 포트가 겹칩니다.`); bad = true; }
      }
      if (bad) return;
      const values = {
        name: v.name, src: 'wan', dest: 'lan', target: 'DNAT',
        proto: proto.value.split(' '), src_dport: v.ext, dest_ip: v.ip,
      };
      if (v.intPort) values.dest_port = v.intPort;
      addBtn.disabled = true;
      const res = await runApply([{ op: 'add', config: 'firewall', type: 'redirect', values }]);
      addBtn.disabled = false;
      if (res === 'applied' || res === 'rolledback') reload();
    });

    body.replaceChildren(
      card('포트포워드 목록',
        h('p', { class: 'muted' }, '인터넷에서 공유기의 외부 포트로 들어온 연결을 내부 기기로 넘겨 줍니다.'),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ...['이름', '프로토콜', '외부 포트', '내부 IP', '내부 포트', '상태', ''].map((x) => h('th', null, x)))),
            h('tbody', null, rows)))
          : h('p', { class: 'muted' }, '등록된 포트포워드가 없습니다.')),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '새 규칙 추가')),
        h('div', { class: 'fieldset' }, f.name.el, f.proto.el, f.ext.el),
        leases.length ? h('label', { class: 'field' }, h('span', null, '기기 선택'), dev.pick) : null,
        h('div', { class: 'fieldset' }, f.ip.el, f.intPort.el),
        h('div', { class: 'actions' }, addBtn)),
    );
  }

  load();
  return () => { alive = false; };
}

/* ---------- 인터넷 접속 차단 ---------- */

const BLOCK_PREFIX = 'wrtTIME 차단: ';
// 이름을 바꾸기 전(NMMWrt)에 만든 차단 규칙도 알아본다
const BLOCK_PREFIXES = [BLOCK_PREFIX, 'NMMWrt 차단: '];
const blockPrefixOf = (name) => BLOCK_PREFIXES.find((p) => String(name || '').startsWith(p));
const WEEKDAYS = [['Mon', '월'], ['Tue', '화'], ['Wed', '수'], ['Thu', '목'], ['Fri', '금'], ['Sat', '토'], ['Sun', '일']];

function blockTimeText(r) {
  if (!r.start_time && !r.stop_time) return '항상';
  const days = asList(r.weekdays);
  const dayText = days.length && days.length < 7
    ? WEEKDAYS.filter(([k]) => days.includes(k)).map(([, v]) => v).join('')
    : '매일';
  return `${dayText} ${(r.start_time || '00:00').slice(0, 5)}~${(r.stop_time || '23:59').slice(0, 5)}`;
}

function accessPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('인터넷 접속 차단'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let base;
    try {
      base = await loadFirewallBase();
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (alive) render(base);
  }

  function render({ sections, leases }) {
    const mine = sections.filter((s) => s['.type'] === 'rule' && blockPrefixOf(s.name));
    // 자정을 넘는 시간대는 규칙 두 개로 저장하므로 이름으로 묶어 보여 준다
    const groups = new Map();
    for (const r of mine) {
      if (!groups.has(r.name)) groups.set(r.name, []);
      groups.get(r.name).push(r);
    }
    const byMac = new Map(leases.map((l) => [l.mac.toLowerCase(), l]));
    const rows = [...groups.entries()].map(([nm, rs]) => {
      const label = nm.slice(blockPrefixOf(nm).length);
      const mac = asList(rs[0].src_mac)[0] || '-';
      const lease = byMac.get(String(mac).toLowerCase());
      const timeText = rs.length > 1
        ? blockTimeText({ ...rs[0], start_time: rs.find((r) => r.start_time !== '00:00:00')?.start_time, stop_time: rs.find((r) => r.start_time === '00:00:00')?.stop_time })
        : blockTimeText(rs[0]);
      const enabled = rs.every(isEnabled);
      const del = h('button', { class: 'btn btn-ghost btn-small', type: 'button' }, '삭제');
      del.addEventListener('click', async () => {
        if (!await confirmDialog('차단 해제', `'${label}' 차단 규칙을 삭제할까요?`, '삭제', true)) return;
        const res = await runApply(rs.map((r) => ({ op: 'delete', config: 'firewall', section: r['.name'] })));
        if (res === 'applied' || res === 'rolledback') reload();
      });
      return h('tr', null,
        h('td', null, label, lease ? h('div', { class: 'muted' }, lease.ip) : null),
        h('td', null, mac),
        h('td', null, timeText),
        h('td', null, h('span', { class: 'pill ' + (enabled ? 'warn' : 'off') }, enabled ? '차단 중' : '중지')),
        h('td', { class: 'actions-cell' }, enabledButton(rs.map((r) => r['.name']), enabled, reload), ' ', del));
    });

    const pick = h('select', null, h('option', { value: '' }, '접속 중인 기기에서 고르기...'),
      leases.map((l, i) => h('option', { value: String(i) }, `${l.name} (${l.ip}, ${l.mac})`)));
    const label = h('input', { type: 'text', placeholder: '예: 아이 태블릿' });
    const mac = h('input', { type: 'text', spellcheck: 'false', placeholder: 'aa:bb:cc:dd:ee:ff' });
    pick.addEventListener('change', () => {
      const l = leases[+pick.value];
      if (!l) return;
      mac.value = l.mac;
      if (!label.value) label.value = l.name;
    });
    const always = h('input', { type: 'radio', name: 'blockwhen', value: 'always' });
    const timed = h('input', { type: 'radio', name: 'blockwhen', value: 'timed' });
    always.checked = true;
    const start = h('input', { type: 'time', value: '22:00' });
    const stop = h('input', { type: 'time', value: '07:00' });
    const dayBoxes = WEEKDAYS.map(([k, v]) => {
      const c = h('input', { type: 'checkbox', value: k });
      c.checked = true;
      return { k, c, el: h('label', null, c, v) };
    });
    const f = {
      label: formField('이름', label),
      mac: formField('MAC 주소', mac),
      start: formField('차단 시작', start),
      stop: formField('차단 끝', stop),
    };
    const timeBox = h('div', null, h('div', { class: 'fieldset' }, f.start.el, f.stop.el),
      h('div', { class: 'days' }, dayBoxes.map((d) => d.el)));
    const syncWhen = () => { timeBox.hidden = !timed.checked; };
    always.addEventListener('change', syncWhen);
    timed.addEventListener('change', syncWhen);
    syncWhen();
    const dayErr = h('p', { class: 'msg', hidden: true });

    const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
    addBtn.addEventListener('click', async () => {
      Object.values(f).forEach((x) => x.setError(null));
      dayErr.hidden = true;
      const v = { label: label.value.trim(), mac: mac.value.trim().toLowerCase() };
      let bad = false;
      if (!v.label) { f.label.setError('이름을 입력해 주세요.'); bad = true; }
      else if (BLOCK_PREFIXES.some((p) => groups.has(p + v.label))) { f.label.setError('같은 이름의 규칙이 있습니다.'); bad = true; }
      if (!isMac(v.mac)) { f.mac.setError('MAC 주소 형식이 올바르지 않습니다.'); bad = true; }
      const base = { name: BLOCK_PREFIX + v.label, src: 'lan', dest: 'wan', src_mac: v.mac, proto: 'all', target: 'REJECT' };
      let ops;
      if (timed.checked) {
        const days = dayBoxes.filter((d) => d.c.checked).map((d) => d.k);
        if (!start.value) { f.start.setError('시간을 입력해 주세요.'); bad = true; }
        if (!stop.value) { f.stop.setError('시간을 입력해 주세요.'); bad = true; }
        if (start.value && start.value === stop.value) { f.stop.setError('시작과 끝이 같습니다.'); bad = true; }
        if (!days.length) { dayErr.textContent = '요일을 하나 이상 고르세요.'; dayErr.hidden = false; bad = true; }
        if (bad) return;
        const wd = days.length === 7 ? {} : { weekdays: days.join(' ') };
        if (start.value < stop.value) {
          ops = [{ ...base, start_time: start.value + ':00', stop_time: stop.value + ':00', ...wd }];
        } else {
          // 자정을 넘는 경우(예: 22:00~07:00): 방화벽 시간 조건은 하루 안에서만 비교하므로 두 규칙으로 나눈다
          ops = [
            { ...base, start_time: start.value + ':00', stop_time: '23:59:59', ...wd },
            { ...base, start_time: '00:00:00', stop_time: stop.value + ':00', ...wd },
          ];
        }
      } else {
        if (bad) return;
        ops = [base];
      }
      addBtn.disabled = true;
      const res = await runApply(ops.map((values) => ({ op: 'add', config: 'firewall', type: 'rule', values })));
      addBtn.disabled = false;
      if (res === 'applied' || res === 'rolledback') reload();
    });

    body.replaceChildren(
      card('차단 목록',
        h('p', { class: 'muted' }, '등록한 기기는 정해진 시간 동안 인터넷에 접속할 수 없습니다. 내부 네트워크(공유기, 다른 기기)는 그대로 쓸 수 있습니다. 시간은 시스템 관리의 시간대 기준입니다.'),
        rows.length
          ? h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ...['기기', 'MAC 주소', '차단 시간', '상태', ''].map((x) => h('th', null, x)))),
            h('tbody', null, rows)))
          : h('p', { class: 'muted' }, '등록된 차단 규칙이 없습니다.')),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '차단할 기기 추가')),
        leases.length ? h('label', { class: 'field' }, h('span', null, '기기 선택'), pick) : null,
        h('div', { class: 'fieldset' }, f.label.el, f.mac.el),
        h('div', { class: 'choices' },
          h('label', { class: 'choice' }, always, h('span', null, h('b', null, '항상 차단'))),
          h('label', { class: 'choice' }, timed, h('span', null, h('b', null, '시간 지정'), h('small', null, '정한 요일과 시간에만 차단')))),
        timeBox, dayErr,
        h('p', { class: 'muted' }, '이미 열려 있던 연결은 바로 끊기지 않을 수 있습니다.'),
        h('div', { class: 'actions' }, addBtn)),
    );
  }

  load();
  return () => { alive = false; };
}

PAGES['/portforward'] = portForwardPage;
PAGES['/access'] = accessPage;
