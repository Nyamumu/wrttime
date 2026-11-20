// 업그레이드 확인 (펌웨어 업그레이드 화면의 카드): OpenWrt Attended Sysupgrade(ASU) 서버로 새 펌웨어를 확인하고,
// 지금 설치된 패키지를 넣은 펌웨어를 서버에서 만들어 받는다. LuCI의 luci-app-attendedsysupgrade와 같은 방식.
//   서버 주소: uci attendedsysupgrade.server.url (없으면 https://sysupgrade.openwrt.org)
//   새 버전: GET {서버}/api/v1/overview 의 latest, 같은 버전이면 GET /api/v1/revision/{버전}/{target} 으로 새 빌드인지
//   만들기: POST /api/v1/build {profile, target, version, packages, diff_packages}, 202면 GET /api/v1/build/{hash}로 기다림
//   받기: {서버}/store/{bin_dir}/{sysupgrade 이미지} -> onImage(File) (펌웨어 화면이 올리고 검사한다)
// 브라우저가 서버에 직접 연결한다 (서버가 CORS를 허용). 패키지 목록: rpc-sys packagelist {all:false} (직접 설치한 패키지)

const ASU_DEFAULT = 'https://sysupgrade.openwrt.org';

// '25.12.6' / '24.10.0-rc1' -> 비교용 숫자 배열. SNAPSHOT은 null
function asuVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/.exec(String(v || ''));
  if (!m) return null;
  return [+m[1], +m[2], +m[3], m[4] ? +m[4] : 999]; // 정식은 rc보다 뒤
}

function asuNewer(a, b) {
  const x = asuVer(a);
  const y = asuVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function asuJson(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    let body = null;
    try { body = await res.json(); } catch { /* 본문 없음 */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function asuCard(onImage) {
  const info = h('div', null, h('span', { class: 'muted' }, '불러오는 중...'));
  const result = h('div');
  const checkBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '새 펌웨어 확인');
  const card = h('section', { class: 'card form-card' },
    h('div', { class: 'card-head' }, h('h3', null, '업그레이드 확인')),
    h('p', { class: 'muted' }, 'OpenWrt 공식 업그레이드 서버에서 새 펌웨어가 있는지 확인합니다. 새 펌웨어는 지금 설치된 패키지를 그대로 넣어 서버에서 만들어 받습니다.'),
    info, h('div', { class: 'actions' }, checkBtn), result);

  let board = null;
  let server = ASU_DEFAULT;
  (async () => {
    try {
      const [b, asu] = await Promise.all([ubus('system', 'board'), uciSections('attendedsysupgrade').catch(() => null)]);
      board = b;
      const s = (asu || []).find((x) => x['.type'] === 'server');
      if (s && s.url) server = s.url.replace(/\/+$/, '');
      const r = b.release || {};
      info.replaceChildren(kv([
        ['지금 버전', `${r.distribution || 'OpenWrt'} ${r.version || '?'} (${r.revision || '-'})`],
        ['보드 / 타깃', `${b.board_name || '-'} / ${r.target || '-'}`],
        ['업그레이드 서버', server],
      ]));
    } catch {
      info.replaceChildren(h('p', { class: 'msg' }, '공유기 정보를 읽지 못했습니다.'));
      checkBtn.disabled = true;
    }
  })();

  const msg = (text, cls = '') => h('p', { class: `msg ${cls}`.trim() }, text);

  checkBtn.addEventListener('click', async () => {
    if (!board) return;
    const r = board.release || {};
    checkBtn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, '확인하는 중...'));
    try {
      const ov = await asuJson(`${server}/api/v1/overview`);
      if (ov.status !== 200 || !ov.body) throw new Error(`서버 응답 ${ov.status}`);
      const latest = (ov.body.latest || []).filter((v) => asuVer(v));
      const newer = latest.filter((v) => asuNewer(v, r.version)).sort((a, b) => (asuNewer(a, b) ? -1 : 1));
      if (newer.length) {
        // replaceChildren은 null을 글자 "null"로 넣으므로 있는 것만 넘긴다
        result.replaceChildren(...[msg(`새 버전이 있습니다: OpenWrt ${newer[0]}`, 'ok-msg'),
          newer.length > 1 ? h('p', { class: 'muted' }, `다른 새 버전: ${newer.slice(1).join(', ')}`) : null,
          buildBox(newer[0])].filter(Boolean));
        return;
      }
      // 같은 버전의 새 빌드(보안 수정 등)가 있는지
      const rev = await asuJson(`${server}/api/v1/revision/${encodeURIComponent(r.version)}/${r.target}`);
      if (rev.status === 200 && rev.body && rev.body.revision && rev.body.revision !== r.revision) {
        result.replaceChildren(msg(`같은 버전(${r.version})의 새 빌드가 있습니다: ${rev.body.revision}`, 'ok-msg'), buildBox(r.version));
        return;
      }
      result.replaceChildren(msg(`최신 펌웨어를 쓰고 있습니다. (OpenWrt ${r.version})`, 'ok-msg'),
        h('details', null, h('summary', { class: 'muted' }, '지금 버전으로 다시 만들기'), buildBox(r.version)));
    } catch (e) {
      result.replaceChildren(msg(`업그레이드 서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요. (${e.name === 'AbortError' ? '시간 초과' : e.message})`));
    } finally {
      checkBtn.disabled = false;
    }
  });

  // 펌웨어 만들기 + 받기
  function buildBox(version) {
    const go = h('button', { class: 'btn btn-inline', type: 'button' }, `${version} 펌웨어 만들기`);
    const log = h('div');
    go.addEventListener('click', async () => {
      if (!await confirmDialog('펌웨어 만들기', [
        `OpenWrt ${version} 펌웨어를 업그레이드 서버에서 만듭니다. 몇 분 걸릴 수 있습니다.`,
        h('p', { class: 'muted' }, '이 공유기의 모델과 직접 설치한 패키지 목록이 서버로 보내집니다. 만든 뒤에는 공유기에 올려 검사하고, 업그레이드는 다음 단계에서 한 번 더 확인합니다.'),
      ], '만들기')) return;
      go.disabled = true;
      try {
        await buildAndFetch(version, log);
      } catch (e) {
        log.replaceChildren(msg(e.message || '펌웨어를 만들지 못했습니다.'));
      }
      go.disabled = false;
    });
    return h('div', null, h('div', { class: 'actions' }, go), log);
  }

  async function buildAndFetch(version, log) {
    const r = board.release || {};
    const say = (t) => log.replaceChildren(h('p', { class: 'muted' }, t));
    say('설치된 패키지 목록을 읽는 중...');
    const pk = await ubus('rpc-sys', 'packagelist', { all: false });
    const packages = Object.keys((pk && pk.packages) || {}).sort();
    const req = {
      profile: (board.board_name || '').replace(/,/g, '_'),
      target: r.target,
      version,
      packages,
      diff_packages: true,
      client: 'wrttime/1.0',
    };
    // 첫 부팅 때 wrtTIME를 내려받는 스크립트를 펌웨어에 넣는다. 확인이 안 되면 wrtTIME 없이 만들지 사용자에게 묻는다.
    say('wrtTIME 최신 버전을 확인하는 중...');
    const nmm = await nmmUpdater('check').catch(() => ({ error: 'download' }));
    if (nmm.error) {
      const go = await confirmDialog('wrtTIME 포함', `wrtTIME 최신 버전을 확인하지 못했습니다. (${NMM_ERRORS[nmm.error] || nmm.error}) wrtTIME 내려받기 없이 펌웨어를 만들까요? "설정 유지"로 업그레이드하면 지금 wrtTIME는 그대로 남습니다.`, '그대로 만들기');
      if (!go) { log.replaceChildren(); return; }
    } else {
      req.defaults = nmmFirstBootScript(nmm);
    }
    say(`서버에 요청하는 중... (패키지 ${packages.length}개${req.defaults ? ', wrtTIME 포함' : ''})`);
    let res = await asuJson(`${server}/api/v1/build`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
    }, 60000);
    const started = Date.now();
    while (res.status === 202) {
      const b = res.body || {};
      const pos = b.queue_position != null ? `대기 순서 ${b.queue_position}` : (b.imagebuilder_status || b.status || '만드는 중');
      say(`서버에서 펌웨어를 만드는 중... (${pos}, ${Math.round((Date.now() - started) / 1000)}초)`);
      if (Date.now() - started > 15 * 60 * 1000) throw new Error('15분이 지나도 펌웨어가 완성되지 않았습니다. 잠시 뒤 다시 시도해 주세요.');
      await sleep(5000);
      res = await asuJson(`${server}/api/v1/build/${encodeURIComponent(b.request_hash)}`, {}, 30000);
    }
    if (res.status !== 200 || !res.body) {
      const detail = (res.body && (res.body.detail || res.body.message)) || `서버 응답 ${res.status}`;
      const stderr = res.body && res.body.stderr ? `\n${String(res.body.stderr).slice(-1500)}` : '';
      throw new Error(`펌웨어를 만들지 못했습니다: ${detail}${stderr}`);
    }
    const out = res.body;
    const images = out.images || [];
    const img = images.find((i) => i.type === 'sysupgrade' && i.filesystem === (board.rootfs_type || 'squashfs'))
      || images.find((i) => i.type === 'sysupgrade');
    if (!img) throw new Error('만든 결과에 sysupgrade 파일이 없습니다.');
    const url = `${server}/store/${out.bin_dir}/${img.name}`;
    say(`펌웨어를 받는 중... (${img.name})`);
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`펌웨어를 받지 못했습니다 (HTTP ${dl.status}).`);
    const blob = await dl.blob();
    log.replaceChildren(...[h('p', { class: 'msg ok-msg' }, `받았습니다: ${img.name} (${(blob.size / 1048576).toFixed(1)} MiB). 공유기에 올려 검사합니다.`),
      img.sha256 ? h('p', { class: 'muted' }, `SHA256 ${img.sha256}`) : null].filter(Boolean));
    onImage(new File([blob], img.name, { type: 'application/octet-stream' }));
  }

  return card;
}
