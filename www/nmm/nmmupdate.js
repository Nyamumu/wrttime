// wrtTIME 업데이트 (펌웨어 업그레이드 화면의 카드): 펌웨어는 그대로 두고 wrtTIME 화면만 GitHub Release의 새 버전으로 바꾼다.
// 공유기의 /usr/libexec/nmmwrt-update가 내려받고 sha256을 검사해 설치한다 (브라우저는 GitHub 파일을 직접 받을 수 없다).

const NMM_UPDATER = '/usr/libexec/nmmwrt-update';
const NMM_ERRORS = {
  'not-configured': '업데이트 저장소가 아직 정해지지 않았습니다.',
  download: 'GitHub에서 내려받지 못했습니다. 공유기의 인터넷 연결을 확인해 주세요.',
  checksum: '내려받은 파일의 검사값이 맞지 않아 설치하지 않았습니다.',
  archive: '내려받은 파일의 내용이 올바르지 않아 설치하지 않았습니다.',
  'bad-manifest': '업데이트 정보가 올바르지 않습니다.',
  tmp: '공유기에 임시 파일을 만들지 못했습니다.',
  copy: '파일을 설치하지 못했습니다. 저장 공간을 확인해 주세요.',
};

// check / install 실행. 결과 객체, 실패하면 { error }
async function nmmUpdater(cmd) {
  const res = await ubus('file', 'exec', { command: NMM_UPDATER, params: [cmd] }, state.sid, 120000);
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: 'bad-manifest' };
  }
}

// '1.0.14' -> 'v1.0.14'
function nmmVersionText(v) {
  return /^\d+\.\d+\.\d+$/.test(String(v || '')) ? `v${v}` : (v || '-');
}

// 첫 부팅 때 wrtTIME를 내려받아 설치하는 스크립트 (업그레이드 서버의 defaults, 40KB 제한 안).
// 설정 유지로 이미 wrtTIME가 있으면 아무것도 안 한다. 부팅 직후에는 인터넷이 없을 수 있어 30분 동안 다시 시도한다.
function nmmFirstBootScript(n) {
  return `#!/bin/sh
[ -f /www/nmm/VERSION ] && exit 0
A='https://raw.githubusercontent.com/${n.repo}/release/nmmwrt-${n.latest}.tar.gz'
B='https://github.com/${n.repo}/releases/download/v${n.latest}/nmmwrt.tar.gz'
S='${n.sha256}'
(
n=0
while [ $n -lt 120 ]; do
  n=$((n+1)); sleep 15
  for U in "$A" "$B"; do
    if uclient-fetch -q -T 20 -O /tmp/nmmwrt.tgz "$U" && [ "$(sha256sum /tmp/nmmwrt.tgz | cut -d' ' -f1)" = "$S" ]; then
      if [ -f /www/index.html ] && ! grep -q NMMWRT-ROOT /www/index.html; then cp /www/index.html /www/index.html.luci; fi
      tar -xzf /tmp/nmmwrt.tgz -C / && /etc/init.d/rpcd reload
      rm -f /tmp/nmmwrt.tgz
      exit 0
    fi
    rm -f /tmp/nmmwrt.tgz
  done
done
) </dev/null >/dev/null 2>&1 &
exit 0
`;
}

function nmmUpdateCard() {
  const result = h('div');
  const curText = h('span', null, '불러오는 중...');
  const checkBtn = h('button', { class: 'btn btn-inline', type: 'button' }, '업데이트 확인');
  fetch('VERSION', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((t) => { curText.textContent = nmmVersionText(t.trim()); })
    .catch(() => { curText.textContent = '-'; });

  const fail = (code) => result.replaceChildren(h('p', { class: 'msg' }, NMM_ERRORS[code] || `업데이트하지 못했습니다. (${code})`));

  async function install(info, btn) {
    if (!await confirmDialog('wrtTIME 업데이트', `wrtTIME를 ${nmmVersionText(info.latest)} 버전으로 바꿉니다. 공유기 설정과 인터넷 연결은 그대로입니다.`, '업데이트')) return;
    btn.disabled = true;
    checkBtn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, '내려받아 설치하는 중...'));
    let r;
    try {
      r = await nmmUpdater('install');
    } catch (e) {
      checkBtn.disabled = false;
      if (await handleDenied(e) !== 'expired') fail('download');
      return;
    }
    checkBtn.disabled = false;
    if (r.error) { fail(r.error); return; }
    result.replaceChildren(h('p', { class: 'msg ok-msg' }, '업데이트했습니다. 잠시 뒤 화면을 다시 불러옵니다.'));
    await sleep(4000);
    location.reload();
  }

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    result.replaceChildren(h('p', { class: 'muted' }, '확인하는 중...'));
    let r;
    try {
      r = await nmmUpdater('check');
    } catch (e) {
      checkBtn.disabled = false;
      if (await handleDenied(e) !== 'expired') fail('download');
      return;
    }
    checkBtn.disabled = false;
    if (r.error) { fail(r.error); return; }
    if (!r.update) {
      result.replaceChildren(h('p', { class: 'msg ok-msg' }, `최신 버전을 쓰고 있습니다. (${nmmVersionText(r.current)})`));
      return;
    }
    const go = h('button', { class: 'btn btn-inline', type: 'button' }, '지금 업데이트');
    go.addEventListener('click', () => install(r, go));
    result.replaceChildren(h('p', { class: 'msg ok-msg' }, `새 버전이 있습니다: ${nmmVersionText(r.latest)}`), h('div', { class: 'actions' }, go));
  });

  return h('section', { class: 'card form-card' },
    h('div', { class: 'card-head' }, h('h3', null, 'wrtTIME 업데이트')),
    h('p', { class: 'muted' }, '펌웨어는 그대로 두고 wrtTIME 화면만 새 버전으로 바꿉니다.'),
    kv([['지금 버전', curText]]),
    h('div', { class: 'actions' }, checkBtn), result);
}
