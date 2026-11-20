// SSH 설정 (시스템 관리): dropbear 설정과 공개 키(/etc/dropbear/authorized_keys).
//   설정은 uci로 적용한다. 공개 키 파일은 로그인할 때마다 읽히므로 저장하면 바로 반영된다.
//   웹 접속이 살아 있어도 SSH만 막힐 수 있어서(자동 되돌림이 잡지 못한다) 잠길 수 있는 변경은 미리 막거나 확인을 받는다.

const SSH_KEYS_PATH = '/etc/dropbear/authorized_keys';
const SSH_KEYS_MODE = 0o600; // dropbear는 다른 계정이 쓸 수 있는 키 파일을 거부한다
const SSH_KEY_RE = /(?:^|\s)(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

// dropbear의 참/거짓 옵션: 1/0, on/off, true/false, yes/no
function sshBool(v, dflt) {
  if (v == null || v === '') return dflt;
  return !['0', 'off', 'false', 'no', 'disabled'].includes(String(v).toLowerCase());
}

// authorized_keys 한 줄 -> { type, blob, comment } (키 안에 적힌 종류까지 맞아야 한다)
function sshParseKey(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const m = SSH_KEY_RE.exec(t);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const len = (bin.charCodeAt(0) << 24) | (bin.charCodeAt(1) << 16) | (bin.charCodeAt(2) << 8) | bin.charCodeAt(3);
    if (bin.slice(4, 4 + len) !== m[1]) return null;
  } catch {
    return null;
  }
  return { type: m[1], blob: m[2], comment: m[3] || '' };
}

function sshPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('SSH 설정'), body);
  let alive = true;
  const reload = () => { if (alive) load(); };

  async function load() {
    let sections, net, keysText = '';
    let keysOk = true;
    try {
      [sections, net] = await Promise.all([uciSections('dropbear'), uciSections('network')]);
      try {
        keysText = (await ubus('file', 'read', { path: SSH_KEYS_PATH })).data || '';
      } catch (e) {
        if (!(e instanceof RpcError) || e.code !== UBUS_NOT_FOUND) keysOk = false; // 파일이 없으면 등록된 키가 없는 것
      }
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    if (!sections) { body.replaceChildren(messageCard('이 공유기에서 SSH 서버(dropbear) 설정을 찾을 수 없습니다.')); return; }
    const lines = keysText.split('\n').filter((l) => l.trim());
    const ctx = {
      instances: sections.filter((s) => s['.type'] === 'dropbear'),
      ifaces: (net || []).filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback').map((s) => s['.name']),
      lines, keysOk,
      keys: lines.map(sshParseKey).filter(Boolean),
    };
    const list = ctx.instances.length ? ctx.instances : [null];
    body.replaceChildren(...list.map((s) => serverCard(ctx, s, list.length > 1)), keysCard(ctx));
  }

  /* ---------- SSH 서버 ---------- */

  function serverCard(ctx, sec, several) {
    const cur = sec || {};
    const wasOn = sshBool(cur.enable, true);
    const wasPw = sshBool(cur.PasswordAuth, true);
    const wasRootPw = sshBool(cur.RootPasswordAuth, true);
    const ifKey = cur.DirectInterface ? 'DirectInterface' : 'Interface';
    const enable = toggleEl(wasOn, 'SSH 서버 사용');
    const port = h('input', { type: 'text', inputmode: 'numeric', value: cur.Port || '22' });
    const iface = selectEl([['', '모든 인터페이스'], ...ctx.ifaces.map((n) => [n, IFACE_LABEL[n] ? `${IFACE_LABEL[n]} (${n})` : n])], cur[ifKey] || '');
    const idle = h('input', { type: 'text', inputmode: 'numeric', value: cur.IdleTimeout || '', placeholder: '비우면 끊지 않음' });
    const tries = h('input', { type: 'text', inputmode: 'numeric', value: cur.MaxAuthTries || '', placeholder: '3' });
    const pw = toggleEl(wasPw, '비밀번호 로그인 허용');
    const rootPw = toggleEl(wasRootPw, 'root 계정 비밀번호 로그인 허용');
    const gateway = toggleEl(sshBool(cur.GatewayPorts, false), '다른 기기에서 전달 포트로 접속 허용 (GatewayPorts)');
    const f = {
      port: formField('포트', port, '기본값 22'),
      iface: formField('접속을 받을 인터페이스', iface),
      idle: formField('입력이 없으면 끊는 시간 (초)', idle),
      tries: formField('로그인 시도 횟수', tries),
    };
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      Object.values(f).forEach((x) => x.setError(null));
      let bad = false;
      const p = port.value.trim();
      const [it, mt] = [idle.value.trim(), tries.value.trim()];
      if (!/^\d{1,5}$/.test(p) || +p < 1 || +p > 65535) { f.port.setError('1~65535 사이의 숫자를 입력해 주세요'); bad = true; }
      else if (ctx.instances.some((s) => s !== sec && sshBool(s.enable, true) && (s.Port || '22') === p)) { f.port.setError('다른 SSH 서버가 쓰는 포트입니다'); bad = true; }
      if (it && !/^\d{1,7}$/.test(it)) { f.idle.setError('숫자를 입력해 주세요'); bad = true; }
      if (mt && (!/^\d{1,3}$/.test(mt) || +mt < 1)) { f.tries.setError('1 이상의 숫자를 입력해 주세요'); bad = true; }
      const noPassword = (wasPw && !pw.input.checked) || (wasRootPw && !rootPw.input.checked);
      if (noPassword && (!ctx.keysOk || !ctx.keys.length)) {
        infoModal('SSH 설정', '공개 키가 등록되어 있지 않아 비밀번호 로그인을 끌 수 없습니다. 끄면 SSH로 접속할 수 없게 됩니다. 아래에서 공개 키를 먼저 등록해 주세요.', true);
        bad = true;
      }
      if (bad) return;

      const want = { Port: p, [ifKey]: iface.value, IdleTimeout: it, MaxAuthTries: mt };
      const flag = (k, input, was, on, off) => { if (input.checked !== was) want[k] = input.checked ? on : off; };
      flag('enable', enable.input, wasOn, '1', '0');
      flag('PasswordAuth', pw.input, wasPw, 'on', 'off');
      flag('RootPasswordAuth', rootPw.input, wasRootPw, 'on', 'off');
      flag('GatewayPorts', gateway.input, sshBool(cur.GatewayPorts, false), 'on', 'off');
      const changed = Object.fromEntries(Object.entries(want).filter(([k, v]) => v !== (k === 'Port' ? cur.Port || '22' : cur[k] || '')));
      if (!Object.keys(changed).length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }

      const warns = [];
      if (wasOn && !enable.input.checked) warns.push('SSH 서버를 끄면 SSH로 접속할 수 없습니다. 웹 관리 화면에서 다시 켤 수 있습니다.');
      if (changed.Port) warns.push(`앞으로 SSH 접속에는 ${p}번 포트를 써야 합니다.`);
      if (changed[ifKey] !== undefined && iface.value) warns.push(`'${iface.value}' 인터페이스로만 SSH에 접속할 수 있습니다.`);
      if (noPassword) warns.push('등록한 공개 키로 접속되는지 먼저 확인해 주세요.');
      if (warns.length && !await confirmDialog('SSH 설정 변경', [...warns, h('p', { class: 'msg warn-msg' }, 'SSH 접속이 끊겨도 웹 화면이 열려 있으면 자동으로 되돌아가지 않습니다.')], '적용')) return;

      const ops = sec
        ? [{ op: 'set', config: 'dropbear', section: sec['.name'], values: changed }]
        : [{ op: 'add', config: 'dropbear', type: 'dropbear', name: 'main', values: Object.fromEntries(Object.entries({ enable: '1', ...changed }).filter(([, v]) => v !== '')) }];
      applyBtn.disabled = true;
      const r = await runApply(ops);
      applyBtn.disabled = false;
      if (r === 'applied' || r === 'rolledback') reload();
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, several && sec ? `SSH 서버 (${sec['.name']})` : 'SSH 서버'),
        h('span', { class: 'pill ' + (wasOn ? 'ok' : 'off') }, wasOn ? '사용 중' : '꺼짐')),
      h('p', { class: 'muted' }, '터미널로 공유기에 접속하는 기능입니다. 인터넷 쪽 접속은 방화벽 규칙에서 따로 허용해야 합니다.'),
      enable.el,
      h('div', { class: 'fieldset' }, f.port.el, f.iface.el, f.idle.el, f.tries.el),
      pw.el, rootPw.el, gateway.el,
      h('div', { class: 'actions' }, applyBtn));
  }

  /* ---------- 공개 키 ---------- */

  async function writeKeys(lines) {
    try {
      await ubus('file', 'write', { path: SSH_KEYS_PATH, data: lines.length ? `${lines.join('\n')}\n` : '', mode: SSH_KEYS_MODE });
      return true;
    } catch (e) {
      if (await handleDenied(e) !== 'expired') infoModal('공개 키', '공개 키를 저장하지 못했습니다. 최신 wrtTIME가 설치되어 있는지 확인해 주세요.', true);
      return false;
    }
  }

  function keysCard(ctx) {
    if (!ctx.keysOk) {
      return h('section', { class: 'card form-card' }, h('div', { class: 'card-head' }, h('h3', null, '공개 키')),
        h('p', { class: 'msg' }, '공개 키를 읽을 권한이 없습니다. 최신 wrtTIME를 다시 설치해 주세요.'));
    }
    const passwordOff = ctx.instances.length > 0 && ctx.instances.every((s) => !sshBool(s.PasswordAuth, true) || !sshBool(s.RootPasswordAuth, true));
    const rows = ctx.lines.map((line) => ({ line, key: sshParseKey(line) })).filter((x) => x.key).map(({ line, key }) => h('tr', null,
      h('td', null, h('b', null, key.comment || '(설명 없음)')),
      h('td', null, key.type),
      h('td', { class: 'muted' }, `…${key.blob.slice(-20)}`),
      h('td', { class: 'actions-cell' }, h('button', { class: 'btn btn-ghost btn-small', type: 'button', onclick: async () => {
        if (passwordOff && ctx.keys.length === 1) {
          infoModal('공개 키 삭제', '비밀번호 로그인이 꺼져 있어 마지막 공개 키는 삭제할 수 없습니다. 비밀번호 로그인을 먼저 켜 주세요.', true);
          return;
        }
        if (!await confirmDialog('공개 키 삭제', `'${key.comment || key.type}' 공개 키를 삭제합니다.`, '삭제', true)) return;
        if (await writeKeys(ctx.lines.filter((l) => l !== line))) reload();
      } }, '삭제'))));

    const input = h('textarea', { rows: '4', spellcheck: 'false', placeholder: 'ssh-ed25519 AAAA... user@pc' });
    const fKey = formField('공개 키 추가', input, '공개 키 파일(.pub)의 내용을 붙여 넣으세요. 여러 개는 한 줄에 하나씩');
    const addBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '추가');
    addBtn.addEventListener('click', async () => {
      fKey.setError(null);
      const text = input.value.trim();
      if (/PRIVATE KEY/.test(text)) { fKey.setError('개인 키입니다. 개인 키는 입력하지 말고 공개 키(.pub)를 넣어 주세요'); return; }
      const added = text.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!added.length) { fKey.setError('공개 키를 입력해 주세요'); return; }
      const bad = added.find((l) => !sshParseKey(l));
      if (bad !== undefined) { fKey.setError(`공개 키 형식이 올바르지 않습니다: ${bad.slice(0, 40)}`); return; }
      const have = new Set(ctx.keys.map((k) => k.blob));
      const fresh = added.filter((l) => {
        const { blob } = sshParseKey(l);
        if (have.has(blob)) return false;
        have.add(blob);
        return true;
      });
      if (!fresh.length) { fKey.setError('이미 등록된 공개 키입니다'); return; }
      addBtn.disabled = true;
      const ok = await writeKeys([...ctx.lines, ...fresh]);
      addBtn.disabled = false;
      if (ok) reload();
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '공개 키')),
      h('p', { class: 'muted' }, '등록한 키를 가진 기기는 비밀번호 없이 root로 접속할 수 있습니다. 저장하면 바로 적용됩니다.'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ...['설명', '종류', '키 끝부분', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'muted' }, '등록된 공개 키가 없습니다.'))))),
      fKey.el, h('div', { class: 'actions' }, addBtn));
  }

  load();
  return () => { alive = false; };
}

PAGES['/ssh'] = sshPage;
