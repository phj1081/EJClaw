#!/usr/bin/env python3
"""EJClaw status board — 구 EJClaw Status 대시보드 후계 (EJClaw 소유, 헤르메스 비의존).

#status 채널의 메시지 1개를 편집. 오너 봇(NanoClaw .env의 DISCORD_BOT_TOKEN)으로 게시.
구독 사용량은 CLIProxyAPI Management API의 auth-files/api-call 경로로만 조회하며,
OAuth 파일·토큰을 직접 읽지 않는다. 관리 키는 1Password에서 런타임 조회한다.
구 unified-dashboard.ts 파리티:
- 사용량 테이블 (5h/7d, 5칸 바, 리셋 sub-line, 모바일 고정폭)
- 에이전트 상태 (활성 컨테이너 / 등록 그룹)
- 서버 블록 (CPU/Load/Memory/Disk/Uptime)
Tribunal 소속이던 모델구성(Owner/Reviewer/Arbiter/MoA) 블록은 은퇴로 제외.

systemd user timer(ejclaw-status-board.timer)가 5분마다 실행. 침묵=정상.
"""
import base64, json, os, re, shutil, subprocess, urllib.request, urllib.error, datetime, pathlib, time

CHANNEL_ID = "1481063226224672930"  # #status
NANOCLAW_ENV = pathlib.Path.home()/'NanoClaw'/'.env'
STATE_DIR = pathlib.Path.home()/'.local'/'state'/'ejclaw'
STATE = STATE_DIR/'status-board.json'
QUOTA_CACHE = STATE_DIR/'cliproxy-quota-cache.json'
CLIPROXY_MANAGEMENT_BASE = os.environ.get(
    'CLIPROXY_MANAGEMENT_BASE', 'http://172.17.0.1:8317/v0/management').rstrip('/')
CLIPROXY_MANAGEMENT_KEY_REF = os.environ.get(
    'CLIPROXY_MANAGEMENT_KEY_REF',
    'op://person-service/xp6ijk75xjz2nde7ztd43yqc3u/password')
UA = 'DiscordBot (https://eyejoker.com, ejclaw-status/1)'


def get_bot_token():
    for line in open(NANOCLAW_ENV):
        m = re.match(r'DISCORD_BOT_TOKEN=(.+)', line.strip())
        if m:
            return m.group(1).strip().strip('"').strip("'")
    return None


# ── 사용량 렌더러 (구 renderUsageTable 이식) ──

def bar(pct):
    filled = max(0, min(5, round(pct/20)))
    return '█'*filled + '░'*(5-filled)

def vw(s):
    return sum(2 if ord(c) > 0x7f else 1 for c in s)

def compact_reset(ts):
    if ts is None: return ''
    try:
        if isinstance(ts, str):
            dt = datetime.datetime.fromisoformat(ts.replace('Z','+00:00'))
        else:
            dt = datetime.datetime.fromtimestamp(int(ts), tz=datetime.timezone.utc)
        left = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if left <= 0: return '지남'
        d = int(left//86400); h = int(left%86400//3600); m = int(left%3600//60)
        return f"{d}d{h}h" if d else (f"{h}h{m:02d}" if h else f"{m}")
    except Exception:
        return '?'

EMPTY_CELL = '─'*5 + '    '

def render_usage_table(claude_rows, codex_rows):
    all_rows = claude_rows + codex_rows
    if not all_rows: return ['_조회 불가_']
    name_w = max(8, *(vw(r[0]) for r in all_rows)) + 1
    pad = lambda s: s + ' '*max(0, name_w - vw(s))
    lines = ['```']
    lines.append(' '*name_w + '5h' + ' '*8 + '7d')

    def emit(rows):
        for name, h5p, h5r, d7p, d7r, stale in rows:
            h5 = f"{bar(h5p)}{h5p:3d}%" if h5p >= 0 else EMPTY_CELL
            d7 = f"{bar(d7p)}{d7p:3d}%" if d7p >= 0 else EMPTY_CELL
            suffix = f" ({stale}m)" if stale is not None else ''
            lines.append(f"{pad(name)}{h5} {d7}{suffix}")
            r5 = compact_reset(h5r) if h5p >= 0 else ''
            r7 = compact_reset(d7r) if d7p >= 0 else ''
            if r5 or r7:
                reset_line = ' '*name_w + (r5 or '')
                reset_line = reset_line.ljust(name_w + 10) + (r7 or '')
                lines.append(reset_line.rstrip())

    emit(claude_rows)
    if claude_rows and codex_rows:
        lines.append('─'*(name_w + 20))
    emit(codex_rows)
    lines.append('```')
    return lines


def _pct(value):
    """Quota upstreams already return percentages, including values <= 1."""
    if not isinstance(value, (int, float)):
        return -1
    return max(0, min(100, int(round(value))))


def _jwt_payload(token):
    try:
        part = token.split('.')[1]
        part += '=' * ((4 - len(part) % 4) % 4)
        value = json.loads(base64.urlsafe_b64decode(part))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _codex_account_id(auth_file):
    for box in (auth_file, auth_file.get('metadata') or {}, auth_file.get('attributes') or {}):
        if not isinstance(box, dict):
            continue
        for key in ('account_id', 'chatgpt_account_id', 'chatgptAccountId'):
            if box.get(key):
                return str(box[key])
        claims = _jwt_payload(str(box.get('id_token') or ''))
        auth = claims.get('https://api.openai.com/auth') or claims
        if isinstance(auth, dict):
            for key in ('chatgpt_account_id', 'chatgptAccountId'):
                if auth.get(key):
                    return str(auth[key])
    return ''


def _management_key():
    if os.environ.get('CLIPROXY_MANAGEMENT_KEY'):
        return os.environ['CLIPROXY_MANAGEMENT_KEY']
    op = shutil.which('op')
    if not op:
        raise RuntimeError('op CLI not found')
    result = subprocess.run(
        [op, 'read', CLIPROXY_MANAGEMENT_KEY_REF],
        capture_output=True, text=True, timeout=20)
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise RuntimeError('CLIProxyAPI management key lookup failed')
    return key


def _management_fetch(path, payload=None, key=None):
    key = key or _management_key()
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        CLIPROXY_MANAGEMENT_BASE + path,
        data=data,
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
            'User-Agent': UA,
        },
        method='POST' if payload is not None else 'GET')
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def _claude_windows(usage):
    h5 = d7 = None
    limits = usage.get('limits') or []
    if limits:
        for limit in limits:
            kind = limit.get('kind')
            pct = limit.get('used_percent')
            if pct is None:
                pct = limit.get('percent')
            if pct is None:
                pct = limit.get('utilization')
            window = (_pct(pct), limit.get('resets_at') or limit.get('reset_at'))
            if kind in ('session', 'five_hour'):
                h5 = window
            elif kind in ('weekly_all', 'seven_day'):
                d7 = window
    else:
        for key, target in (('five_hour', 'h5'), ('seven_day', 'd7')):
            window = usage.get(key)
            if not window:
                continue
            value = (_pct(window.get('utilization')), window.get('resets_at') or window.get('reset_at'))
            if target == 'h5':
                h5 = value
            else:
                d7 = value
    return h5, d7


def _codex_windows(usage):
    h5 = d7 = None
    rate = usage.get('rate_limit') or {}
    for key in ('primary_window', 'secondary_window'):
        window = rate.get(key)
        if not window:
            continue
        value = (_pct(window.get('used_percent')), window.get('reset_at') or window.get('resets_at'))
        seconds = window.get('limit_window_seconds')
        if isinstance(seconds, (int, float)) and seconds <= 86400:
            h5 = value
        else:
            d7 = value
    return h5, d7


def _codex_plan_hint(auth_file):
    name = str(auth_file.get('name') or '').lower()
    for plan in ('team', 'k12', 'pro', 'plus', 'max', 'free'):
        if name.endswith(f'-{plan}.json'):
            return plan
    return ''


def _quota_capable_auth_files(files):
    available = [f for f in files
                 if not f.get('disabled') and f.get('type') in ('claude', 'codex')
                 and f.get('auth_index')]
    claude = []
    codex = []
    for auth_file in available:
        if auth_file.get('type') == 'claude':
            label = str(auth_file.get('label') or '').lower()
            name = str(auth_file.get('name') or '').lower()
            if label.endswith('@local') or 'onecli-direct' in name:
                continue
            claude.append(auth_file)
        else:
            codex.append(auth_file)
    claude.sort(key=lambda item: item.get('name') or '')
    codex.sort(key=lambda item: (
        _codex_plan_hint(item) in ('team', 'k12'),
        item.get('name') or '',
    ))
    return claude, codex


def collect_cliproxy_quota_rows(warn, fetch=None):
    """Collect subscription quota through CLIProxyAPI without reading OAuth files."""
    if fetch is None:
        management_key = _management_key()

        def live_fetch(path, payload=None):
            return _management_fetch(path, payload, management_key)

        fetch = live_fetch

    files = (fetch('/auth-files') or {}).get('files') or []
    claude_files, codex_files = _quota_capable_auth_files(files)
    targets = [
        ('claude', index, auth_file, '')
        for index, auth_file in enumerate(claude_files, 1)
    ] + [
        ('codex', index, auth_file, _codex_plan_hint(auth_file))
        for index, auth_file in enumerate(codex_files, 1)
    ]
    claude_rows = []
    codex_rows = []

    for provider, index, auth_file, plan_hint in targets:
        row_name = f'Claude{index}' if provider == 'claude' else (
            f"Codex{index}{' ' + plan_hint[:4] if plan_hint else ''}")
        try:
            headers = {'Authorization': 'Bearer $TOKEN$', 'User-Agent': 'aiusage/1'}
            if provider == 'claude':
                url = 'https://api.anthropic.com/api/oauth/usage'
                headers['anthropic-beta'] = 'oauth-2025-04-20'
            else:
                url = 'https://chatgpt.com/backend-api/wham/usage'
                headers['User-Agent'] = 'codex_cli_rs/0.76.0'
                account_id = _codex_account_id(auth_file)
                if account_id:
                    headers['Chatgpt-Account-Id'] = account_id
            response = fetch('/api-call', {
                'auth_index': auth_file['auth_index'],
                'method': 'GET',
                'url': url,
                'header': headers,
            }) or {}
            if response.get('status_code') != 200:
                raise RuntimeError(f'{provider} quota unavailable')
            usage = json.loads(response.get('body') or '{}')
            if provider == 'claude':
                h5, d7 = _claude_windows(usage)
                if not h5 and not d7:
                    raise ValueError('empty Claude quota response')
                claude_rows.append((
                    row_name,
                    h5[0] if h5 else -1, h5[1] if h5 else '',
                    d7[0] if d7 else -1, d7[1] if d7 else '', None))
            else:
                h5, d7 = _codex_windows(usage)
                if not h5 and not d7:
                    raise ValueError('empty Codex quota response')
                plan = str(usage.get('plan_type') or plan_hint).strip().lower()[:4]
                row_name = f"Codex{index}{' ' + plan if plan else ''}"
                codex_rows.append((
                    row_name,
                    h5[0] if h5 else -1, h5[1] if h5 else '',
                    d7[0] if d7 else -1, d7[1] if d7 else '', None))
                for extra in usage.get('additional_rate_limits') or []:
                    extra_h5, extra_d7 = _codex_windows({
                        'rate_limit': extra.get('rate_limit') or {},
                    })
                    values = [v for v in (extra_h5, extra_d7) if v and v[0] > 0]
                    if not values:
                        continue
                    raw_name = extra.get('limit_name') or '?'
                    extra_name = 'Spark' if 'Spark' in raw_name else raw_name[:6]
                    codex_rows.append((
                        f'{extra_name}{index}',
                        extra_h5[0] if extra_h5 else -1,
                        extra_h5[1] if extra_h5 else '',
                        extra_d7[0] if extra_d7 else -1,
                        extra_d7[1] if extra_d7 else '',
                        None,
                    ))
        except Exception:
            row = (row_name, -1, '', -1, '', None)
            if provider == 'claude':
                claude_rows.append(row)
            else:
                codex_rows.append(row)

    _append_quota_warnings(warn, claude_rows, codex_rows)
    return claude_rows, codex_rows


def _append_quota_warnings(warn, claude_rows, codex_rows):
    for name, h5p, _h5r, d7p, _d7r, _stale in claude_rows + codex_rows:
        if h5p >= 80:
            warn.append(f'{name.split()[0]} 5h {h5p}%')
        if d7p >= 80:
            warn.append(f'{name.split()[0]} 7d {d7p}%')


def _write_quota_cache(cache_path, claude_rows, codex_rows, now):
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({
        'at': now,
        'claude_rows': claude_rows,
        'codex_rows': codex_rows,
    }, ensure_ascii=False, separators=(',', ':'))
    temporary = cache_path.with_name(f'.{cache_path.name}.{os.getpid()}.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(payload)
        os.replace(temporary, cache_path)
        os.chmod(cache_path, 0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def _stale_rows(rows, stale_minutes):
    return [tuple(list(row[:5]) + [stale_minutes]) for row in rows]


def _row_key(row):
    return str(row[0]).split()[0]


def _row_missing(row):
    return row[1] < 0 and row[3] < 0


def _merge_cached_rows(live_rows, cached_rows, stale_minutes):
    cached_by_name = {_row_key(row): row for row in cached_rows}
    merged = []
    had_failure = False
    for row in live_rows:
        if not _row_missing(row):
            merged.append(row)
            continue
        had_failure = True
        cached = cached_by_name.get(_row_key(row))
        merged.append(
            tuple(list(cached[:5]) + [stale_minutes]) if cached else row
        )
    return merged, had_failure


def collect_quota_rows(warn, fetch=None, cache_path=QUOTA_CACHE, now=None):
    """Prefer live CLIProxyAPI quota; isolate failures with a secret-free row cache."""
    clock = now or time.time
    warning_count = len(warn)
    try:
        claude_rows, codex_rows = collect_cliproxy_quota_rows(warn, fetch=fetch)
        if not claude_rows and not codex_rows:
            raise RuntimeError('no quota-capable CLIProxyAPI credentials')

        cached_claude = []
        cached_codex = []
        stale = 0
        try:
            with open(cache_path) as stream:
                cached = json.load(stream)
            stale = max(0, int((clock() - float(cached['at'])) // 60))
            cached_claude = cached.get('claude_rows') or []
            cached_codex = cached.get('codex_rows') or []
        except Exception:
            pass

        claude_rows, claude_failed = _merge_cached_rows(
            claude_rows, cached_claude, stale)
        codex_rows, codex_failed = _merge_cached_rows(
            codex_rows, cached_codex, stale)
        del warn[warning_count:]
        _append_quota_warnings(warn, claude_rows, codex_rows)
        if not claude_failed and not codex_failed:
            _write_quota_cache(cache_path, claude_rows, codex_rows, clock())
        return claude_rows, codex_rows
    except Exception:
        del warn[warning_count:]
        try:
            with open(cache_path) as stream:
                cached = json.load(stream)
            stale = max(0, int((clock() - float(cached['at'])) // 60))
            claude_rows = _stale_rows(cached.get('claude_rows') or [], stale)
            codex_rows = _stale_rows(cached.get('codex_rows') or [], stale)
            if not claude_rows and not codex_rows:
                raise ValueError('empty quota cache')
            _append_quota_warnings(warn, claude_rows, codex_rows)
            return claude_rows, codex_rows
        except Exception:
            return (
                [('Claude', -1, '', -1, '', None)],
                [('Codex', -1, '', -1, '', None)],
            )


# ── 에이전트/서버 블록 (구 status-dashboard 파리티) ──

def agent_status_line():
    active = groups = None
    try:
        r = subprocess.run(['docker','ps','--format','{{.Names}}','--filter','name=nanoclaw-v2'],
                           capture_output=True, text=True, timeout=10)
        active = len([l for l in r.stdout.splitlines() if l.strip()])
    except Exception:
        pass
    try:
        r = subprocess.run(['pnpm','exec','tsx','scripts/q.ts','data/v2.db',
                            'select count(*) from agent_groups'],
                           capture_output=True, text=True, timeout=30,
                           cwd=str(pathlib.Path.home()/'NanoClaw'))
        groups = int(r.stdout.strip().splitlines()[-1])
    except Exception:
        pass
    if active is None: return None
    return f"📊 **에이전트 상태** — 활성 {active}" + (f" / {groups}" if groups is not None else "")


def server_block():
    try:
        # CPU%: /proc/stat 2회 샘플
        def cpu_sample():
            f = open('/proc/stat').readline().split()[1:]
            v = list(map(int, f))
            return sum(v), v[3] + (v[4] if len(v) > 4 else 0)
        t1, i1 = cpu_sample(); time.sleep(0.4); t2, i2 = cpu_sample()
        cpu = int(round(100*(1-(i2-i1)/max(1,(t2-t1)))))
        load1 = open('/proc/loadavg').read().split()[0]
        ncpu = os.cpu_count() or 1
        mem = {}
        for l in open('/proc/meminfo'):
            k, v = l.split(':')[0], l.split()[1]
            mem[k] = int(v)
        mt, ma = mem['MemTotal'], mem.get('MemAvailable', 0)
        mem_pct = int(round(100*(mt-ma)/mt))
        used_gb, tot_gb = (mt-ma)/1048576, mt/1048576
        du = shutil.disk_usage('/')
        disk_pct = int(round(100*du.used/du.total))
        up = float(open('/proc/uptime').read().split()[0])
        upd, uph = int(up//86400), int(up%86400//3600)
        lines = ['🖥️ **서버**', '```']
        lines.append(f"CPU     {bar(cpu)} {cpu:3d}%")
        lines.append(f"Load    {load1}/{ncpu}cpu")
        lines.append(f"Memory  {bar(mem_pct)} {mem_pct:3d}%  {used_gb:.1f}/{tot_gb:.1f}GB")
        lines.append(f"Disk    {bar(disk_pct)} {disk_pct:3d}%  {du.used//2**30}/{du.total//2**30}GB")
        lines.append(f"Uptime  {upd}d{uph}h")
        lines.append('```')
        return '\n'.join(lines)
    except Exception:
        return None


def build_content():
    warn = []
    claude_rows, codex_rows = collect_quota_rows(warn)
    now = datetime.datetime.now().strftime('%m-%d %H:%M')
    parts = [f"📊 **사용량** · {now}"]
    parts.append("\n".join(render_usage_table(claude_rows, codex_rows)))
    if warn:
        parts.append("⚠️ " + ", ".join(warn))
    ag = agent_status_line()
    if ag: parts.append(ag)
    sv = server_block()
    if sv: parts.append(sv)
    return "\n".join(parts)


def main():
    tok = get_bot_token()
    if not tok:
        print("NanoClaw .env에서 봇 토큰 읽기 실패"); return
    body = build_content()
    st = {}
    if STATE.exists():
        try: st = json.load(open(STATE))
        except Exception: st = {}
    mid = st.get('message_id')
    hdr = {'Authorization': f'Bot {tok}', 'Content-Type': 'application/json', 'User-Agent': UA}
    payload = json.dumps({'content': body}).encode()
    if mid:
        req = urllib.request.Request(
            f'https://discord.com/api/v10/channels/{CHANNEL_ID}/messages/{mid}',
            data=payload, headers=hdr, method='PATCH')
        try:
            urllib.request.urlopen(req, timeout=15)
            return
        except urllib.error.HTTPError as e:
            if e.code != 404: print(f"편집 실패 HTTP {e.code}"); return
    req = urllib.request.Request(
        f'https://discord.com/api/v10/channels/{CHANNEL_ID}/messages',
        data=payload, headers=hdr, method='POST')
    try:
        d = json.load(urllib.request.urlopen(req, timeout=15))
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        json.dump({'message_id': d['id']}, open(STATE,'w'))
    except urllib.error.HTTPError as e:
        print(f"생성 실패 HTTP {e.code}: {e.read().decode()[:120]}")


if __name__ == '__main__':
    main()
