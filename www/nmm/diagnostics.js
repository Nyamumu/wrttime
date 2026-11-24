// 네트워크 진단 (시스템 관리): 공유기에서 ping / traceroute / nslookup을 실행해 결과를 보여 준다.
//   busybox 명령을 file exec로 실행한다 (셸을 거치지 않으므로 입력이 명령으로 해석되지 않는다).
//   명령 위치는 빌드마다 /bin, /usr/bin이 다를 수 있어 차례로 시도한다.
//   ACL은 이 화면이 쓰는 옵션 모양 그대로만 허용한다 (rootfs/usr/share/rpcd/acl.d/easyui.json).

const DIAG_TOOLS = {
  ping: {
    label: 'Ping',
    desc: '대상까지 닿는지와 응답 시간을 봅니다.',
    paths: ['/bin/ping', '/usr/bin/ping'],
    params: (host, fam) => ['-c', '4', '-W', '2', fam === '6' ? '-6' : '-4', host],
    timeoutMs: 30000,
  },
  traceroute: {
    label: 'Traceroute',
    desc: '대상까지 가는 경로에서 어디까지 닿고 어디서 막히는지 봅니다. 30초쯤 걸릴 수 있습니다.',
    paths: ['/usr/bin/traceroute', '/bin/traceroute'],
    params: (host, fam) => ['-n', '-q', '1', '-w', '2', '-m', '20', fam === '6' ? '-6' : '-4', host],
    timeoutMs: 90000,
  },
  nslookup: {
    label: 'DNS 조회 (nslookup)',
    desc: '도메인 이름이 IP 주소로 제대로 바뀌는지 봅니다.',
    paths: ['/usr/bin/nslookup', '/bin/nslookup'],
    params: (host) => [host],
    timeoutMs: 30000,
  },
};
const DIAG_PRESETS = ['8.8.8.8', '1.1.1.1', 'naver.com', 'google.com'];

// 도메인 이름, IPv4, IPv6만 받는다. '-'로 시작하면 옵션으로 읽히므로 막는다.
function isDiagTarget(s) {
  if (!s || s.length > 253 || s.startsWith('-')) return false;
  if (isIPv4(s)) return true;
  if (/^[0-9a-fA-F:]+$/.test(s) && s.includes(':')) return true;
  return /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(s);
}

// 첫 번째로 있는 명령으로 실행한다. 명령이 없으면 rpcd는 [4](NOT_FOUND)를 준다.
async function diagRun(tool, host, fam) {
  const t = DIAG_TOOLS[tool];
  let last = null;
  for (const command of t.paths) {
    try {
      return await ubus('file', 'exec', { command, params: t.params(host, fam) }, state.sid, t.timeoutMs);
    } catch (e) {
      last = e;
      if (e instanceof RpcError && e.code === UBUS_NOT_FOUND) continue;
      throw e;
    }
  }
  throw last;
}

function diagnosticsPage(root) {
  let alive = true;
  const tool = selectEl(Object.entries(DIAG_TOOLS).map(([k, t]) => [k, t.label]), 'ping');
  const fam = selectEl([['4', 'IPv4'], ['6', 'IPv6']], '4');
  const target = h('input', { type: 'text', value: '8.8.8.8', spellcheck: 'false', autocomplete: 'off', placeholder: '예: 8.8.8.8, naver.com' });
  const fTool = formField('도구', tool);
  const fFam = formField('주소 종류', fam);
  const fTarget = formField('대상', target);
  const desc = h('p', { class: 'muted' });
  const out = h('pre', { class: 'apk-log diag-out', hidden: true });
  const runBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '실행');
  const presets = h('div', { class: 'chips' }, DIAG_PRESETS.map((p) =>
    h('button', { class: 'chip', type: 'button', onclick: () => { target.value = p; fTarget.setError(null); } }, p)));

  const sync = () => {
    desc.textContent = DIAG_TOOLS[tool.value].desc;
    fFam.el.hidden = tool.value === 'nslookup';
  };
  tool.addEventListener('change', sync);
  sync();

  async function run() {
    fTarget.setError(null);
    const host = target.value.trim();
    if (!isDiagTarget(host)) { fTarget.setError('도메인 이름이나 IP 주소를 입력해 주세요.'); return; }
    runBtn.disabled = true;
    out.hidden = false;
    out.classList.remove('apk-fail');
    out.textContent = `${DIAG_TOOLS[tool.value].label} 실행 중입니다...`;
    try {
      const r = await diagRun(tool.value, host, fam.value);
      if (!alive) return;
      const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      out.textContent = text || (r.code === 0 ? '(출력 없음)' : `실패했습니다. (코드 ${r.code})`);
      if (r.code !== 0) out.classList.add('apk-fail');
    } catch (e) {
      if (!alive) return;
      if (await handleDenied(e) === 'expired') return;
      out.classList.add('apk-fail');
      out.textContent = e instanceof RpcError && e.code === UBUS_PERMISSION_DENIED
        ? '권한이 없습니다. 최신 wrtTIME를 다시 설치해 주세요.'
        : e instanceof RpcError && e.code === UBUS_NOT_FOUND
          ? '공유기에 이 명령이 없습니다.'
          : `실행하지 못했습니다. 시간이 오래 걸려 응답을 놓쳤을 수 있습니다.\n(${e.message || e})`;
    }
    runBtn.disabled = false;
  }
  runBtn.addEventListener('click', run);
  target.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') run(); });

  root.append(pageTitle('네트워크 진단'),
    h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '공유기에서 실행')),
      desc,
      h('div', { class: 'fieldset' }, fTool.el, fFam.el, fTarget.el),
      presets,
      h('div', { class: 'actions' }, runBtn),
      out));
  return () => { alive = false; };
}

PAGES['/diagnostics'] = diagnosticsPage;
