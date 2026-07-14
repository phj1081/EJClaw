#!/usr/bin/env python3
"""ai-usage-board — Discord 채널 상단에 사용량 현황판 메시지 1개를 계속 편집(초안 생성 포함).

no_agent cron에서 5분마다 실행. 출력 없음(침묵) = 정상 갱신.
편집 방식이라 채널이 알림으로 시끄러워지지 않음.
"""
import json, glob, os, subprocess, urllib.request, urllib.error, datetime, pathlib, time

CHANNEL_ID = "1489220254201549011"  # Hermes Home 채널
STATE = pathlib.Path.home()/'.hermes'/'state'/'ai-usage-board.json'
CLAUDE_CACHE = pathlib.Path.home()/'.hermes'/'state'/'aiusage-claude-cache.json'


def get_bot_token():
    r = subprocess.run(['op','read','op://person-service/hermes-runtime-env/DISCORD_BOT_TOKEN'],
                       capture_output=True, text=True, timeout=30)
    return r.stdout.strip()


def pct_bar(p):
    p = max(0, min(100, int(round(p))))
    return f"{'█'*(p//10)}{'░'*(10-p//10)}{p:4d}%"


def fmt_reset(ts):
    try:
        if isinstance(ts, str):
            dt = datetime.datetime.fromisoformat(ts.replace('Z','+00:00'))
        else:
            dt = datetime.datetime.fromtimestamp(int(ts), tz=datetime.timezone.utc)
        left = (dt - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
        if left <= 0: return "지남"
        d = int(left//86400); h = int(left%86400//3600); m = int(left%3600//60)
        return f"{d}d{h}h" if d else (f"{h}h{m:02d}m" if h else f"{m}m")
    except Exception:
        return "?"


def collect():
    lines = []
    warn = []
    # Codex slots
    for f in sorted(glob.glob(str(pathlib.Path.home()/'.cli-proxy-api'/'codex-slot*.json'))):
        slot = pathlib.Path(f).stem.replace('codex-','')
        try:
            d = json.load(open(f))
            req = urllib.request.Request('https://chatgpt.com/backend-api/wham/usage',
                headers={'Authorization': f"Bearer {d['access_token']}", 'User-Agent': 'aiusage/1'})
            u = json.load(urllib.request.urlopen(req, timeout=10))
            plan = u.get('plan_type','')[:4]
            win = (u.get('rate_limit') or {}).get('primary_window') or {}
            pct = win.get('used_percent', 0)
            lines.append(f"{slot:>5}({plan:4}) GPT   {pct_bar(pct)}  {fmt_reset(win.get('reset_at'))}")
            if pct >= 80: warn.append(f"{slot} {int(pct)}%")
            for extra in (u.get('additional_rate_limits') or []):
                w2 = (extra.get('rate_limit') or {}).get('primary_window') or {}
                nm = 'Spark' if 'Spark' in (extra.get('limit_name') or '') else (extra.get('limit_name') or '?')[:5]
                lines.append(f"{'':>11} {nm:5} {pct_bar(w2.get('used_percent',0))}  {fmt_reset(w2.get('reset_at'))}")
        except Exception:
            lines.append(f"{slot:>5}        조회실패")
    # Claude (live 시도 → 실패 시 캐시)
    claude_lines, stale = [], None
    def rows_from(u):
        out=[]
        for l in (u.get('limits') or []):
            kind=l.get('kind') or '?'
            label={'session':'5h','weekly_all':'7d','weekly_scoped':'7d*'}.get(kind,kind[:3])
            pct=l.get('used_percent')
            if pct is None:
                util=l.get('utilization'); pct=util*100 if isinstance(util,(int,float)) and util<=1 else (util or 0)
            out.append((label,pct,l.get('resets_at') or l.get('reset_at')))
        if not out:
            for key,label in (('five_hour','5h'),('seven_day','7d')):
                w=u.get(key)
                if w:
                    util=w.get('utilization') or 0
                    out.append((label, util*100 if util<=1 else util, w.get('resets_at')))
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
        for label,pct,reset in rows_from(u):
            claude_lines.append(f"claude(max) {label:5} {pct_bar(pct)}  {fmt_reset(reset)}")
            if pct >= 80: warn.append(f"claude {label} {int(pct)}%")
    except Exception:
        try:
            c = json.load(open(CLAUDE_CACHE))
            stale = int((time.time()-c['at'])//60)
            for label,pct,reset in rows_from(c['data']):
                claude_lines.append(f"claude(max) {label:5} {pct_bar(pct)}  {fmt_reset(reset)}")
        except Exception:
            claude_lines.append("claude(max)       조회불가(429) — 게이트웨이 트래픽과 공유")
    lines += claude_lines
    now = datetime.datetime.now().strftime('%m-%d %H:%M')
    header = f"**AI 사용량** · {now} KST"
    if stale is not None:
        header += f" (claude는 {stale}분 전 캐시)"
    body = header + "\n```text\n" + "\n".join(lines) + "\n```"
    if warn:
        body += "\n⚠️ " + ", ".join(warn)
    return body


def main():
    tok = get_bot_token()
    if not tok:
        print("op에서 봇 토큰 읽기 실패"); return
    body = collect()
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
            return  # 조용히 갱신 성공
        except urllib.error.HTTPError as e:
            if e.code != 404: print(f"편집 실패 HTTP {e.code}"); return
            # 메시지 삭제됨 → 새로 생성
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
