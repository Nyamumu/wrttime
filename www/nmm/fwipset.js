// IP 세트 (NAT/라우터 관리): firewall의 ipset 섹션 (fw4). 주소나 포트 묶음을 만들어 트래픽 규칙에서 한 번에 쓴다.
//   match: '<방향>_<종류>' 목록 (src_net, dest_ip, src_mac, dest_port 등). 종류가 둘 이상이면 복합 세트이고, 이 화면은 항목만 고친다.
//   이 화면이 다루지 않는 옵션(timeout, maxelem, counters 등)은 그대로 둔다.
//   주의: fw4는 꺼진 세트를 없는 세트로 본다. 그 세트를 쓰는 규칙은 통째로 적용되지 않으므로, 끄기 전에 알려 준다.

const IPSET_KINDS = [['net', 'IP 주소 또는 대역'], ['ip', 'IP 주소 (한 개씩)'], ['mac', 'MAC 주소'], ['port', '포트 번호']];
const IPSET_KIND_TEXT = { net: 'IP·대역', ip: 'IP', mac: 'MAC', port: '포트', set: '세트' };
const IPSET_FAMILIES = [['ipv4', 'IPv4'], ['ipv6', 'IPv6']];
const IPSET_DIRS = [['src', '출발'], ['dest', '도착']];
const IPSET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/;
const IPSET_PLACEHOLDER = {
  net: '192.168.1.10\n192.168.2.0/24',
  ip: '192.168.1.10\n192.168.1.11',
  mac: '00:11:22:33:44:55',
  port: '80\n443',
};

// match 목록 -> [{ dir: 'src'|'dest', type }]. 방향을 적지 않으면 출발이다.
function ipsetFields(s) {
  return asList(s.match).map((m) => {
    const x = /^(src|dst|dest)_(.+)$/.exec(m);
    return { dir: !x || x[1] === 'src' ? 'src' : 'dest', type: x ? x[2] : m };
  });
}

function ipsetFamily(s) {
  const f = String(s.family || 'ipv4').toLowerCase();
  if (['any', 'all', '*'].includes(f)) return 'any';
  if (f === 'inet' || f.includes('4')) return 'ipv4';
  return f.includes('6') ? 'ipv6' : 'ipv4';
}

// 규칙의 ipset 값 '!이름 src' -> { neg, name, dir }
function ipsetRef(v) {
  const m = /^\s*(!?)\s*(\S+)\s*(.*)$/.exec(String(v));
  return m ? { neg: !!m[1], name: m[2], dir: m[3].trim().replace(/\bdst\b/g, 'dest') } : null;
}

const ipsetRefText = (r) => `${r.neg ? '!' : ''}${r.name}${r.dir ? ` ${r.dir}` : ''}`;

// 규칙의 ipset 옵션 목록. 값 안의 띄어쓰기가 방향 구분이라 공백으로 나누는 asList를 쓰면 안 된다.
const ipsetRefList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// 이 세트를 쓰는 규칙과 포트포워드
function ipsetUsers(fw, name) {
  return fw.filter((s) => (s['.type'] === 'rule' || s['.type'] === 'redirect')
    && ipsetRefList(s.ipset).some((v) => (ipsetRef(v) || {}).name === name));
}

function ipsetEntryOk(type, family, t) {
  if (type === 'mac') return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(t);
  if (type === 'port') return /^\d{1,5}$/.test(t) && +t >= 1 && +t <= 65535;
  if (type !== 'net' && type !== 'ip') return false;
  if (t.startsWith('!') || !okIp(t)) return false;
  if (isIPv4(t.split('/')[0]) !== (family !== 'ipv6')) return false;
  return type === 'net' || !t.includes('/');
}

// 입력칸 -> { entries, bad }. 종류가 하나면 띄어쓰기와 쉼표로도 나눈다. 복합 세트는 한 줄에 항목 하나 (값은 띄어 쓰기).
function ipsetParseEntries(text, fields, family) {
  const items = fields.length === 1
    ? text.split(/[\s,]+/).filter(Boolean)
    : text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const bad = items.find((it) => {
    const parts = fields.length === 1 ? [it] : it.split(' ');
    return parts.length !== fields.length || parts.some((p, i) => !ipsetEntryOk(fields[i].type, family, p));
  });
  return { entries: [...new Set(items)], bad };
}

function ipsetPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('IP 세트'), body);
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
    render({ fw, sets: fw.filter((s) => s['.type'] === 'ipset') });
  }

  async function apply(ops) {
    if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
    const r = await runApply(ops);
    if (r === 'applied' || r === 'rolledback') reload();
  }

  const userNames = (users) => users.map((u) => u.name || '(이름 없음)').join(', ');
  const stopWarning = (users) => h('p', { class: 'msg warn-msg' },
    `이 세트를 끄면 이 세트를 쓰는 규칙(${userNames(users)})도 함께 적용되지 않습니다. 차단 규칙이라면 차단이 풀립니다.`);

  function typeText(s) {
    const fields = ipsetFields(s);
    if (!fields.length) return '종류 없음';
    const fam = ipsetFamily(s);
    const famText = fields.some((x) => x.type === 'net' || x.type === 'ip') && fam !== 'any' ? `${fam === 'ipv6' ? 'IPv6' : 'IPv4'} · ` : '';
    return famText + fields.map((x) => `${x.dir === 'src' ? '출발' : '도착'} ${IPSET_KIND_TEXT[x.type] || x.type}`).join(' + ');
  }

  function entriesCell(s) {
    const entries = asList(s.entry);
    const shown = entries.slice(0, 4).map((e) => h('span', { class: 'ms-chip', style: 'margin:0 4px 4px 0' }, e));
    return h('td', null,
      entries.length ? h('div', null, ...shown) : null,
      entries.length > 4 ? h('div', { class: 'muted' }, `외 ${entries.length - 4}개 (전체 ${entries.length}개)`) : null,
      s.loadfile ? h('div', { class: 'muted' }, `파일: ${s.loadfile}`) : null,
      !entries.length && !s.loadfile ? h('span', { class: 'muted' }, '항목 없음') : null);
  }

  function render(ctx) {
    const rows = ctx.sets.map((s) => {
      const on = s.enabled !== '0';
      const users = ipsetUsers(ctx.fw, s.name);
      return h('tr', { class: on ? '' : 'row-off' },
        h('td', null, h('b', null, s.name || '(이름 없음)'), s.comment ? h('div', { class: 'muted' }, s.comment) : null),
        h('td', null, typeText(s)),
        entriesCell(s),
        h('td', null, users.length ? userNames(users) : h('span', { class: 'muted' }, '없음')),
        h('td', null, h('span', { class: 'pill ' + (on ? 'ok' : 'off') }, on ? '사용' : '꺼짐')),
        h('td', { class: 'actions-cell' },
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => toggleSet(ctx, s) }, on ? '중지' : '사용'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => editSet(ctx, s) }, '수정'),
          h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: () => deleteSet(ctx, s) }, '삭제')));
    });
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button', onclick: () => editSet(ctx, null) }, 'IP 세트 추가');
    body.replaceChildren(h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'card-head' }, h('h3', null, 'IP 세트')),
      h('p', { class: 'muted' }, '여러 IP 주소, 대역, MAC 주소, 포트를 하나의 묶음으로 만듭니다. 만든 세트는 트래픽 규칙의 "IP 세트"에서 골라 한 번에 허용하거나 차단할 수 있습니다.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['이름', '종류', '항목', '사용하는 규칙', '상태', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'IP 세트가 없습니다.'))))),
      h('div', { class: 'actions' }, addBtn)));
  }

  async function toggleSet(ctx, s) {
    const on = s.enabled !== '0';
    const users = ipsetUsers(ctx.fw, s.name);
    if (on && users.length && !await confirmDialog('IP 세트 중지', [`'${s.name}' 세트를 중지합니다.`, stopWarning(users)], '중지', true)) return;
    apply([{ op: 'set', config: 'firewall', section: s['.name'], values: { enabled: on ? '0' : '' } }]);
  }

  async function deleteSet(ctx, s) {
    const users = ipsetUsers(ctx.fw, s.name);
    if (users.length) {
      infoModal('IP 세트 삭제', `'${s.name}' 세트는 다음 규칙에서 쓰고 있어 삭제할 수 없습니다: ${userNames(users)}. 규칙에서 먼저 빼 주세요.`);
      return;
    }
    if (!await confirmDialog('IP 세트 삭제', `'${s.name || '(이름 없음)'}' 세트를 삭제합니다.`, '삭제', true)) return;
    apply([{ op: 'delete', config: 'firewall', section: s['.name'] }]);
  }

  // 세트 추가/수정 (s = null이면 새 세트)
  function editSet(ctx, s) {
    const fields = s ? ipsetFields(s) : [{ dir: 'src', type: 'net' }];
    const known = fields.length > 0 && fields.every((x) => IPSET_KINDS.some(([k]) => k === x.type));
    const simple = known && fields.length === 1;
    const users = s ? ipsetUsers(ctx.fw, s.name) : [];
    const locked = users.length > 0;

    const name = h('input', { type: 'text', value: s ? s.name || '' : '', spellcheck: 'false', placeholder: '예: blocklist' });
    const comment = h('input', { type: 'text', value: s ? s.comment || '' : '', placeholder: '예: 차단할 주소' });
    const kind = selectEl(IPSET_KINDS, simple ? fields[0].type : 'net');
    const curFam = s ? ipsetFamily(s) : 'ipv4';
    const family = selectEl(IPSET_FAMILIES, curFam === 'ipv6' ? 'ipv6' : 'ipv4');
    const dir = selectEl(IPSET_DIRS, simple ? fields[0].dir : 'src');
    kind.disabled = locked;
    family.disabled = locked;
    const entries = h('textarea', { rows: '7', spellcheck: 'false' });
    entries.value = asList(s ? s.entry : []).join('\n');
    entries.readOnly = !known;
    const loadfile = h('input', { type: 'text', value: s ? s.loadfile || '' : '', spellcheck: 'false', placeholder: '예: /etc/wrttime/blocklist.txt' });
    const enabled = toggleEl(s ? s.enabled !== '0' : true, '이 세트 사용');
    const f = {
      name: formField('이름', name, '영문, 숫자, _ . - (영문이나 _로 시작)'),
      comment: formField('설명', comment),
      kind: formField('항목 종류', kind, locked ? '규칙에서 쓰는 세트는 종류를 바꿀 수 없습니다' : ''),
      family: formField('주소 종류', family),
      dir: formField('기본 비교 방향', dir, '트래픽 규칙에서 따로 고르지 않으면 이 방향으로 비교합니다'),
      entries: formField('항목', entries, known ? '한 줄에 하나씩 입력' : '이 세트의 항목은 여기서 고칠 수 없습니다'),
      loadfile: formField('항목 파일 (선택)', loadfile, '공유기에 있는 파일에서 항목을 더 읽습니다. 한 줄에 하나씩'),
    };
    const familyBox = h('div', null, f.family.el);
    const sync = () => {
      const isAddr = kind.value === 'net' || kind.value === 'ip';
      familyBox.hidden = !isAddr;
      if (kind.value === 'mac') dir.value = 'src'; // MAC 주소는 출발 쪽만 비교할 수 있다
      dir.disabled = kind.value === 'mac';
      entries.placeholder = IPSET_PLACEHOLDER[kind.value] || '';
    };
    kind.addEventListener('change', sync);
    sync();

    const save = h('button', { class: 'btn', type: 'button' }, '적용');
    const cancel = h('button', { class: 'btn btn-ghost', type: 'button', onclick: closeModal }, '취소');
    save.addEventListener('click', async () => {
      Object.values(f).forEach((x) => x.setError(null));
      let bad = false;
      const newName = name.value.trim();
      const nameChanged = !s || newName !== s.name;
      if (nameChanged && !IPSET_NAME_RE.test(newName)) { f.name.setError('영문이나 _로 시작하는 1~31자 (영문, 숫자, _ . -)'); bad = true; }
      else if (ctx.sets.some((x) => x !== s && x.name === newName)) { f.name.setError('이미 있는 이름입니다'); bad = true; }

      const useFields = simple || !s ? [{ dir: dir.value, type: kind.value }] : fields;
      const isAddr = useFields.some((x) => x.type === 'net' || x.type === 'ip');
      const useFamily = simple || !s ? family.value : curFam;
      let list = asList(s ? s.entry : []);
      if (known) {
        const parsed = ipsetParseEntries(entries.value, useFields, useFamily);
        if (parsed.bad !== undefined) { f.entries.setError(`형식이 올바르지 않습니다: ${parsed.bad}`); bad = true; }
        list = parsed.entries;
      }
      const file = loadfile.value.trim();
      if (file && !/^\/[A-Za-z0-9._/-]+$/.test(file)) { f.loadfile.setError('/로 시작하는 파일 경로를 입력해 주세요'); bad = true; }
      if (known && !list.length && !file) { f.entries.setError('항목을 하나 이상 입력해 주세요'); bad = true; }
      if (bad) return;

      const wasOn = !s || s.enabled !== '0';
      if (wasOn && !enabled.input.checked && users.length
        && !await confirmDialog('IP 세트 중지', [`'${s.name}' 세트를 중지합니다.`, stopWarning(users)], '중지', true)) return;

      const want = { name: newName, comment: comment.value.trim(), loadfile: file, enabled: enabled.input.checked ? '' : '0' };
      if (known) want.entry = list.length ? list : '';
      if (simple || !s) {
        want.match = [`${dir.value}_${kind.value}`];
        // MAC과 포트는 IPv4/IPv6 구분이 없다. 종류를 그대로 두면 원래 값을 건드리지 않는다.
        if (isAddr) want.family = family.value;
        else if (!s || fields[0].type !== kind.value) want.family = 'any';
      }

      const ops = [];
      if (!s) {
        const values = Object.fromEntries(Object.entries(want).filter(([, v]) => v !== ''));
        ops.push({ op: 'add', config: 'firewall', type: 'ipset', values });
      } else {
        const changed = {};
        for (const [k, v] of Object.entries(want)) {
          let old = ruleList(s[k]);
          if (k === 'enabled') old = s.enabled === '0' ? '0' : '';
          if (k === 'family') old = ipsetFamily(s);
          if (k === 'match') old = fields.map((x) => `${x.dir}_${x.type}`).join(' ');
          if ((Array.isArray(v) ? v.join(' ') : v) !== old) changed[k] = v;
        }
        if (Object.keys(changed).length) ops.push({ op: 'set', config: 'firewall', section: s['.name'], values: changed });
        // 이름을 바꾸면 이 세트를 쓰는 규칙도 새 이름으로 바꾼다
        if (nameChanged) {
          for (const u of users) {
            const refs = ipsetRefList(u.ipset).map((v) => {
              const r = ipsetRef(v);
              return r && r.name === s.name ? ipsetRefText({ ...r, name: newName }) : v;
            });
            ops.push({ op: 'set', config: 'firewall', section: u['.name'], values: { ipset: Array.isArray(u.ipset) ? refs : refs[0] } });
          }
        }
      }
      closeModal();
      apply(ops);
    });

    showModal(h('h3', null, s ? 'IP 세트 수정' : 'IP 세트 추가'),
      h('div', { class: 'fieldset' }, f.name.el, f.comment.el),
      simple || !s
        ? h('div', { class: 'fieldset' }, f.kind.el, familyBox, f.dir.el)
        : h('p', { class: 'muted' }, `복합 세트입니다: ${typeText(s)}. 종류는 여기서 바꿀 수 없습니다.`),
      f.entries.el, f.loadfile.el, enabled.el,
      h('div', { class: 'actions' }, cancel, save));
  }

  load();
  return () => { alive = false; };
}

PAGES['/fw-ipset'] = ipsetPage;
