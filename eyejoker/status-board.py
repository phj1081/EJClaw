#!/usr/bin/env python3
"""EJClaw status board — 구 EJClaw Status 대시보드 후계 (EJClaw 소유, 헤르메스 비의존).

#status 채널의 메시지 1개를 편집. 오너 봇(NanoClaw .env의 DISCORD_BOT_TOKEN)으로 게시.
구 unified-dashboard.ts 파리티:
- 사용량 테이블 (5h/7d, 5칸 바, 리셋 sub-line, 모바일 고정폭)
- 에이전트 상태 (활성 컨테이너 / 등록 그룹)
- 서버 블록 (CPU/Load/Memory/Disk/Uptime)
Tribunal 소속이던 모델구성(Owner/Reviewer/Arbiter/MoA) 블록은 은퇴로 제외.

systemd user timer(ejclaw-status-board.timer)가 5분마다 실행. 침묵=정상.
"""
import json, glob, os, re, shutil, subprocess, urllib.request, urllib.error, datetime, pathlib, time

CHANNEL_ID = "1481063226224672930"  # #status
NANOCLAW_ENV = pathlib.Path.home()/'NanoClaw'/'.env'
STATE_DIR = pathlib.Path.home()/'.local'/'state'/'ejclaw'
STATE = STATE_DIR/'status-board.json'
CLAUDE_CACHE = STATE_DIR/'claude-usage-cache.json'
HERMES_CLAUDE_CACHE = pathlib.Path.home()/'.hermes'/'state'/'aiusage-claude-cache.json'
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


def collect_codex_rows(warn):
    rows = []
    for f in sorted(glob.glob(str(pathlib.Path.home()/'.cli-proxy-api'/'codex-slot*.json'))):
        n = pathlib.Path(f).stem.replace('codex-slot','')
        try:
            d = json.load(open(f))
            req = urllib.request.Request('https://chatgpt.com/backend-api/wham/usage',
                headers={'Authorization': f"Bearer {d['access_token']}", 'User-Agent': 'aiusage/1'})
            u = json.load(urllib.request.urlopen(req, timeout=10))
            plan = (u.get('plan_type') or '')[:4]
            win = (u.get('rate_limit') or {}).get('primary_window') or {}
            pct = int(round(win.get('used_percent', 0)))
            rows.append((f"Codex{n} {plan}", -1, '', pct, win.get('reset_at'), None))
            if pct >= 80: warn.append(f"Codex{n} {pct}%")
            for extra in (u.get('additional_rate_limits') or []):
                w2 = (extra.get('rate_limit') or {}).get('primary_window') or {}
                p2 = int(round(w2.get('used_percent', 0)))
                if p2 > 0:
                    nm = 'Spark' if 'Spark' in (extra.get('limit_name') or '') else (extra.get('limit_name') or '?')[:6]
                    rows.append((f"{nm}{n}", -1, '', p2, w2.get('reset_at'), None))
        except Exception:
            rows.append((f"Codex{n}", -1, '', -1, '', None))
    return rows


def collect_claude_rows(warn):
    def rows_from(u, stale=None):
        out = []
        h5 = d7 = None
        lims = u.get('limits') or []
        if lims:
            for l in lims:
                kind = l.get('kind')
                pct = l.get('used_percent')
                if pct is None:
                    util = l.get('utilization')
                    pct = util*100 if isinstance(util,(int,float)) and util <= 1 else (util or 0)
                if kind == 'session': h5 = (int(round(pct)), l.get('resets_at') or l.get('reset_at'))
                elif kind == 'weekly_all': d7 = (int(round(pct)), l.get('resets_at') or l.get('reset_at'))
        else:
            for key in ('five_hour','seven_day'):
                w = u.get(key)
                if w:
                    util = w.get('utilization') or 0
                    v = (int(round(util*100 if util <= 1 else util)), w.get('resets_at'))
                    if key == 'five_hour': h5 = v
                    else: d7 = v
        out.append(('Claude max',
                    h5[0] if h5 else -1, h5[1] if h5 else '',
                    d7[0] if d7 else -1, d7[1] if d7 else '', stale))
        if h5 and h5[0] >= 80: warn.append(f"Claude 5h {h5[0]}%")
        if d7 and d7[0] >= 80: warn.append(f"Claude 7d {d7[0]}%")
        return out
    try:
        cred = json.load(open(pathlib.Path.home()/'.claude'/'.credentials.json'))
        tok = (cred.get('claudeAiOauth') or {}).get('accessToken') or os.environ.get('CLAUDE_CODE_OAUTH_TOKEN','')
        if not tok: raise RuntimeError('no token')
        req = urllib.request.Request('https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': f'Bearer {tok}','anthropic-beta':'oauth-2025-04-20','User-Agent':'aiusage/1'})
        u = json.load(urllib.request.urlopen(req, timeout=10))
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        json.dump({'at': time.time(), 'data': u}, open(CLAUDE_CACHE,'w'))
        return rows_from(u)
    except Exception:
        for cache in (CLAUDE_CACHE, HERMES_CLAUDE_CACHE):
            try:
                c = json.load(open(cache))
                if c.get('data'):
                    return rows_from(c['data'], stale=int((time.time()-c['at'])//60))
            except Exception:
                continue
        return [('Claude max', -1, '', -1, '', None)]


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
    claude_rows = collect_claude_rows(warn)
    codex_rows = collect_codex_rows(warn)
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
