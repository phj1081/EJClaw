#!/usr/bin/env python3
"""ai-usage-board — 구 EJClaw Status 대시보드 포맷 그대로 Discord 현황판 1개 메시지 편집.

구 unified-dashboard.ts의 renderUsageTable을 파이썬으로 이식:
- 이름 컬럼 가변폭 (비ASCII=2폭 계산, 모바일 고정폭 유지)
- 5h / 7d 두 컬럼, 5칸 바 + 3자리 %
- 윈도우 없는 칸은 '─────    ' (실제 셀과 같은 문자폭 구성)
- 각 행 아래 리셋 남은시간 줄
- Claude → 구분선 → Codex 순서
no_agent cron에서 5분마다 실행. 출력 없음(침묵) = 정상.
"""
import json, glob, os, subprocess, urllib.request, urllib.error, datetime, pathlib, time

CHANNEL_ID = "1489220254201549011"  # Hermes Home 채널
STATE = pathlib.Path.home()/'.hermes'/'state'/'ai-usage-board.json'
CLAUDE_CACHE = pathlib.Path.home()/'.hermes'/'state'/'aiusage-claude-cache.json'


def get_bot_token():
    r = subprocess.run(['op','read','op://person-service/hermes-runtime-env/DISCORD_BOT_TOKEN'],
                       capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


# ── 구 EJClaw 렌더러 이식 (unified-dashboard.ts renderUsageTable) ──

def bar(pct):
    filled = max(0, min(5, round(pct/20)))
    return '█'*filled + '░'*(5-filled)

def vw(s):  # visual width: 비ASCII 2폭
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
    """rows: (name, h5pct, h5reset, d7pct, d7reset, stale_min)"""
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
                if p2 > 0:  # Spark 등은 사용중일 때만 행 추가
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
            for key, tgt in (('five_hour','h5'), ('seven_day','d7')):
                w = u.get(key)
                if w:
                    util = w.get('utilization') or 0
                    v = (int(round(util*100 if util <= 1 else util)), w.get('resets_at'))
                    if key == 'five_hour': h5 = v
                    else: d7 = v
        name = 'Claude max'
        out.append((name,
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
        CLAUDE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        json.dump({'at': time.time(), 'data': u}, open(CLAUDE_CACHE,'w'))
        return rows_from(u)
    except Exception:
        try:
            c = json.load(open(CLAUDE_CACHE))
            return rows_from(c['data'], stale=int((time.time()-c['at'])//60))
        except Exception:
            return [('Claude max', -1, '', -1, '', None)]


def nanoclaw_status_line():
    try:
        r = subprocess.run(['docker','ps','--format','{{.Names}}','--filter','name=nanoclaw-v2'],
                           capture_output=True, text=True, timeout=10)
        n = len([l for l in r.stdout.splitlines() if l.strip()])
        return f"활성 컨테이너 {n}"
    except Exception:
        return None


def build_content():
    warn = []
    claude_rows = collect_claude_rows(warn)
    codex_rows = collect_codex_rows(warn)
    now = datetime.datetime.now().strftime('%m-%d %H:%M')
    st = nanoclaw_status_line()
    header = f"**AI 사용량** · {now}" + (f" · {st}" if st else '')
    body = header + "\n" + "\n".join(render_usage_table(claude_rows, codex_rows))
    if warn:
        body += "\n⚠️ " + ", ".join(warn)
    return body


def main():
    tok = get_bot_token()
    if not tok:
        print("op에서 봇 토큰 읽기 실패"); return
    body = build_content()
    st = {}
    if STATE.exists():
        try: st = json.load(open(STATE))
        except Exception: st = {}
    mid = st.get('message_id')
    hdr = {'Authorization': f'Bot {tok}', 'Content-Type': 'application/json', 'User-Agent': 'aiusage-board/1'}
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
        STATE.parent.mkdir(parents=True, exist_ok=True)
        json.dump({'message_id': d['id']}, open(STATE,'w'))
    except urllib.error.HTTPError as e:
        print(f"생성 실패 HTTP {e.code}: {e.read().decode()[:120]}")


if __name__ == '__main__':
    main()
