// 시스템 관리: 기본 설정, 관리자 비밀번호, 펌웨어 업그레이드, 재시작/백업/초기화, 시스템 로그

const DEFAULT_LAN_IP = '192.168.1.1'; // 공장 초기화/설정 없이 업그레이드하면 이 주소로 돌아온다

// [zonename, POSIX TZ, 표시 이름]. 전체 목록은 LuCI 전용 데이터라 자주 쓰는 것만 둔다.
const TIMEZONES = [
  ['Asia/Seoul', 'KST-9', '서울 (UTC+9)'],
  ['Asia/Tokyo', 'JST-9', '도쿄 (UTC+9)'],
  ['Asia/Shanghai', 'CST-8', '베이징/상하이 (UTC+8)'],
  ['Asia/Taipei', 'CST-8', '타이베이 (UTC+8)'],
  ['Asia/Singapore', '<+08>-8', '싱가포르 (UTC+8)'],
  ['Asia/Bangkok', '<+07>-7', '방콕/하노이 (UTC+7)'],
  ['Asia/Kolkata', 'IST-5:30', '인도 (UTC+5:30)'],
  ['Asia/Dubai', '<+04>-4', '두바이 (UTC+4)'],
  ['Europe/London', 'GMT0BST,M3.5.0/1,M10.5.0', '런던'],
  ['Europe/Paris', 'CET-1CEST,M3.5.0,M10.5.0/3', '파리/베를린'],
  ['America/New_York', 'EST5EDT,M3.2.0,M11.1.0', '뉴욕'],
  ['America/Chicago', 'CST6CDT,M3.2.0,M11.1.0', '시카고'],
  ['America/Denver', 'MST7MDT,M3.2.0,M11.1.0', '덴버'],
  ['America/Los_Angeles', 'PST8PDT,M3.2.0,M11.1.0', '로스앤젤레스'],
  ['Australia/Sydney', 'AEST-10AEDT,M10.1.0,M4.1.0/3', '시드니'],
  ['UTC', 'GMT0', '협정 세계시 (UTC)'],
];

function fmtRouterTime(localEpoch) {
  // system.info의 localtime은 공유기 시간대가 이미 반영된 값이라 UTC로 찍으면 공유기 시각이 된다
  const d = new Date(localEpoch * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/* ---------- 기본 설정 ---------- */

function systemPage(root) {
  const body = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('기본 설정'), body);
  let alive = true;

  async function load() {
    let sections, info, devs, uhttpd, apkDb;
    try {
      [sections, info, devs, uhttpd, apkDb] = await Promise.all([uciSections('system'), ubus('system', 'info').catch(() => null),
        ubus('network.device', 'status').catch(() => ({})), uciSections('uhttpd').catch(() => null),
        ubus('file', 'read', { path: APK_DB }).then((d) => d.data, () => null), readBoard()]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (alive && text) body.replaceChildren(messageCard(text));
      return;
    }
    if (!alive) return;
    const sys = (sections || []).find((s) => s['.type'] === 'system');
    if (!sys) { body.replaceChildren(messageCard('시스템 설정을 찾을 수 없습니다.')); return; }
    // LED 네트워크 활동 표시에 고를 장치: 실제 포트/브리지/무선 장치 (lo 제외)
    const devNames = Object.keys(devs || {}).filter((n) => n !== 'lo').sort();
    const web = (uhttpd || []).find((s) => s['.type'] === 'uhttpd' && s['.name'] === 'main') || (uhttpd || []).find((s) => s['.type'] === 'uhttpd');
    render(sys, (sections || []).find((s) => s['.type'] === 'timeserver'), info, sections || [], devNames, web, apkDb);
  }

  // HTTPS: uhttpd의 listen_https(443 포트)와 redirect_https(HTTP -> HTTPS 자동 이동).
  // 자동 이동은 HTTPS로 접속한 상태에서만 켤 수 있다: HTTP 화면에서 켜면 적용 확인 요청까지 HTTPS로 넘어가
  // (인증서를 아직 받아들이지 않았으면) 확인하지 못하고 자동으로 되돌아간다. 같은 이유로 HTTPS 화면에서는 HTTPS를 끌 수 없다.
  function httpsCard(web, apkDb) {
    const head = h('div', { class: 'card-head' }, h('h3', null, 'HTTPS 보안 접속'));
    if (!web) return h('section', { class: 'card form-card' }, head, h('p', { class: 'muted' }, '웹 서버(uhttpd) 설정을 찾을 수 없습니다.'));
    const pkgs = apkDb == null ? null : parseApkDb(apkDb).map((p) => p.name);
    const hasTls = !pkgs || pkgs.some((n) => /^libustream-(mbedtls|openssl|wolfssl)/.test(n));
    const hasCertTool = !pkgs || pkgs.some((n) => /^(px5g|openssl-util)/.test(n));
    if (!hasTls || !hasCertTool) return missingPackageCard('libustream-mbedtls px5g-mbedtls', 'HTTPS', () => { if (alive) load(); });

    const listenOn = asList(web.listen_https).length > 0;
    const redirectOn = web.redirect_https === '1' || web.redirect_https === 'on';
    const onHttps = location.protocol === 'https:';
    const httpsUrl = `https://${location.hostname}${location.pathname}`;
    const listen = toggleEl(listenOn, 'HTTPS 접속 사용 (443 포트)');
    const redirect = toggleEl(redirectOn, 'HTTP로 접속하면 HTTPS로 자동 이동');
    listen.input.disabled = onHttps && listenOn;
    redirect.input.disabled = !onHttps && !redirectOn;
    const sync = () => {
      if (!listen.input.checked) redirect.input.checked = false;
      redirect.input.disabled = !listen.input.checked || (!onHttps && !redirectOn);
    };
    listen.input.addEventListener('change', sync);
    sync();
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      const values = {};
      if (listen.input.checked !== listenOn) values.listen_https = listen.input.checked ? ['0.0.0.0:443', '[::]:443'] : '';
      if (redirect.input.checked !== redirectOn) values.redirect_https = redirect.input.checked ? '1' : '0';
      if (!Object.keys(values).length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      applyBtn.disabled = true;
      const r = await runApply([{ op: 'set', config: 'uhttpd', section: web['.name'], values }]);
      applyBtn.disabled = false;
      if (r === 'applied' && values.listen_https) {
        infoModal('HTTPS 보안 접속', `이제 ${httpsUrl} 로 접속할 수 있습니다. 공유기가 직접 만든 인증서라 처음 접속할 때 브라우저에 보안 경고가 나오면 계속 진행을 눌러 주세요.`);
      }
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });
    return h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, 'HTTPS 보안 접속'),
        h('span', { class: 'pill ' + (listenOn ? 'ok' : 'off') }, listenOn ? (redirectOn ? 'HTTPS만 사용' : '사용 중') : '꺼짐')),
      h('p', { class: 'muted' }, '관리 화면과 주고받는 내용을 암호화합니다. 공유기가 직접 만든 인증서를 쓰므로 처음 접속할 때 브라우저에 보안 경고가 나올 수 있습니다.'),
      listen.el,
      onHttps && listenOn ? h('p', { class: 'muted' }, 'HTTPS로 접속한 상태에서는 HTTPS를 끌 수 없습니다. HTTP 주소로 접속해서 꺼 주세요.') : null,
      redirect.el,
      !onHttps && !redirectOn ? h('p', { class: 'muted' }, '자동 이동은 HTTPS 주소로 접속한 상태에서만 켤 수 있습니다. ',
        listenOn ? h('a', { href: httpsUrl }, 'HTTPS로 접속하기') : 'HTTPS 접속을 먼저 켜 주세요.') : null,
      h('div', { class: 'actions' }, applyBtn));
  }

  function render(sys, ntp, info, sections, devNames, web, apkDb) {
    const host = h('input', { type: 'text', value: sys.hostname || 'OpenWrt', spellcheck: 'false' });
    const zoneOpts = TIMEZONES.map(([z, , label]) => [z, label]);
    const zone = selectEl(zoneOpts, sys.zonename || 'UTC');
    const ntpT = toggleEl(!ntp || ntp.enabled !== '0', '인터넷 시간 서버로 시간 자동 맞추기 (NTP)');
    const fHost = formField('공유기 이름', host, '영문, 숫자, - (네트워크에 보이는 이름)');
    const fZone = formField('시간대', zone);
    const applyBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '적용');
    applyBtn.addEventListener('click', async () => {
      fHost.setError(null);
      const name = host.value.trim();
      if (!isHostname(name)) { fHost.setError('영문, 숫자, - 만 쓸 수 있고 -로 시작하거나 끝날 수 없습니다.'); return; }
      const ops = [];
      const vals = {};
      if (name !== (sys.hostname || '')) vals.hostname = name;
      if (zone.value !== (sys.zonename || 'UTC')) {
        const tz = TIMEZONES.find(([z]) => z === zone.value);
        vals.zonename = zone.value;
        vals.timezone = tz ? tz[1] : sys.timezone;
      }
      if (Object.keys(vals).length) ops.push({ op: 'set', config: 'system', section: sys['.name'], values: vals });
      if (ntp && (ntpT.input.checked ? '1' : '0') !== (ntp.enabled === '0' ? '0' : '1')) {
        ops.push({ op: 'set', config: 'system', section: ntp['.name'], values: { enabled: ntpT.input.checked ? '1' : '0' } });
      }
      if (!ops.length) { infoModal('설정 적용', '바뀐 내용이 없습니다.'); return; }
      applyBtn.disabled = true;
      const r = await runApply(ops);
      applyBtn.disabled = false;
      if (alive && (r === 'applied' || r === 'rolledback')) load();
    });
    body.replaceChildren(
      card('현재 상태', kv([
        ['공유기 시각', info && info.localtime ? fmtRouterTime(info.localtime) : '-'],
        ['동작 시간', info ? fmtUptime(info.uptime || 0) : '-'],
      ])),
      h('section', { class: 'card form-card' },
        h('div', { class: 'card-head' }, h('h3', null, '이름과 시간')),
        h('div', { class: 'fieldset' }, fHost.el, fZone.el),
        ntp ? ntpT.el : null,
        h('div', { class: 'actions' }, applyBtn)),
      httpsCard(web, apkDb),
      ledCard(sections, devNames, () => { if (alive) load(); }),
    );
  }

  load();
  return () => { alive = false; };
}

/* ---------- 관리자 비밀번호 ---------- */

function passwordPage(root) {
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const f1 = formField('새 비밀번호', pw1, '8자 이상');
  const f2 = formField('새 비밀번호 확인', pw2);
  const save = h('button', { class: 'btn btn-inline', type: 'button' }, '변경');
  save.addEventListener('click', async () => {
    f1.setError(pw1.value.length < 8 ? '8자 이상 입력해 주세요.' : null);
    f2.setError(pw1.value !== pw2.value ? '두 비밀번호가 다릅니다.' : null);
    if (pw1.value.length < 8 || pw1.value !== pw2.value) return;
    save.disabled = true;
    try {
      await ubus('rpc-sys', 'password_set', { user: 'root', password: pw1.value });
      pw1.value = '';
      pw2.value = '';
      if (state.banner) state.banner.replaceChildren();
      infoModal('비밀번호 변경 완료', '다음 로그인부터 새 비밀번호를 사용하세요.');
    } catch (e) {
      if (await handleDenied(e) !== 'expired') infoModal('비밀번호 변경', '비밀번호를 바꾸지 못했습니다.', true);
    }
    save.disabled = false;
  });
  root.append(pageTitle('관리자 비밀번호'),
    h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '비밀번호 변경')),
      h('p', { class: 'muted' }, '이 관리 화면과 SSH(root) 로그인에 함께 쓰입니다.'),
      h('div', { class: 'fieldset' }, f1.el, f2.el),
      h('div', { class: 'actions' }, save)));
}

/* ---------- 파일 업로드 (cgi-io) ---------- */

// cgi-io의 cgi-upload로 공유기 /tmp에 파일을 올린다. onProgress(0~100)
function uploadFile(file, path, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('sessionid', state.sid);
    fd.append('filename', path);
    fd.append('filemode', '0600');
    fd.append('filedata', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/cgi-bin/cgi-upload');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status === 200) {
        // 실제 cgi-io: 거부해도 HTTP 200에 {"message": ..., "failure": [...]}를 준다 (25.12.6 확인)
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* 아래에서 실패 처리 */ }
        if (body && typeof body.size === 'number' && !body.failure) resolve(body);
        else reject(new ApplyError('파일을 올리지 못했습니다. ' + ((body && body.message) ? `(${body.message})` : '')));
      } else if (xhr.status === 404) {
        reject(new ApplyError('파일 올리기 기능(cgi-io 패키지)이 공유기에 없습니다.'));
      } else if (xhr.status === 403) {
        reject(new ApplyError('파일을 올릴 권한이 없습니다. 다시 로그인하거나 ACL을 확인해 주세요.'));
      } else {
        reject(new ApplyError(`파일을 올리지 못했습니다. (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApplyError('파일을 올리는 중 연결이 끊겼습니다.'));
    xhr.send(fd);
  });
}

function fileButton(accept, label) {
  const input = h('input', { type: 'file', accept, hidden: true });
  const name = h('span', { class: 'muted' }, '선택한 파일 없음');
  const btn = h('button', { class: 'btn btn-ghost btn-inline', type: 'button', onclick: () => input.click() }, label);
  input.addEventListener('change', () => {
    name.textContent = input.files[0] ? `${input.files[0].name} (${Math.round(input.files[0].size / 1024)} KB)` : '선택한 파일 없음';
  });
  return { input, el: h('div', { class: 'status-line', style: 'margin-bottom:12px' }, btn, name, input) };
}

/* ---------- 펌웨어 업그레이드 ---------- */

function firmwarePage(root) {
  const cur = h('span', { class: 'muted' }, '불러오는 중...');
  ubus('system', 'board').then((b) => {
    cur.replaceWith(kv([
      ['모델', b.model || b.board_name || '-'],
      ['현재 펌웨어', b.release ? b.release.description : '-'],
    ]));
  }).catch(() => { cur.textContent = '정보를 불러오지 못했습니다.'; });

  const pick = fileButton('.bin,.img,.itb,.gz', '펌웨어 파일 선택');
  const status = h('div');
  const startBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '올리고 검사');
  startBtn.addEventListener('click', () => {
    const file = pick.input.files[0];
    if (!file) { status.replaceChildren(h('p', { class: 'msg' }, '펌웨어 파일을 먼저 선택해 주세요.')); return; }
    uploadAndCheck(file);
  });

  // 파일(직접 고른 것 또는 업그레이드 확인에서 받은 것)을 올려 검사하고, 통과하면 '설정 유지' + 시작 버튼을 보여 준다
  async function uploadAndCheck(file) {
    startBtn.disabled = true;
    const prog = h('p', null, '올리는 중... 0%');
    status.replaceChildren(prog);
    let check;
    try {
      await uploadFile(file, '/tmp/firmware.bin', (p) => { prog.textContent = `올리는 중... ${p}%`; });
      prog.textContent = '파일을 검사하는 중...';
      check = await ubus('system', 'validate_firmware_image', { path: '/tmp/firmware.bin' }, undefined, 60000);
    } catch (e) {
      startBtn.disabled = false;
      if (await handleDenied(e) === 'expired') return;
      status.replaceChildren(h('p', { class: 'msg' }, e instanceof ApplyError ? e.message : '파일을 검사하지 못했습니다.'));
      return;
    }
    startBtn.disabled = false;
    if (!check || !check.valid) {
      const failed = Object.entries((check && check.tests) || {}).filter(([, ok]) => !ok).map(([k]) => k).join(', ');
      status.replaceChildren(h('p', { class: 'msg' },
        '이 공유기에 맞는 펌웨어가 아닙니다. 모델에 맞는 sysupgrade 파일인지 확인해 주세요.' + (failed ? ` (실패한 검사: ${failed})` : '')));
      return;
    }
    const keep = toggleEl(check.allow_backup !== false, '현재 설정 유지 (끄면 공장 초기 상태로 업그레이드)');
    const go = h('button', { class: 'btn btn-danger btn-inline', type: 'button' }, '업그레이드 시작');
    go.addEventListener('click', async () => {
      const ok = await confirmDialog('펌웨어 업그레이드', [
        '업그레이드에는 몇 분이 걸리고 그동안 인터넷이 끊깁니다.',
        h('p', { class: 'msg' }, '진행 중에는 절대로 전원을 끄지 마세요. 공유기가 고장 날 수 있습니다.'),
      ], '업그레이드', true);
      if (!ok) return;
      try {
        await ubus('rpc-sys', 'upgrade_start', { keep: keep.input.checked }, undefined, 15000);
      } catch (e) {
        // 업그레이드가 시작되면 응답 전에 연결이 끊길 수 있다. 권한 오류만 따로 본다.
        if (e instanceof RpcError) { infoModal('펌웨어 업그레이드', '업그레이드를 시작하지 못했습니다.', true); return; }
      }
      waitForRouter('펌웨어 업그레이드 중', '공유기가 새 펌웨어를 쓰고 다시 켜지는 중입니다. 전원을 끄지 마세요. (보통 3~5분)',
        keep.input.checked ? location.hostname : DEFAULT_LAN_IP);
    });
    status.replaceChildren(
      h('p', { class: 'msg ok-msg' }, '검사를 통과했습니다. 이 공유기에 맞는 펌웨어입니다.'),
      keep.el, h('div', { class: 'actions' }, go));
    status.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  root.append(pageTitle('펌웨어 업그레이드'),
    card('현재 상태', cur),
    nmmUpdateCard(),
    asuCard((file) => uploadAndCheck(file)),
    h('section', { class: 'card form-card' },
      h('div', { class: 'card-head' }, h('h3', null, '새 펌웨어 올리기')),
      h('p', { class: 'muted' }, 'OpenWrt 다운로드 페이지에서 이 모델의 sysupgrade 파일을 받아 선택하세요.'),
      pick.el, h('div', { class: 'actions' }, startBtn), status));
}

/* ---------- 재시작 / 백업 / 초기화 ---------- */

function maintenancePage(root) {
  const reboot = h('button', { class: 'btn btn-inline', type: 'button' }, '재시작');
  reboot.addEventListener('click', async () => {
    if (!await confirmDialog('공유기 재시작', '공유기를 다시 시작합니다. 1~2분 동안 인터넷이 끊깁니다.', '재시작')) return;
    try {
      await ubus('system', 'reboot', {}, undefined, 8000);
    } catch (e) {
      if (e instanceof RpcError) { infoModal('공유기 재시작', '재시작하지 못했습니다.', true); return; }
    }
    waitForRouter('재시작 중', '공유기가 다시 켜지는 중입니다. 켜지면 자동으로 이 화면으로 돌아옵니다.');
  });

  const backup = h('button', { class: 'btn btn-inline', type: 'button' }, '백업 파일 받기');
  backup.addEventListener('click', async () => {
    backup.disabled = true;
    try {
      const res = await fetch('/cgi-bin/cgi-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'sessionid=' + encodeURIComponent(state.sid),
      });
      if (!res.ok) throw new ApplyError(res.status === 404 ? '백업 기능(cgi-io 패키지)이 공유기에 없습니다.' : `백업 파일을 만들지 못했습니다. (HTTP ${res.status})`);
      const blob = await res.blob();
      const a = h('a', { href: URL.createObjectURL(blob), download: `backup-${new Date().toISOString().slice(0, 10)}.tar.gz` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      infoModal('설정 백업', e instanceof ApplyError ? e.message : '백업 파일을 받지 못했습니다.', true);
    }
    backup.disabled = false;
  });

  const pick = fileButton('.tar.gz,.tgz', '백업 파일 선택');
  const restore = h('button', { class: 'btn btn-inline', type: 'button' }, '복원');
  restore.addEventListener('click', async () => {
    const file = pick.input.files[0];
    if (!file) { infoModal('설정 복원', '백업 파일을 먼저 선택해 주세요.', true); return; }
    if (!await confirmDialog('설정 복원', '지금 설정을 백업 파일의 설정으로 바꾸고 공유기를 다시 시작합니다.', '복원', true)) return;
    restore.disabled = true;
    try {
      await uploadFile(file, '/tmp/backup.tar.gz');
      const r = await ubus('file', 'exec', { command: '/sbin/sysupgrade', params: ['--restore-backup', '/tmp/backup.tar.gz'] }, undefined, 60000);
      if (r && r.code) throw new ApplyError('올바른 백업 파일이 아닙니다.');
      ubus('system', 'reboot', {}, undefined, 8000).catch(() => {});
    } catch (e) {
      restore.disabled = false;
      if (await handleDenied(e) === 'expired') return;
      infoModal('설정 복원', e instanceof ApplyError ? e.message : '설정을 복원하지 못했습니다.', true);
      return;
    }
    waitForRouter('복원 후 재시작 중', '백업한 설정으로 다시 켜는 중입니다. 내부 주소가 바뀌었다면 새 주소로 직접 접속해 주세요.');
  });

  const reset = h('button', { class: 'btn btn-danger btn-inline', type: 'button' }, '공장 초기화');
  reset.addEventListener('click', async () => {
    const ok = await confirmDialog('공장 초기화', [
      '모든 설정(인터넷, 무선, 비밀번호 등)이 지워지고 처음 상태로 돌아갑니다.',
      h('p', { class: 'msg' }, `초기화 후 공유기 주소는 ${DEFAULT_LAN_IP}, 관리자 비밀번호는 없음, 무선은 꺼진 상태가 됩니다.`),
    ], '초기화', true);
    if (!ok) return;
    try {
      await ubus('rpc-sys', 'factory', {}, undefined, 15000);
    } catch (e) {
      if (e instanceof RpcError) { infoModal('공장 초기화', '초기화하지 못했습니다.', true); return; }
    }
    waitForRouter('초기화 중', `공유기를 처음 상태로 되돌리고 다시 켜는 중입니다. 켜지면 http://${DEFAULT_LAN_IP}/ 로 접속하세요.`, DEFAULT_LAN_IP);
  });

  root.append(pageTitle('재시작 / 백업 / 초기화'),
    card('공유기 재시작', h('p', { class: 'muted' }, '인터넷이 느리거나 이상할 때 다시 시작해 보세요.'), h('div', { class: 'actions' }, reboot)),
    card('설정 백업', h('p', { class: 'muted' }, '지금 설정을 파일로 받아 둡니다. 비밀번호 등 민감한 정보가 들어 있으니 안전하게 보관하세요.'), h('div', { class: 'actions' }, backup)),
    card('설정 복원', h('p', { class: 'muted' }, '받아 둔 백업 파일로 설정을 되돌립니다. 같은 모델에서 만든 백업만 쓰세요.'), pick.el, h('div', { class: 'actions' }, restore)),
    card('공장 초기화', h('p', { class: 'muted' }, '모든 설정을 지우고 처음 상태로 되돌립니다.'), h('div', { class: 'actions' }, reset)));
}

/* ---------- 시스템 로그 ---------- */

const LOG_LEVELS = [['7', '전체'], ['4', '경고 이상'], ['3', '오류만']];

function logPage(root) {
  const level = selectEl(LOG_LEVELS, '7');
  const search = h('input', { type: 'text', placeholder: '검색어' });
  const box = h('pre', { class: 'logbox' }, '불러오는 중...');
  let entries = [];
  const p2 = (n) => String(n).padStart(2, '0');
  const show = () => {
    const max = +level.value;
    const q = search.value.trim().toLowerCase();
    const lines = entries
      .filter((e) => (e.priority & 7) <= max)
      .filter((e) => !q || String(e.msg).toLowerCase().includes(q))
      .map((e) => {
        const d = new Date(e.time);
        return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}  ${e.msg}`;
      });
    box.textContent = lines.length ? lines.join('\n') : '표시할 로그가 없습니다.';
    box.scrollTop = box.scrollHeight;
  };
  const load = async () => {
    try {
      const d = await ubus('log', 'read', { lines: 500, stream: false, oneshot: true }, undefined, 15000);
      entries = (d && d.log) || [];
      show();
    } catch (e) {
      const text = await loadFailureText(e);
      if (text) box.textContent = text;
    }
  };
  level.addEventListener('change', show);
  search.addEventListener('input', show);
  const refresh = h('button', { class: 'btn btn-inline', type: 'button', onclick: load }, '새로고침');
  root.append(pageTitle('시스템 로그'),
    h('section', { class: 'card', style: 'max-width:none' },
      h('div', { class: 'fieldset' }, formField('보기', level).el, formField('검색', search).el),
      box, h('div', { class: 'actions' }, refresh)));
  load();
}

// 시스템 정보: 공유기 모델, 펌웨어, 커널, 시각, 가동 시간, 평균 부하. 5초마다 갱신한다.
function systemInfoPage(root) {
  const box = card('시스템 정보', h('span', { class: 'muted' }, '불러오는 중...'));
  root.append(pageTitle('시스템 정보'), box);
  let stopped = false;
  let timer = null;
  let nmmVersion = '';
  fetch('VERSION', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((t) => { nmmVersion = /^\d+\.\d+\.\d+$/.test(t.trim()) ? t.trim() : ''; }).catch(() => {});

  async function refresh() {
    let board, info;
    try {
      [board, info] = await Promise.all([ubus('system', 'board'), ubus('system', 'info')]);
    } catch (e) {
      const text = await loadFailureText(e);
      if (!stopped && text) box.replaceChildren(h('div', { class: 'card-head' }, h('h3', null, '시스템 정보')), h('span', { class: 'muted' }, text));
      return;
    }
    if (stopped) return;
    const rel = board.release || {};
    const firmware = rel.description || [rel.distribution, rel.version, rel.revision].filter(Boolean).join(' ');
    box.replaceChildren(h('div', { class: 'card-head' }, h('h3', null, '시스템 정보')), kv([
      ['호스트 이름', board.hostname || '-'],
      ['모델', board.model || '-'],
      ['아키텍처', board.system || '-'],
      ['대상 플랫폼', rel.target || '-'],
      ['펌웨어 버전', firmware || '-'],
      ['wrtTIME 버전', nmmVersion || '-'],
      ['커널 버전', board.kernel || '-'],
      ['공유기 시각', info.localtime ? fmtRouterTime(info.localtime) : '-'],
      ['가동 시간', info.uptime != null ? fmtUptime(info.uptime) : '-'],
      ['평균 부하 (1분, 5분, 15분)', (info.load || []).map((n) => (n / 65536).toFixed(2)).join(', ') || '-'],
    ]));
  }

  async function tick() {
    if (!document.hidden) await refresh();
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  }
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}

PAGES['/sysinfo'] = systemInfoPage;
PAGES['/system'] = systemPage;
PAGES['/password'] = passwordPage;
PAGES['/firmware'] = firmwarePage;
PAGES['/maintenance'] = maintenancePage;
PAGES['/log'] = logPage;
