#!/usr/bin/env python3
"""
On-Demand Gigabit Mirror Runner for GitHub Actions.
- Normal Roboto (native Telegram UI text) for prose, labels, engines, and folder names
- Monospace (<code> / <pre>) for filenames, numeric telemetry, progress bars, and system stats
- Colored InlineKeyboardButtons (style: "primary" | "danger" | "success")

Job item types:
  {"type": "url", "url": "..."}                         -> Aria2c download
  {"type": "gdrive", "id": "...", "resourceKey": "..."} -> Drive server-side copy / clone,
                                                          or authenticated download for extract/zip
"""

import asyncio
import base64
import hashlib
import html
import http.client
import http.server
import importlib
import inspect
import json
import math
import os
import re
import shutil
import signal
import site
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
JOB_SECRET = os.environ.get("JOB_SECRET", "")
JOB_ID = os.environ.get("JOB_ID", "")
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_API_ID = (os.environ.get("TELEGRAM_API_ID") or "").strip()
TELEGRAM_API_HASH = (os.environ.get("TELEGRAM_API_HASH") or "").strip()
GITHUB_RUN_ID = os.environ.get("GITHUB_RUN_ID", "")
YTDL_COOKIES = os.environ.get("YTDL_COOKIES", "")

GITHUB_REPOSITORY = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
REPO_URL = f"https://github.com/{GITHUB_REPOSITORY}" if GITHUB_REPOSITORY else "https://github.com"

WORK_DIR = Path("/tmp/mirror_work")
DL_DIR = WORK_DIR / "downloads"
OUT_DIR = WORK_DIR / "output"
RCLONE_CONF = Path.home() / ".config" / "rclone" / "rclone.conf"

TICK_SECONDS = 2.5
TOKEN_REFRESH_SECONDS = 40 * 60  # Google access tokens live ~60 min
TG_BOT_MAX_BYTES = 2000 * 1024 * 1024  # Telegram Bot MTProto 2,000 MiB upload limit
TG_SPLIT_BYTES = 1950 * 1024 * 1024  # Safe < 2,000 MiB volume size for auto-splitting
GH_ASSET_MAX_BYTES = 2000 * 1024 * 1024  # GitHub Releases 2 GiB single-asset limit
GH_SPLIT_BYTES = 1950 * 1024 * 1024  # Safe < 2 GiB volume size for GitHub Release assets
PERM_REQ_MAX_BYTES = 50 * 1024 * 1024 * 1024  # 50 GiB limit for permanent gcusrfiles request button
VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".webm", ".m4v", ".avi"}
AUDIO_EXTS = {".mp3", ".m4a", ".opus", ".flac", ".aac", ".ogg", ".wav"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
FOLDER_MIME = "application/vnd.google-apps.folder"
TAR_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz2", ".txz", ".tar")
COMPOUND_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst")
ARIA_ENGINE = "Aria2c v1.37.0"
GC_TEMP_NOTICE_HTML = (
    "⚠ <b>Temporary Group Storage (5 Days):</b> File(s) will be deleted after <b>5 days</b>. "
    "Use /login with your personal Google Drive for permanent storage, or contact the Owner."
)
GOFILE_NOTICE_HTML = (
    "⚠ <b>Temporary Storage (Gofile):</b> Files are deleted after <b>100 GB download quota</b> "
    "or <b>10 days of inactivity</b>. Re-mirror from the original source to renew, "
    "or /login with your personal Google Drive for permanent storage."
)

cancelled = False


def handle_sig(signum, frame):
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, handle_sig)
signal.signal(signal.SIGINT, handle_sig)


# ============================================================================
# GENERIC HELPERS
# ============================================================================

def mask_secret(val: str, min_len: int = 5):
    if val and len(val) >= min_len:
        print(f"::add-mask::{val}", flush=True)


def http_json(url: str, data: dict = None, headers: dict = None, method: str = None, timeout: int = 15):
    req_headers = {"Content-Type": "application/json", "User-Agent": "MirrorRunner/3.0"}
    if headers:
        req_headers.update(headers)
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method or ("POST" if body else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        parsed = {}
        try:
            parsed = json.loads(e.read().decode("utf-8"))
        except Exception:
            pass
        return {"ok": False, "error": str(e), "http_status": e.code, "body": parsed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def worker_call(path: str, payload: dict):
    return http_json(
        f"{WORKER_URL}{path}",
        data=payload,
        headers={"Authorization": f"Bearer {JOB_SECRET}"},
        timeout=15,
    )


def tg_call(method: str, payload: dict):
    if not BOT_TOKEN:
        return {}
    res = http_json(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", data=payload, timeout=10)
    if not res.get("ok") and payload.get("reply_markup"):
        kb = payload["reply_markup"].get("inline_keyboard")
        if kb and any("style" in btn for row in kb for btn in row):
            stripped = {
                **payload,
                "reply_markup": {
                    **payload["reply_markup"],
                    "inline_keyboard": [[{k: v for k, v in btn.items() if k != "style"} for btn in row] for row in kb],
                },
            }
            res = http_json(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", data=stripped, timeout=10)
    return res


def edit_status(chat_id, message_id, text: str, reply_markup: dict = None):
    if not chat_id or not message_id:
        return
    payload = {
        "chat_id": chat_id,
        "message_id": int(message_id),
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    tg_call("editMessageText", payload)


def send_message(chat_id, text: str, reply_markup: dict = None, thread_id=None):
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    if reply_markup:
        payload["reply_markup"] = reply_markup
    if thread_id:
        payload["message_thread_id"] = int(thread_id)
    return tg_call("sendMessage", payload)


def fmt_bytes(num: float) -> str:
    if not num or num <= 0:
        return "0.00 B"
    for unit in ["B", "KiB", "MiB", "GiB", "TiB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f} {unit}"
        num /= 1024.0
    return f"{num:.2f} PiB"


def fmt_sys_bytes(num: float) -> str:
    if num <= 0:
        return "0.00B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if abs(num) < 1024.0:
            return f"{num:.2f}{unit}"
        num /= 1024.0
    return f"{num:.2f}PB"


def fmt_duration(seconds) -> str:
    if seconds is None or seconds < 0 or seconds > 86400 * 7:
        return "-"
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m}m{s}s"
    if m > 0:
        return f"{m}m{s}s"
    return f"{s}s"


def make_bar(pct: float, length: int = 12) -> str:
    pct = max(0.0, min(100.0, pct))
    filled = int(round((pct / 100.0) * length))
    return "■" * filled + "□" * (length - filled)


def truncate(s: str, n: int) -> str:
    s = s or ""
    return s if len(s) <= n else s[: n - 1] + "…"


def path_size(p: Path) -> int:
    try:
        if p.is_file():
            return p.stat().st_size
        total = 0
        for root, _, files in os.walk(p):
            for fn in files:
                try:
                    total += (Path(root) / fn).stat().st_size
                except OSError:
                    pass
        return total
    except OSError:
        return 0


def q_escape(name: str) -> str:
    return name.replace("\\", "\\\\").replace("'", "\\'")


def split_name(name: str, is_dir: bool):
    if is_dir:
        return name, ""
    low = name.lower()
    for suf in COMPOUND_SUFFIXES:
        if low.endswith(suf) and len(name) > len(suf):
            return name[: -len(suf)], name[-len(suf):]
    suffix = Path(name).suffix
    if suffix and len(suffix) <= 10 and len(name) > len(suffix):
        return name[: -len(suffix)], suffix
    return name, ""


def archive_stem(name: str) -> str:
    low = name.lower()
    for suf in TAR_SUFFIXES:
        if low.endswith(suf) and len(name) > len(suf):
            return name[: -len(suf)]
    stem = Path(name).stem
    return stem or "extracted"


def remote_path(folder_id: str) -> str:
    if not folder_id or folder_id == "root":
        return "userdrive:"
    return f"userdrive,root_folder_id={folder_id}:"


def friendly_drive_error(text: str):
    t = (text or "").lower()
    if "storagequotaexceeded" in t or "storage quota" in t or "quota for this drive" in t:
        return "Google Drive storage is full. Free up space and try again."
    if (
        "uploadlimit" in t
        or "upload limit" in t
        or "userratelimitexceeded" in t
        or "user rate limit exceeded" in t
        or "maxuploadedbytes" in t
    ):
        return "Google Drive's daily upload limit (~750 GB / 24h) was reached. Try again later."
    if "downloadquotaexceeded" in t or "download quota" in t or "dailylimitexceeded" in t:
        return "The source file's Drive download quota is exhausted. Try again in ~24h."
    if "cannotcopyfile" in t or "copyrequireswriterpermission" in t or "cannotdownloadfile" in t:
        return "The file owner has disabled copying / downloading for this file."
    if "filenotfound" in t or "notfound" in t or "file not found" in t:
        return "Drive file not found, or it is not shared with your Google account."
    if "insufficientfilepermissions" in t or "insufficientpermissions" in t:
        return "Your Google account has no permission to access this file."
    if "invalid credentials" in t or "unauthenticated" in t or "token expired" in t:
        return "Google Drive authorization failed. Run /login again."
    return None


def drive_error_text(res: dict, fallback: str) -> str:
    body = res.get("body") or {}
    err = body.get("error") or {}
    reasons = " ".join(str(e.get("reason", "")) for e in (err.get("errors") or []))
    message = str(err.get("message") or res.get("error") or "")
    return friendly_drive_error(f"{reasons} {message}") or (f"{fallback}: {message}" if message else fallback)


class SystemMonitor:
    def __init__(self):
        self.start_time = time.time()
        self.prev_cpu = self._read_cpu()
        self.prev_net = self._read_net()
        self.prev_time = time.time()
        self.base_rx, self.base_tx = self.prev_net

    def _read_cpu(self):
        try:
            with open("/proc/stat", "r") as f:
                parts = [int(x) for x in f.readline().split()[1:]]
            idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
            return idle, sum(parts)
        except Exception:
            return 0, 1

    def _read_net(self):
        rx, tx = 0, 0
        try:
            with open("/proc/net/dev", "r") as f:
                for line in f.readlines()[2:]:
                    if ":" not in line:
                        continue
                    iface, data = line.split(":", 1)
                    if iface.strip() == "lo":
                        continue
                    fields = data.split()
                    rx += int(fields[0])
                    tx += int(fields[8])
        except Exception:
            pass
        return rx, tx

    def snapshot(self):
        now = time.time()
        dt = max(0.5, now - self.prev_time)

        idle1, total1 = self.prev_cpu
        idle2, total2 = self._read_cpu()
        self.prev_cpu = (idle2, total2)
        d_total = max(1, total2 - total1)
        cpu_pct = max(0.0, min(100.0, 100.0 * (1.0 - (idle2 - idle1) / d_total)))

        ram_pct = 0.0
        try:
            mem = {}
            with open("/proc/meminfo", "r") as f:
                for line in f:
                    k, v = line.split(":", 1)
                    mem[k.strip()] = int(v.strip().split()[0])
            total_mem = mem.get("MemTotal", 1)
            avail_mem = mem.get("MemAvailable", total_mem)
            ram_pct = 100.0 * (total_mem - avail_mem) / total_mem
        except Exception:
            pass

        du = shutil.disk_usage("/")
        rx2, tx2 = self._read_net()
        rx_spd = max(0.0, (rx2 - self.prev_net[0]) / dt)
        tx_spd = max(0.0, (tx2 - self.prev_net[1]) / dt)
        self.prev_net = (rx2, tx2)
        self.prev_time = now

        return {
            "cpu_pct": cpu_pct,
            "ram_pct": ram_pct,
            "free_gb": du.free / (1024 ** 3),
            "disk_pct": 100.0 * du.used / max(1, du.total),
            "rx_spd": fmt_sys_bytes(rx_spd) + "/s",
            "tx_spd": fmt_sys_bytes(tx_spd) + "/s",
            "rx_tot": fmt_sys_bytes(max(0, rx2 - self.base_rx)),
            "tx_tot": fmt_sys_bytes(max(0, tx2 - self.base_tx)),
            "uptime": fmt_duration(now - self.start_time),
        }


def dot_for(pct: float) -> str:
    if pct >= 85:
        return "🔴"
    if pct >= 60:
        return "🟠"
    return "🟢"


def build_status_card(
    job: dict,
    filename: str,
    status_text: str,
    pct: float,
    done_bytes: float,
    total_bytes: float,
    speed_bps: float,
    eta_sec,
    engine: str,
    elapsed_sec: float,
    sys_snap: dict,
    batch_pos=None,
) -> str:
    is_leech = job.get("dest") == "telegram"
    mode_map = {"normal": "Leech" if is_leech else "Mirror", "extract": "Extract", "zip": "ArchiveZIP"}
    if job.get("isYtdl"):
        q = job.get("ytQuality", "best")
        mode_str = ("Audio" if q in ("mp3", "m4a", "opus", "flac") else "yt-dlp") + (" #Leech" if is_leech else "")
    else:
        base_m = mode_map.get(job.get("mode", "normal"), "Mirror")
        mode_str = f"{base_m} #Leech" if (is_leech and base_m != "Leech") else base_m
    uname = job.get("username") or "User"
    if not uname.startswith("@") and re.match(r"^[A-Za-z0-9_]{4,}$", uname) and uname != "User":
        uname = "@" + uname
    role = (job.get("userRole") or "").strip()
    by_display = f"{uname} [{role}]" if role else uname
    uid = job.get("userId", "")
    short_id = job.get("jobId", "")

    bar = make_bar(pct, 12)
    cpu_bar = make_bar(sys_snap["cpu_pct"], 10)
    ram_bar = make_bar(sys_snap["ram_pct"], 10)
    disk_bar = make_bar(sys_snap["disk_pct"], 10)

    total_str = fmt_bytes(total_bytes) if total_bytes and total_bytes > 0 else "Unknown"
    base_repo = (job.get("repoUrl") or REPO_URL).rstrip("/")
    run_url = f"{base_repo}/actions/runs/{GITHUB_RUN_ID}" if GITHUB_RUN_ID else f"{base_repo}/actions"

    sys_block = (
        f"┌ SYSTEM\n"
        f"├ {dot_for(sys_snap['cpu_pct'])} Cpu [{cpu_bar}] {sys_snap['cpu_pct']:.1f}%\n"
        f"├ {dot_for(sys_snap['ram_pct'])} Ram [{ram_bar}] {sys_snap['ram_pct']:.1f}%\n"
        f"├ {dot_for(sys_snap['disk_pct'])} Free [{disk_bar}] {sys_snap['free_gb']:.2f}GB\n"
        f"├ ⚡ Spd ↓ {sys_snap['rx_spd']} ↑ {sys_snap['tx_spd']}\n"
        f"├ 🌐 Net ↓ {sys_snap['rx_tot']} ↑ {sys_snap['tx_tot']}\n"
        f"└ 🕒 Upt {sys_snap['uptime']}"
    )

    lines = [
        f"<blockquote>📄 <b>Name :</b> <code>{html.escape(filename)}</code></blockquote>",
        "",
        f"┌ Status : <a href=\"{run_url}\">{html.escape(status_text)}</a> ({pct:.2f}%)",
        f"├ [<code>{bar}</code>]",
    ]
    if batch_pos:
        lines.append(f"├ Batch : <code>{batch_pos[0]} / {batch_pos[1]}</code>")
    lines += [
        f"├ By : {html.escape(by_display)}",
        f"├ UserID : <code>[{html.escape(str(uid))}]</code>",
        f"├ Elapsed : <code>{fmt_duration(elapsed_sec)}</code>",
        f"├ Size : <code>{total_str}</code>",
        f"├ Processed : <code>{fmt_bytes(done_bytes)}</code>",
        f"├ ETA : <code>{fmt_duration(eta_sec)}</code>",
        f"├ Speed : <code>{fmt_bytes(speed_bps)}/s</code>",
        f"├ Engine : <code>{html.escape(engine)}</code>",
        f"├ Mode : <code>#{mode_str}</code>",
        f"└ ⛔ /cancel_{html.escape(short_id)}",
        "",
        "____________________________",
        "",
        f"<pre><code>{html.escape(sys_block)}</code></pre>",
    ]
    if is_leech:
        dm_hint = " DM files auto-delete in 30m." if job.get("chatType") == "private" else ""
        lines.append("")
        lines.append(
            f"<blockquote>⚠️ <b>Copyright Warning:</b> Do not leech copyrighted content — "
            f"it could get the group and bot both flagged or banned.{dm_hint}</blockquote>"
        )
    return "\n".join(lines)


def status_keyboard(job_id: str) -> dict:
    return {
        "inline_keyboard": [
            [
                {"text": "🔄 Refresh", "callback_data": f"st_ref:{job_id}", "style": "primary"},
                {"text": "🔽 Close", "callback_data": f"st_close:{job_id}", "style": "danger"},
            ]
        ]
    }


def aria2_rpc(method: str, params: list = None):
    payload = {"jsonrpc": "2.0", "id": "1", "method": method, "params": params or []}
    return http_json("http://127.0.0.1:6800/jsonrpc", data=payload, timeout=5)


def poll_worker_state(job_id: str, last_card: str = None):
    payload = {"job_id": job_id}
    if last_card:
        payload["last_card"] = last_card
    res = worker_call("/internal/job-status", payload)
    is_cancelled = bool(res.get("cancelled"))
    msg_id = str(res.get("messageId") or "") if "messageId" in res else None
    tg_decision = str(res.get("tgDecision") or "")
    return is_cancelled, msg_id, tg_decision


def sync_worker_state(job_id: str, last_card: str = None):
    is_cancelled, msg_id, _ = poll_worker_state(job_id, last_card=last_card)
    return is_cancelled, msg_id


def finish_status(chat_id, message_id, text: str, reply_markup: dict = None, thread_id=None):
    if message_id:
        edit_status(chat_id, message_id, text, reply_markup)
    elif chat_id:
        send_message(chat_id, text, reply_markup, thread_id=thread_id)


# ============================================================================
# LINK RESOLVER & SHORTENER UNWRAPPER
# ============================================================================

DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
WGET_UA = "Wget/1.21.3"
DIRECT_EXT_RE = re.compile(
    r"\.(zip|rar|7z|tar\.gz|tgz|tar\.bz2|tar\.xz|txz|mkv|mp4|avi|webm|mov|m4v|mp3|flac|m4a|ogg|wav|iso|img|apk|exe|msi|dmg|deb|rpm|appimage|pdf|epub|bin)(\?.*)?$",
    re.I,
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIR_OPENER = urllib.request.build_opener(_NoRedirect())


def parse_drive_url(raw_url: str):
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower()
        if not (host.endswith("drive.google.com") or host.endswith("docs.google.com") or host == "drive.usercontent.google.com"):
            return None
        qs = urllib.parse.parse_qs(u.query)
        rk = (qs.get("resourcekey") or qs.get("resourceKey") or [""])[0]
        m_folder = re.search(r"/folders/([a-zA-Z0-9_-]{10,})", u.path)
        if m_folder:
            return {"type": "gdrive", "id": m_folder.group(1), "resourceKey": rk}
        m_file = re.search(r"/d/([a-zA-Z0-9_-]{10,})", u.path)
        if m_file:
            return {"type": "gdrive", "id": m_file.group(1), "resourceKey": rk}
        id_param = (qs.get("id") or [""])[0]
        if id_param and re.match(r"^[a-zA-Z0-9_-]{10,}$", id_param):
            return {"type": "gdrive", "id": id_param, "resourceKey": rk}
    except Exception:
        pass
    return None


def parse_telegram_post_url(raw_url: str):
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower().removeprefix("www.")
        if host not in ("t.me", "telegram.me", "telegram.dog"):
            return None
        parts = [p for p in u.path.split("/") if p]
        if len(parts) < 2:
            return None
        if parts[0] == "c" and len(parts) >= 3:
            internal_id = parts[1]
            msg_id_str = parts[-1]
            if internal_id.isdigit() and msg_id_str.isdigit() and int(msg_id_str) > 0:
                msg_id = int(msg_id_str)
                return {
                    "type": "tg_media",
                    "chatId": f"-100{internal_id}",
                    "messageId": msg_id,
                    "fileId": "",
                    "url": raw_url,
                    "name": f"Telegram_post_{msg_id}",
                }
            return None
        ch_idx = 1 if (parts[0] == "s" and len(parts) >= 3) else 0
        channel = parts[ch_idx]
        msg_id_str = parts[-1]
        reserved = {"joinchat", "addstickers", "addlist", "addemoji", "proxy", "socks", "share", "iv", "login", "confirmphone", "contact"}
        if (
            not channel
            or channel.startswith("+")
            or channel.lower() in reserved
            or not re.match(r"^[a-zA-Z0-9_]{4,}$", channel)
            or not msg_id_str.isdigit()
            or int(msg_id_str) <= 0
        ):
            return None
        msg_id = int(msg_id_str)
        return {
            "type": "tg_media",
            "chatId": channel,
            "messageId": msg_id,
            "fileId": "",
            "url": raw_url,
            "name": f"Telegram_{channel}_{msg_id}",
        }
    except Exception:
        return None


def is_sourceforge_url(raw_url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(raw_url).hostname or "").lower().removeprefix("www.")
        return host in ("sourceforge.net", "sf.net") or host.endswith(".sourceforge.net")
    except Exception:
        return False


def ua_for_url(raw_url: str) -> str:
    return WGET_UA if is_sourceforge_url(raw_url) else DEFAULT_UA


def rewrite_known_direct_url(raw_url: str):
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower().removeprefix("www.")
        if host == "pixeldrain.com":
            m_f = re.match(r"^/u/([a-zA-Z0-9_-]+)", u.path)
            if m_f:
                return f"https://pixeldrain.com/api/file/{m_f.group(1)}?download"
            m_l = re.match(r"^/l/([a-zA-Z0-9_-]+)", u.path)
            if m_l:
                return f"https://pixeldrain.com/api/list/{m_l.group(1)}/zip"
        if host == "dropbox.com":
            qs = urllib.parse.parse_qs(u.query, keep_blank_values=True)
            if qs.get("dl") != ["1"]:
                qs["dl"] = ["1"]
                new_q = urllib.parse.urlencode(qs, doseq=True)
                return urllib.parse.urlunparse(u._replace(query=new_q))
        if host == "github.com":
            m = re.match(r"^/([^/]+)/([^/]+)/(?:blob|raw)/(.+)$", u.path)
            if m:
                return f"https://raw.githubusercontent.com/{m.group(1)}/{m.group(2)}/{m.group(3)}"
        if host == "gitlab.com" and "/-/blob/" in u.path:
            return urllib.parse.urlunparse(u._replace(path=u.path.replace("/-/blob/", "/-/raw/", 1)))
        if host == "huggingface.co" and "/blob/" in u.path:
            return urllib.parse.urlunparse(u._replace(path=u.path.replace("/blob/", "/resolve/", 1)))
        if host == "sourceforge.net":
            path = u.path
            m_p = re.match(r"^/p/([^/]+)(/files/.*)$", path)
            if m_p:
                path = f"/projects/{m_p.group(1)}{m_p.group(2)}"
            m_dl = re.match(r"^/projects/([^/]+)/files/(.+?)/download/?$", path)
            if m_dl and m_dl.group(2) != "latest":
                return f"https://downloads.sourceforge.net/project/{m_dl.group(1)}/{m_dl.group(2)}?viasf=1"
            m_file = re.match(r"^/projects/([^/]+)/files/(.+?)/?$", path)
            if m_file and m_file.group(2) != "latest" and not path.endswith("/"):
                return f"https://downloads.sourceforge.net/project/{m_file.group(1)}/{m_file.group(2)}?viasf=1"
        if host == "master.dl.sourceforge.net":
            return raw_url.replace("://master.dl.sourceforge.net/", "://downloads.sourceforge.net/", 1)
    except Exception:
        pass
    return None


def detect_challenge_page(headers, body: str):
    if headers and str(headers.get("cf-mitigated", "")).lower() == "challenge":
        return "Protected by anti-bot verification. Open in your browser and send the direct file link."
    low = (body or "")[:60000].lower()
    markers = (
        "cf-turnstile", "challenges.cloudflare.com", "cdn-cgi/challenge-platform",
        "<title>just a moment...</title>", "g-recaptcha", "www.google.com/recaptcha",
        "h-captcha", "hcaptcha.com/1/api.js",
    )
    if any(m in low for m in markers):
        return "Protected by CAPTCHA or anti-bot verification. Open in your browser and send the direct file link."
    return None


def _extract_attr(tag: str, name: str) -> str:
    m = re.search(rf'\b{name}\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', tag, re.I)
    if not m:
        return ""
    val = next((g for g in m.groups() if g is not None), "")
    return html.unescape(val.strip())


def _curl_probe_single(url: str, method: str = "HEAD", follow: bool = False):
    curl_bin = shutil.which("curl")
    if not curl_bin:
        return None
    cmd = [curl_bin, "-sS", "--max-time", "20", "-b", "", "-A", ua_for_url(url), "-D", "-", "-o", "/dev/null", "-w", "\n__FINAL_URL__:%{url_effective}"]
    if follow:
        cmd.append("-L")
    if method == "HEAD":
        cmd.append("-I")
    else:
        cmd.extend(["-r", "0-0"])
    cmd.append(url)
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except Exception:
        return None
    out = res.stdout or ""
    final_url = url
    if "__FINAL_URL__:" in out:
        hdr_part, final_url = out.rsplit("__FINAL_URL__:", 1)
        final_url = final_url.strip() or url
    else:
        hdr_part = out
    blocks = [b.strip() for b in re.split(r"\r?\n\r?\n", hdr_part.strip()) if b.strip()]
    if not blocks:
        return None
    last_block = blocks[-1] if follow else blocks[0]
    lines = last_block.splitlines()
    status = 0
    if lines:
        m = re.match(r"HTTP/\S+\s+(\d{3})", lines[0].strip())
        if m:
            status = int(m.group(1))
    hdrs = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            hdrs[k.strip()] = v.strip()
    return status, hdrs, final_url


def _probe_single(url: str, method: str = "HEAD", follow: bool = False):
    if is_sourceforge_url(url):
        c_res = _curl_probe_single(url, method=method, follow=follow)
        if c_res is not None:
            return c_res
    headers = {"User-Agent": ua_for_url(url)}
    if method == "GET":
        headers["Range"] = "bytes=0-0"
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        if follow:
            with urllib.request.urlopen(req, timeout=12) as resp:
                return resp.status, dict(resp.headers), resp.geturl()
        with _NO_REDIR_OPENER.open(req, timeout=12) as resp:
            return resp.status, dict(resp.headers), resp.geturl()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers or {}), e.geturl()


def _is_direct_stream(url: str) -> bool:
    try:
        status, hdrs, _ = _probe_single(url, "HEAD", follow=True)
        if status in (403, 405, 501) or status >= 400:
            status, hdrs, _ = _probe_single(url, "GET", follow=True)
        if status >= 400:
            return False
        low = {k.lower(): v for k, v in hdrs.items()}
        ct = low.get("content-type", "").lower()
        cd = low.get("content-disposition", "").lower()
        return ("text/html" not in ct) or ("attachment" in cd)
    except Exception:
        return False


def _extract_host_candidates(page_url: str, body: str) -> list:
    u = urllib.parse.urlparse(page_url)
    host = (u.hostname or "").lower().removeprefix("www.")
    if host == "mediafire.com" or host.endswith(".mediafire.com"):
        if u.path.startswith("/folder/"):
            raise RuntimeError("MediaFire folders are not supported as a single direct link.")
        cands = []
        m = re.search(r'<a\b[^>]*\bid=["\']downloadButton["\'][^>]*>', body, re.I)
        if m:
            href = _extract_attr(m.group(0), "href")
            if href.startswith(("http://", "https://")):
                cands.append(href)
            scram = _extract_attr(m.group(0), "data-scrambled-url")
            if scram:
                try:
                    dec = base64.b64decode(scram).decode("utf-8", "ignore")
                    if dec.startswith(("http://", "https://")):
                        cands.append(dec)
                except Exception:
                    pass
        if cands:
            return cands

    if host == "sourceforge.net":
        cands = []
        for pat in (r'data-release-url=["\'](https?://[^"\']+)["\']', r'href=["\'](https?://downloads\.sourceforge\.net/[^"\']+)["\']'):
            m = re.search(pat, body, re.I)
            if m:
                cands.append(html.unescape(m.group(1)))
        if cands:
            return cands

    if host == "onedrive.live.com" or host.endswith(".sharepoint.com"):
        b64 = base64.b64encode(page_url.encode("utf-8")).decode("ascii").rstrip("=").replace("+", "-").replace("/", "_")
        return [f"https://api.onedrive.com/v1.0/shares/u!{b64}/root/content"]

    scored = []
    seen = set()
    for m in re.finditer(r"<a\b([^>]{1,600})>", body, re.I):
        attrs = m.group(1)
        href = _extract_attr(attrs, "href")
        if not href or href.startswith("#") or href.lower().startswith(("javascript:", "mailto:", "tel:")):
            continue
        abs_url = urllib.parse.urljoin(page_url, href)
        if not abs_url.startswith(("http://", "https://")) or abs_url == page_url or abs_url in seen:
            continue
        seen.add(abs_url)
        id_cls = (_extract_attr(attrs, "id") + " " + _extract_attr(attrs, "class")).lower()
        score = 0
        if re.search(r"\bdownload\b", attrs, re.I):
            score += 5
        if re.search(r"(?:^|[\s_-])(download|dl-btn|dl_btn|download-btn|btn-download)(?:$|[\s_-])", id_cls):
            score += 4
        if DIRECT_EXT_RE.search(abs_url):
            score += 3
        if score >= 3:
            scored.append((score, abs_url))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [u for _, u in scored[:3]]


def _fetch_text_resilient(url: str, accept: str = "text/html,application/xhtml+xml") -> tuple:
    """Fetch URL text using curl first, falling back to curl_cffi Chrome impersonation if CF-challenged."""
    ua = ua_for_url(url)
    curl_bin = shutil.which("curl")
    if curl_bin:
        try:
            r = subprocess.run(
                [curl_bin, "-sSL", "--max-time", "20", "-A", ua, "-H", f"Accept: {accept}", "-w", "\n__HTTP_CODE__:%{http_code}__FINAL_URL__:%{url_effective}", url],
                capture_output=True, text=True, timeout=25,
            )
            out = r.stdout or ""
            if "__HTTP_CODE__:" in out:
                body, tail = out.rsplit("__HTTP_CODE__:", 1)
                m_t = re.match(r"(\d{3})__FINAL_URL__:(.*)$", tail.strip(), re.S)
                if m_t:
                    code = int(m_t.group(1))
                    furl = m_t.group(2).strip() or url
                    if code < 400 and not detect_challenge_page({}, body):
                        return code, body, furl
        except Exception:
            pass

    _prepare_pkg_paths()
    try:
        from curl_cffi import requests as cffi_req
    except ImportError:
        _pip_install_target(["curl_cffi"], _TG_PKG_TARGET)
        from curl_cffi import requests as cffi_req

    sess = cffi_req.Session(impersonate="chrome")
    resp = sess.get(url, headers={"Accept": accept}, timeout=20, allow_redirects=True)
    return resp.status_code, resp.text or "", str(resp.url or url)


def _extract_sf_from_html(page_url: str, body: str):
    cands = _extract_host_candidates(page_url, body)
    for c in cands:
        if "dl.sourceforge.net" in c or "downloads.sourceforge.net" in c:
            return c
    m_meta = re.search(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+content=["\'][^"\']*url\s*=\s*([^"\'\s>]+)', body[:60000], re.I)
    if m_meta:
        return urllib.parse.urljoin(page_url, html.unescape(m_meta.group(1).strip()))
    return None


def _resolve_sf_via_cffi(raw_url: str) -> str:
    _prepare_pkg_paths()
    try:
        from curl_cffi import requests as cffi_req
    except ImportError:
        _pip_install_target(["curl_cffi"], _TG_PKG_TARGET)
        from curl_cffi import requests as cffi_req

    cur = raw_url
    sess = cffi_req.Session(impersonate="chrome")
    visited = set()
    for _ in range(10):
        if cur in visited:
            break
        visited.add(cur)
        r = sess.get(cur, timeout=20, allow_redirects=False, stream=True)
        try:
            loc = r.headers.get("location")
            if 300 <= r.status_code < 400 and loc:
                cur = urllib.parse.urljoin(cur, loc)
                continue
            ct = (r.headers.get("content-type") or "").lower()
            cd = (r.headers.get("content-disposition") or "").lower()
            if ("text/html" not in ct or "attachment" in cd) and r.status_code < 400:
                return cur
            body = r.text[:262144] if hasattr(r, "text") else ""
        finally:
            try:
                r.close()
            except Exception:
                pass

        nxt = _extract_sf_from_html(cur, body)
        if nxt and nxt not in visited:
            cur = nxt
            continue
        break
    raise RuntimeError("Could not extract direct download link from SourceForge page (anti-bot blocked).")


# ============================================================================
# GOFILE SOURCE (download FROM Gofile)
# ============================================================================

GOFILE_API_BASE = "https://api.gofile.io"
GOFILE_DEFAULT_WT_SALT = "12af056dacea0b"
_GOFILE_SALT_CACHE = {"salt": "", "at": 0.0}


def _is_gofile_id(value: str) -> bool:
    v = (value or "").strip()
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", v, re.I):
        return True
    if re.fullmatch(r"[A-Za-z0-9]{8}", v):
        return v.lower() not in {"download", "contents", "accounts", "uploadfile", "createfolder"}
    return False


def gofile_parse_id(raw_url: str) -> str:
    try:
        u = urllib.parse.urlparse(raw_url)
        host = (u.hostname or "").lower().replace("www.", "", 1)
        if host != "gofile.io" and not host.endswith(".gofile.io"):
            return ""
        q = urllib.parse.parse_qs(u.query)
        for key in ("c", "id", "contentId", "code"):
            for value in q.get(key, []):
                if _is_gofile_id(value):
                    return value
        segs = [urllib.parse.unquote(s) for s in u.path.split("/") if s]
        cand = ""
        if len(segs) >= 2 and segs[0] == "d":
            cand = segs[1]
        elif len(segs) >= 2 and segs[0] == "download":
            cand = segs[2] if (segs[1] == "web" and len(segs) >= 3) else segs[1]
        elif len(segs) >= 2 and segs[0] == "f":
            cand = segs[1]
        if _is_gofile_id(cand):
            return cand
        m = re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", u.path, re.I)
        return m.group(0) if m else ""
    except Exception:
        return ""


def gofile_name_from_url(raw_url: str) -> str:
    try:
        u = urllib.parse.urlparse(raw_url)
        segs = [urllib.parse.unquote(s) for s in u.path.split("/") if s]
        if len(segs) >= 3 and segs[0] == "download":
            return segs[-1]
    except Exception:
        pass
    return ""


def gofile_salt(refresh: bool = False) -> str:
    env_salt = (os.environ.get("GOFILE_WT_SALT") or "").strip()
    if env_salt:
        return env_salt
    now = time.time()
    cached = _GOFILE_SALT_CACHE.get("salt") or ""
    if not refresh and cached and now - float(_GOFILE_SALT_CACHE.get("at") or 0) < 3600:
        return cached
    try:
        code, body, _ = _fetch_text_resilient(
            "https://gofile.io/js/wt.obf.js",
            accept="application/javascript,text/javascript,*/*",
        )
        if code < 400 and body:
            decoded = re.sub(r"\\x([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), body)
            hits = re.findall(r"[0-9a-f]{12,20}", decoded)
            salt = next((s for s in hits if re.search(r"[a-f]", s) and re.search(r"\d", s)), hits[0] if hits else "")
            if salt:
                _GOFILE_SALT_CACHE.update({"salt": salt, "at": now})
                return salt
    except Exception:
        pass
    return GOFILE_DEFAULT_WT_SALT


def gofile_website_token(ua: str, token: str, salt: str = None) -> str:
    salt = salt or gofile_salt()
    slot = int(time.time() // 14400)
    raw = f"{ua}::en-US::{token}::{slot}::{salt}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def gofile_http(
    url: str,
    method: str = "GET",
    token: str = "",
    body: bytes = None,
    range_header: str = None,
    timeout: int = 40,
    allow_redirects: bool = False,
    refresh_salt: bool = False,
    extra_headers: dict = None,
):
    """Low-level Gofile HTTP call with Chrome impersonation and urllib fallback."""
    ua = DEFAULT_UA
    salt = gofile_salt(refresh=refresh_salt)
    wt = gofile_website_token(ua, token, salt)
    headers = {
        "User-Agent": ua,
        "Accept": "*/*",
        "Origin": "https://gofile.io",
        "Referer": "https://gofile.io/",
        "X-Website-Token": wt,
        "X-BL": "en-US",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["Cookie"] = f"accountToken={token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    if range_header:
        headers["Range"] = range_header
    if extra_headers:
        headers.update(extra_headers)

    try:
        _prepare_pkg_paths()
        try:
            from curl_cffi import requests as cffi_req
        except ImportError:
            _pip_install_target(["curl_cffi"], _TG_PKG_TARGET)
            from curl_cffi import requests as cffi_req
        sess = cffi_req.Session(impersonate="chrome")
        resp = sess.request(
            method,
            url,
            headers=headers,
            data=body,
            timeout=timeout,
            allow_redirects=allow_redirects,
        )
        try:
            return resp.status_code, {k.lower(): v for k, v in resp.headers.items()}, resp.content or b""
        finally:
            try:
                resp.close()
            except Exception:
                pass
    except Exception:
        pass

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    opener = urllib.request.build_opener() if allow_redirects else _NO_REDIR_OPENER
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def gofile_api_json(path_or_url: str, token: str = "", method: str = "GET", body: dict = None, refresh_salt: bool = False):
    url = path_or_url if path_or_url.startswith("http") else f"{GOFILE_API_BASE}{path_or_url}"
    payload = None
    if method.upper() != "GET":
        payload = json.dumps(body if body is not None else {}).encode("utf-8")
    status, _headers, raw = gofile_http(
        url,
        method=method,
        token=token,
        body=payload,
        timeout=40,
        allow_redirects=True,
        refresh_salt=refresh_salt,
    )
    try:
        return status, json.loads(raw.decode("utf-8", "ignore"))
    except Exception:
        return status, {"status": f"http-{status}", "raw": raw[:200].decode("utf-8", "ignore")}


def gofile_new_account() -> str:
    status, data = gofile_api_json("/accounts", method="POST", body={})
    if data.get("status") == "error-notPremium":
        status, data = gofile_api_json("/accounts", method="POST", body={}, refresh_salt=True)
    token = (data.get("data") or {}).get("token")
    if not token:
        raise RuntimeError(f"Could not create Gofile guest account (HTTP {status}, status={data.get('status')})")
    mask_secret(token)
    return token


def gofile_error_text(status: str) -> str:
    if status == "error-notPremium":
        return "Gofile rejected the guest website token (salt may have rotated)."
    if status == "error-rateLimit":
        return "Gofile rate limit reached. Try again in a few minutes."
    if status == "error-notFound":
        return "Gofile content was not found (expired, deleted, or invalid link)."
    return f"Gofile API error: {status or 'unknown'}"


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_download_url(raw_url: str) -> dict:
    cur = raw_url
    visited = set()
    for _ in range(10):
        tg = parse_telegram_post_url(cur)
        if tg:
            return tg

        gid = gofile_parse_id(cur)
        if gid:
            return {"type": "gofile", "id": gid, "url": cur, "name": gofile_name_from_url(cur)}

        gd = parse_drive_url(cur)
        if gd:
            return gd

        if is_sourceforge_url(cur):
            for sf_try in (cur, rewrite_known_direct_url(cur)):
                if not sf_try:
                    continue
                for mtd in ("HEAD", "GET"):
                    st, h_map, f_url = _probe_single(sf_try, mtd, follow=True)
                    low_h = {k.lower(): v for k, v in h_map.items()}
                    ct_h = low_h.get("content-type", "").lower()
                    cd_h = low_h.get("content-disposition", "").lower()
                    if st < 400 and ("text/html" not in ct_h or "attachment" in cd_h):
                        return {"type": "url", "url": f_url}
            return {"type": "url", "url": _resolve_sf_via_cffi(cur)}

        rewritten = rewrite_known_direct_url(cur)
        if rewritten and rewritten != cur and rewritten not in visited:
            visited.add(cur)
            cur = rewritten
            continue

        if cur in visited:
            break
        visited.add(cur)

        status, hdrs, _ = _probe_single(cur, "HEAD")
        low = {k.lower(): v for k, v in hdrs.items()}
        if 300 <= status < 400 and low.get("location"):
            cur = urllib.parse.urljoin(cur, low["location"])
            continue

        if status in (403, 405, 501) or status >= 400:
            if is_sourceforge_url(cur) and (status == 403 or low.get("cf-mitigated", "").lower() == "challenge"):
                return {"type": "url", "url": _resolve_sf_via_cffi(cur)}
            status, hdrs, _ = _probe_single(cur, "GET")
            low = {k.lower(): v for k, v in hdrs.items()}
            if 300 <= status < 400 and low.get("location"):
                cur = urllib.parse.urljoin(cur, low["location"])
                continue

        ct = low.get("content-type", "").lower()
        cd = low.get("content-disposition", "").lower()
        if "text/html" not in ct or "attachment" in cd:
            if status >= 400:
                if is_sourceforge_url(cur):
                    return {"type": "url", "url": _resolve_sf_via_cffi(cur)}
                raise RuntimeError(f"Remote server returned HTTP {status}.")
            return {"type": "url", "url": cur}

        if is_sourceforge_url(cur):
            return {"type": "url", "url": _resolve_sf_via_cffi(cur)}

        if low.get("cf-mitigated", "").lower() == "challenge":
            raise RuntimeError("Protected by anti-bot verification. Open in your browser and send the direct file link.")

        req = urllib.request.Request(cur, headers={"User-Agent": ua_for_url(cur), "Accept": "text/html,application/xhtml+xml"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            final_url = resp.geturl() or cur
            if final_url != cur:
                gd2 = parse_drive_url(final_url)
                if gd2:
                    return gd2
                cur = final_url
            body = resp.read(262144).decode("utf-8", "ignore")
            blocked = detect_challenge_page(resp.headers, body)
            if blocked:
                raise RuntimeError(blocked)

        for cand in _extract_host_candidates(cur, body):
            if _is_direct_stream(cand):
                return {"type": "url", "url": cand}

        m_meta = re.search(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+content=["\'][^"\']*url\s*=\s*([^"\'\s>]+)', body[:60000], re.I)
        if m_meta:
            redir = urllib.parse.urljoin(cur, html.unescape(m_meta.group(1).strip()))
            if redir.startswith(("http://", "https://")) and redir not in visited:
                cur = redir
                continue

        m_js = re.search(r'(?:window\.location(?:\.href)?\s*=\s*|location\.replace\(\s*)["\'](https?://[^"\']+)["\']', body[:60000], re.I)
        if m_js:
            redir = html.unescape(m_js.group(1).strip())
            if redir not in visited:
                cur = redir
                continue

        raise RuntimeError("URL points to an HTML webpage with no extractable direct file link.")
    raise RuntimeError("Too many redirects while resolving link.")


# ============================================================================
# YT-DLP MEDIA ENGINE HELPERS
# ============================================================================

YT_AUDIO_QUALITIES = {"mp3", "m4a", "opus", "flac"}
YT_MEDIA_DOMAINS = (
    "youtube.com", "youtu.be", "music.youtube.com", "instagram.com",
    "tiktok.com", "twitter.com", "x.com", "reddit.com", "v.redd.it",
    "twitch.tv", "vimeo.com", "dailymotion.com", "soundcloud.com",
    "facebook.com", "fb.watch", "bilibili.com", "rumble.com",
    "odysee.com", "kick.com", "streamable.com",
)


def is_media_site_url(raw_url: str) -> bool:
    try:
        host = (urllib.parse.urlparse(raw_url).hostname or "").lower().removeprefix("www.")
        return any(host == d or host.endswith("." + d) for d in YT_MEDIA_DOMAINS)
    except Exception:
        return False


def parse_timestamp_seconds(val: str) -> float:
    parts = [float(p) for p in val.strip().split(":")]
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    raise ValueError("Invalid timestamp")


def parse_trim_range(spec: str):
    if not spec or "-" not in spec:
        return None
    s_raw, e_raw = spec.split("-", 1)
    start = parse_timestamp_seconds(s_raw)
    end = parse_timestamp_seconds(e_raw)
    if end <= start:
        raise RuntimeError(f"Invalid trim range '{spec}': end time must be after start time.")
    return start, end


def _kill_child_procs():
    """Terminate direct child processes (e.g., aria2c/ffmpeg) on cancellation."""
    pid = str(os.getpid())
    try:
        subprocess.run(["pkill", "-TERM", "-P", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def _ytdir_written_bytes(yt_dir: Path) -> int:
    total = 0
    try:
        for p in yt_dir.iterdir():
            if not p.is_file() or p.name.endswith((".aria2", ".ytdl", ".jpg", ".jpeg", ".png", ".webp")):
                continue
            st = p.stat()
            if st.st_blocks > 0:
                total += min(st.st_size, st.st_blocks * 512)
            else:
                total += st.st_size
    except OSError:
        pass
    return total


def _is_youtube_url(url: str) -> bool:
    """Return True when the target URL belongs to YouTube."""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower().rstrip(".")
    except Exception:
        return False
    return host in ("youtu.be", "youtube.com", "youtube-nocookie.com") or host.endswith((".youtube.com", ".youtube-nocookie.com"))


def ytdl_format_spec(quality: str, container: str) -> str:
    if quality in YT_AUDIO_QUALITIES:
        return "ba/b"
    if quality in ("2160", "1440", "1080", "720", "480", "360"):
        if container == "mp4":
            return f"bv*[height<={quality}][ext=mp4]+ba[ext=m4a]/bv*[height<={quality}]+ba/b[height<={quality}]/b"
        return f"bv*[height<={quality}]+ba/b[height<={quality}]/b"
    if container == "mp4":
        return "bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b"
    return "bv*+ba/b"


def friendly_ytdl_error(msg: str) -> str:
    low = (msg or "").lower()
    if "age" in low and ("confirm" in low or "restrict" in low or "sign in" in low):
        return "This video is age-restricted and requires valid YTDL_COOKIES."
    if "sign in to confirm" in low or "not a bot" in low or "cookies" in low or "login required" in low:
        if (YTDL_COOKIES or "").strip():
            return "Cookies rejected or expired — refresh the YTDL_COOKIES GitHub secret."
        return "Site requested anti-bot verification or sign-in cookies (add YTDL_COOKIES GitHub secret)."
    if "private video" in low:
        return "This video is private."
    if "video unavailable" in low or "unavailable" in low:
        return "This video is unavailable or was removed."
    if "geo" in low and "restrict" in low:
        return "This video is geo-restricted in the runner region."
    return msg


def _json_cookies_to_netscape(items: list) -> str:
    lines = ["# Netscape HTTP Cookie File"]
    for c in items:
        if not isinstance(c, dict) or not c.get("domain") or not c.get("name"):
            continue
        domain = str(c["domain"])
        inc_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = str(c.get("path") or "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        exp_raw = c.get("expirationDate") or c.get("expiry") or 0
        try:
            exp = str(int(float(exp_raw))) if exp_raw else "0"
        except (TypeError, ValueError):
            exp = "0"
        val = str(c.get("value") or "")
        lines.append("\t".join([domain, inc_sub, path, secure, exp, str(c["name"]), val]))
    return "\n".join(lines) + "\n"


def prepare_ytdl_cookiefile(raw_cookies: str = None):
    raw = (YTDL_COOKIES if raw_cookies is None else raw_cookies) or ""
    text = raw.strip()
    if not text:
        return None

    # Allow single-line base64-encoded cookies.txt so mobile copy/paste never strips tabs/newlines
    if "\n" not in text and "\t" not in text and not text.startswith("[") and not text.startswith("#"):
        try:
            decoded = base64.b64decode(text, validate=True).decode("utf-8", "ignore").strip()
            if "\t" in decoded or decoded.startswith("#") or decoded.startswith("["):
                text = decoded
        except Exception:
            pass

    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                text = _json_cookies_to_netscape(parsed)
        except Exception:
            pass

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.lstrip().startswith("#"):
        text = "# Netscape HTTP Cookie File\n" + text
    if not text.endswith("\n"):
        text += "\n"

    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            mask_secret(s, min_len=8)

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    cookie_path = WORK_DIR / f"ytdl_cookies_{JOB_ID or 'run'}.txt"
    cookie_path.write_text(text, encoding="utf-8")
    os.chmod(cookie_path, 0o600)
    return cookie_path


_PKG_TARGET = Path("/tmp/ytdl_pkgs")
_TG_PKG_TARGET = Path("/tmp/tg_pkgs")
_DISK_EXPANDED = False
_YTDL_LOCK = threading.Lock()
_KURIGRAM_LOCK = threading.Lock()


def _prepare_pkg_paths():
    for target in (_TG_PKG_TARGET, _PKG_TARGET):
        if str(target) not in sys.path:
            sys.path.insert(0, str(target))
    user_site = site.getusersitepackages()
    if user_site and os.path.isdir(user_site):
        site.addsitedir(user_site)
    importlib.invalidate_caches()


def _pip_install_target(pkgs: list, target_dir: Path = None):
    tgt = target_dir or _PKG_TARGET
    tgt.mkdir(parents=True, exist_ok=True)
    common = ["--prefer-binary", "--no-cache-dir", "--disable-pip-version-check", "--upgrade", "-q", "--target", str(tgt)]
    res = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--break-system-packages", *common, *pkgs],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if res.returncode != 0:
        res = subprocess.run(
            [sys.executable, "-m", "pip", "install", *common, *pkgs],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(f"Failed to install {' '.join(pkgs)}: {(res.stdout or '').strip()[-400:]}")
    _prepare_pkg_paths()


def ensure_disk_space(min_free_bytes: int):
    """Expand GitHub runner disk lazily only when free space is below min_free_bytes."""
    global _DISK_EXPANDED
    if _DISK_EXPANDED or shutil.disk_usage("/").free >= min_free_bytes:
        return
    _DISK_EXPANDED = True
    cleanup_paths = [
        "/usr/share/dotnet", "/usr/local/lib/android", "/opt/ghc",
        "/opt/hostedtoolcache/CodeQL", "/usr/local/.ghcup", "/usr/share/swift", "/opt/microsoft",
    ]
    subprocess.run(["sudo", "rm", "-rf", *cleanup_paths], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["sudo", "docker", "image", "prune", "-af"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def ensure_ytdl_tools():
    with _YTDL_LOCK:
        _prepare_pkg_paths()
        need_pip = False
        try:
            import yt_dlp  # noqa: F401
            import mutagen  # noqa: F401
        except ImportError:
            need_pip = True

        need_ffmpeg = not shutil.which("ffmpeg")
        if not need_pip and not need_ffmpeg:
            return

        errs = []

        def do_pip():
            try:
                _pip_install_target(["yt-dlp[default]", "mutagen"], _PKG_TARGET)
            except Exception as e:
                errs.append(e)

        def do_ffmpeg():
            try:
                subprocess.run(["sudo", "apt-get", "update", "-qq"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                subprocess.run(["sudo", "apt-get", "install", "-y", "-qq", "ffmpeg"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            except Exception as e:
                errs.append(e)

        threads = []
        if need_pip:
            threads.append(threading.Thread(target=do_pip, daemon=True))
        if need_ffmpeg:
            threads.append(threading.Thread(target=do_ffmpeg, daemon=True))
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        if errs:
            raise errs[0]
        _prepare_pkg_paths()
        import yt_dlp  # noqa: F401


def _kurigram_crypto_ready() -> tuple[bool, str]:
    """Check whether Kurigram can import Client with an accelerated C/Rust AES backend."""
    try:
        from pyrogram import Client  # noqa: F401
        from pyrogram.crypto import aes as _aes
        backend = getattr(_aes, "_crypto_backend", None)
        if backend is not None:
            return True, getattr(backend, "__name__", str(backend))
        return False, "pyaes"
    except ImportError:
        return False, ""


def _kurigram_client_kwargs(client_cls, base_kwargs: dict) -> dict:
    """Filter Kurigram Client kwargs against installed __init__ signature for safe tuning."""
    merged = {
        "in_memory": True,
        "workers": 16,
        "max_concurrent_transmissions": 10,
        "no_updates": True,
        "sleep_threshold": 60,
        **base_kwargs,
    }
    try:
        sig = inspect.signature(client_cls.__init__)
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
            return merged
        return {k: v for k, v in merged.items() if k in sig.parameters}
    except Exception:
        return merged


def _run_async_fast(coro):
    """Run an asyncio coroutine using uvloop when installed, else standard asyncio."""
    _prepare_pkg_paths()
    try:
        import uvloop
        if hasattr(uvloop, "run"):
            return uvloop.run(coro)
    except Exception:
        pass
    return asyncio.run(coro)


def ensure_kurigram_tools():
    with _KURIGRAM_LOCK:
        _prepare_pkg_paths()
        ready, backend_name = _kurigram_crypto_ready()
        if ready:
            return

        # Kurigram 2.x uses `kuricrypt` (from extra `kurigram[fast]`) plus `uvloop`, with prebuilt
        # manylinux wheels for Python 3.10-3.15; PyPI `tgcrypto` lacks cp312+ wheels on ubuntu-latest.
        install_plans = [
            ["kurigram[fast]"],
            ["kurigram", "kuricrypt"],
            ["kurigram", "tgcrypto-pyrofork"],
            ["kurigram", "tgcrypto"],
            ["kurigram"],
        ]
        last_err = None
        for pkgs in install_plans:
            try:
                _pip_install_target(pkgs, _TG_PKG_TARGET)
                _prepare_pkg_paths()
                if "pyrogram.crypto.aes" in sys.modules:
                    importlib.reload(sys.modules["pyrogram.crypto.aes"])
                ready, backend_name = _kurigram_crypto_ready()
                if ready:
                    break
                # Kurigram installed without native crypto (e.g. kuricrypt missing); try native crypto wheel next
                if backend_name == "pyaes":
                    for crypto_pkg in ("kuricrypt", "tgcrypto-pyrofork", "tgcrypto"):
                        try:
                            _pip_install_target([crypto_pkg], _TG_PKG_TARGET)
                            importlib.reload(sys.modules["pyrogram.crypto.aes"])
                            ready, backend_name = _kurigram_crypto_ready()
                            if ready:
                                break
                        except Exception as ce:
                            last_err = ce
                    break
            except Exception as exc:
                last_err = exc

        from pyrogram import Client  # noqa: F401
        ready, backend_name = _kurigram_crypto_ready()
        has_uvloop = False
        try:
            import uvloop  # noqa: F401
            has_uvloop = True
        except Exception:
            pass
        print(
            f"[Kurigram] Ready (crypto={backend_name or 'unknown'}, uvloop={has_uvloop}"
            + (f", note={last_err}" if (not ready and last_err) else "")
            + ")",
            flush=True,
        )


def prewarm_tools_async(need_ytdl: bool = False, need_kurigram: bool = False):
    """Pre-install yt-dlp/ffmpeg and/or Kurigram in background threads while downloads run."""
    def _safe_run(fn):
        try:
            fn()
        except Exception:
            pass

    if need_ytdl:
        threading.Thread(target=_safe_run, args=(ensure_ytdl_tools,), daemon=True).start()
    if need_kurigram and BOT_TOKEN and TELEGRAM_API_ID and TELEGRAM_API_HASH:
        threading.Thread(target=_safe_run, args=(ensure_kurigram_tools,), daemon=True).start()


def probe_media_meta(path: Path) -> dict:
    meta = {"duration": 0, "width": 0, "height": 0}
    if not shutil.which("ffprobe"):
        return meta
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=15,
        )
        if res.returncode != 0 or not res.stdout:
            return meta
        info = json.loads(res.stdout)
        dur = float((info.get("format") or {}).get("duration") or 0)
        if dur > 0:
            meta["duration"] = int(round(dur))
        for st in info.get("streams") or []:
            if st.get("codec_type") == "video" and st.get("codec_name") not in ("mjpeg", "png", "webp"):
                meta["width"] = int(st.get("width") or 0)
                meta["height"] = int(st.get("height") or 0)
                if not meta["duration"] and st.get("duration"):
                    meta["duration"] = int(round(float(st["duration"])))
                break
    except Exception:
        pass
    return meta


def make_media_thumb(path: Path, out_dir: Path):
    if not shutil.which("ffmpeg"):
        return None
    thumb = out_dir / f".tgthumb_{uuid.uuid4().hex[:8]}.jpg"
    attempts = [
        ["ffmpeg", "-y", "-i", str(path), "-map", "0:v:1", "-frames:v", "1", "-vf", "scale='min(320,iw)':-2", "-q:v", "4", str(thumb)],
        ["ffmpeg", "-y", "-ss", "00:00:05", "-i", str(path), "-frames:v", "1", "-vf", "scale='min(320,iw)':-2", "-q:v", "4", str(thumb)],
        ["ffmpeg", "-y", "-ss", "00:00:00", "-i", str(path), "-frames:v", "1", "-vf", "scale='min(320,iw)':-2", "-q:v", "4", str(thumb)],
    ]
    for cmd in attempts:
        try:
            res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
            if res.returncode == 0 and thumb.is_file() and thumb.stat().st_size > 0:
                return thumb
        except Exception:
            pass
    thumb.unlink(missing_ok=True)
    return None


# ============================================================================
# MIRROR ENGINE
# ============================================================================

class Mirror:
    def __init__(self, job: dict, access_token: str, token_expiry_ms=None):
        self.job = job
        self.chat_id = job["chatId"]
        self.thread_id = job.get("threadId")
        self.is_shared_gc_temp = bool(job.get("isSharedGcTemp"))
        self.message_id = job.get("messageId")
        self.dest = job.get("dest") or "gdrive"
        self.leech_as_doc = bool(job.get("leechAsDoc"))
        self.gh_pat = (job.get("ghPat") or "").strip()
        self.gh_repo = (job.get("ghRepo") or "").strip()
        self.gh_user = (job.get("ghUser") or "").strip()
        self.gh_tag = (job.get("ghTag") or "").strip()
        self.gh_title = (job.get("ghTitle") or "").strip()
        self.gh_notes = job.get("ghNotes") or ""
        self.gh_prerelease = bool(job.get("ghPrerelease"))
        self.gh_draft = bool(job.get("ghDraft"))
        self.gh_generate_notes = bool(job.get("ghGenerateNotes"))
        self.gh_release_url = ""
        self.folder_id = job.get("folderId") or "root"
        self.folder_name = (
            (self.gh_repo or "GitHub Release")
            if self.dest == "ghrelease"
            else (
                "Telegram (Leech)"
                if self.dest == "telegram"
                else ("Gofile (Guest)" if self.dest == "gofile" else ("GC Shared (5-Day Temp)" if self.is_shared_gc_temp else (job.get("folderName") or "My Drive")))
            )
        )
        self.custom_name = (job.get("customName") or "").strip()
        self.mode = job.get("mode") or "normal"
        self.select_filter = (job.get("selectFilter") or "").strip()
        self.password = job.get("archivePassword") or ""
        self.share = bool(job.get("share"))
        conflict = job.get("conflict") or "rename"
        self.conflict = conflict if conflict in ("rename", "overwrite", "skip") else "rename"

        self.gofile_token = ""
        self.gofile_root_id = ""
        self.gofile_link = ""
        self.gofile_folders = {}
        self.gofile_src_token = ""

        items = job.get("items") or []
        if not items and job.get("fileUrl"):
            items = [{"type": "url", "url": job["fileUrl"]}]
        self.items = items
        self.batch = bool(job.get("batch")) or len(items) > 1

        self.access_token = access_token
        self.token_expiry_ms = token_expiry_ms
        self.token_time = time.time()

        self.sys_mon = SystemMonitor()
        self.task_start = time.time()
        self.last_tick = 0.0
        self.last_sync = 0.0
        self.last_card_sync = 0.0
        self.last_sync_status = ""
        self.tg_sent = 0
        self.tg_skipped = 0
        self.tg_note = ""
        self.idx = 0
        self.aria_proc = None
        self.token_srv = None
        self.token_port = 0
        self.token_lock = threading.Lock()

        for it in self.items:
            mask_secret(it.get("url", ""))
        mask_secret(self.password, min_len=3)
        mask_secret(self.gh_pat, min_len=6)

    # ---------------- Google token handling ----------------

    def start_token_server(self):
        mirror_ref = self

        class TokenHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                ok = mirror_ref.refresh_token(force=True)
                if not ok:
                    self.send_response(500)
                    self.end_headers()
                    return
                exp_in = 3300
                if mirror_ref.token_expiry_ms:
                    exp_in = max(300, int((float(mirror_ref.token_expiry_ms) - time.time() * 1000) / 1000))
                payload = json.dumps({
                    "access_token": mirror_ref.access_token,
                    "token_type": "Bearer",
                    "expires_in": exp_in,
                    "refresh_token": "worker-managed",
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.token_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), TokenHandler)
        self.token_port = self.token_srv.server_address[1]
        threading.Thread(target=self.token_srv.serve_forever, daemon=True).start()

    def stop_token_server(self):
        if self.token_srv:
            try:
                self.token_srv.shutdown()
                self.token_srv.server_close()
            except Exception:
                pass
            self.token_srv = None

    def write_rclone_conf(self):
        RCLONE_CONF.parent.mkdir(parents=True, exist_ok=True)
        if self.token_expiry_ms:
            exp_dt = datetime.fromtimestamp(float(self.token_expiry_ms) / 1000.0, tz=timezone.utc)
        else:
            exp_dt = datetime.fromtimestamp(time.time() + 45 * 60, tz=timezone.utc)
        token_json = json.dumps({
            "access_token": self.access_token,
            "token_type": "Bearer",
            "refresh_token": "worker-managed",
            "expiry": exp_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        token_url_line = f"token_url = http://127.0.0.1:{self.token_port}/token\n" if self.token_port else ""
        conf_text = (
            "[userdrive]\n"
            "type = drive\n"
            "scope = drive\n"
            "client_id = worker\n"
            "client_secret = worker\n"
            f"{token_url_line}"
            f"token = {token_json}\n"
        )
        tmp = RCLONE_CONF.with_suffix(".tmp")
        tmp.write_text(conf_text, encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, RCLONE_CONF)

    def refresh_token(self, force: bool = True) -> bool:
        with self.token_lock:
            res = worker_call("/internal/refresh", {"job_id": JOB_ID, "force": force})
            if res.get("ok") and res.get("accessToken"):
                self.access_token = res["accessToken"]
                self.token_expiry_ms = res.get("expiry") or None
                self.token_time = time.time()
                mask_secret(self.access_token)
                self.write_rclone_conf()
                return True
            return False

    def ensure_token(self, max_age: float = TOKEN_REFRESH_SECONDS):
        if time.time() - self.token_time >= max_age:
            self.refresh_token(force=True)

    # ---------------- Drive API ----------------

    def drive(self, method: str, path: str, params: dict = None, body: dict = None, resource_key: str = None, timeout: int = 60):
        p = {"supportsAllDrives": "true"}
        if params:
            p.update(params)
        url = f"https://www.googleapis.com/drive/v3/{path}?{urllib.parse.urlencode(p)}"
        for attempt in range(2):
            headers = {"Authorization": f"Bearer {self.access_token}"}
            if resource_key:
                file_id = path.split("/")[1] if path.startswith("files/") else ""
                headers["X-Goog-Drive-Resource-Keys"] = f"{file_id}/{resource_key}"
            res = http_json(url, data=body, headers=headers, method=method, timeout=timeout)
            if res.get("http_status") == 401 and attempt == 0 and self.refresh_token(force=True):
                continue
            return res
        return {}

    def find_existing(self, parent: str, name: str) -> list:
        q = f"'{parent or 'root'}' in parents and name = '{q_escape(name)}' and trashed = false"
        res = self.drive("GET", "files", {
            "q": q,
            "fields": "files(id,name,mimeType,webViewLink,size)",
            "pageSize": "10",
            "orderBy": "modifiedTime desc",
            "includeItemsFromAllDrives": "true",
        })
        return res.get("files") or []

    def free_name(self, parent: str, name: str, is_dir: bool) -> str:
        base, ext = split_name(name, is_dir)
        for n in range(1, 100):
            cand = f"{base} ({n}){ext}"
            if not self.find_existing(parent, cand):
                return cand
        return f"{base} ({int(time.time())}){ext}"

    def resolve_conflict(self, parent: str, name: str, is_dir: bool):
        """Returns (action, final_name, existing_file). action: new | overwrite | skip"""
        existing = self.find_existing(parent, name)
        if not existing:
            return "new", name, None
        ex = existing[0]
        if self.conflict == "skip":
            return "skip", name, ex
        if self.conflict == "overwrite":
            return "overwrite", name, ex
        return "new", self.free_name(parent, name, is_dir), None

    def create_folder(self, parent: str, name: str) -> str:
        res = self.drive("POST", "files", {"fields": "id"}, body={
            "name": name,
            "mimeType": FOLDER_MIME,
            "parents": [parent or "root"],
        })
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Could not create Drive folder"))
        return res["id"]

    def make_public(self, file_id: str) -> bool:
        res = self.drive("POST", f"files/{file_id}/permissions", {"fields": "id"}, body={"role": "reader", "type": "anyone"})
        return bool(res.get("id"))

    def lookup(self, parent: str, name: str):
        found = self.find_existing(parent, name)
        return found[0] if found else None

    def folder_url(self) -> str:
        if self.folder_id and self.folder_id != "root":
            return f"https://drive.google.com/drive/folders/{self.folder_id}"
        return "https://drive.google.com/drive/my-drive"

    def finalize(self, f, name: str, size: float, is_dir: bool, status: str = "completed") -> dict:
        link = self.folder_url()
        fid = ""
        if f:
            fid = f.get("id", "")
            is_dir = is_dir or f.get("mimeType") == FOLDER_MIME
            if is_dir and fid:
                link = f"https://drive.google.com/drive/folders/{fid}"
            elif f.get("webViewLink"):
                link = f["webViewLink"]
            elif fid:
                link = f"https://drive.google.com/file/d/{fid}/view"
        shared = False
        direct = ""
        if fid and self.share and status == "completed":
            shared = self.make_public(fid)
            if shared and not is_dir:
                direct = f"https://drive.google.com/uc?id={fid}&export=download"
        return {
            "name": name,
            "link": link,
            "id": fid,
            "size": size or 0,
            "status": status,
            "isDir": is_dir,
            "shared": shared,
            "direct": direct,
        }

    # ---------------- Telemetry ----------------

    def tick(self, filename, status_text, pct, done, total, speed, eta, engine, force=False):
        global cancelled
        if cancelled:
            raise InterruptedError("Cancelled by user")
        now = time.time()
        if not force and now - self.last_tick < TICK_SECONDS:
            return
        self.last_tick = now
        if self.access_token:
            self.ensure_token()

        card = build_status_card(
            job=self.job,
            filename=filename,
            status_text=status_text,
            pct=pct,
            done_bytes=done,
            total_bytes=total,
            speed_bps=speed,
            eta_sec=eta,
            engine=engine,
            elapsed_sec=now - self.task_start,
            sys_snap=self.sys_mon.snapshot(),
            batch_pos=(self.idx + 1, len(self.items)) if self.batch else None,
        )
        status_changed = (status_text != self.last_sync_status)
        need_card = force or status_changed or (now - self.last_card_sync >= 20.0)
        if need_card or (now - self.last_sync >= 5.0):
            self.last_sync = now
            self.last_sync_status = status_text
            if need_card:
                self.last_card_sync = now
            is_cancelled, synced_msg_id = sync_worker_state(JOB_ID, last_card=card if need_card else None)
            if synced_msg_id is not None:
                self.message_id = synced_msg_id
            if is_cancelled:
                cancelled = True
                raise InterruptedError("Cancelled by user")
        if self.message_id:
            edit_status(self.chat_id, self.message_id, card, status_keyboard(JOB_ID))

    # ---------------- Aria2c ----------------

    def start_aria(self):
        self.aria_proc = subprocess.Popen(
            [
                "aria2c",
                "--enable-rpc=true",
                "--rpc-listen-all=false",
                "--rpc-listen-port=6800",
                "--max-connection-per-server=16",
                "--split=16",
                "--min-split-size=1M",
                "--file-allocation=none",
                "--continue=true",
                "--allow-overwrite=true",
                "--auto-file-renaming=false",
                "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                f"--dir={DL_DIR}",
                "--quiet=true",
            ],
            stdin=subprocess.DEVNULL,
        )
        time.sleep(1.0)

    def stop_aria(self):
        if self.aria_proc:
            try:
                self.aria_proc.terminate()
            except Exception:
                pass

    def aria_download(self, url: str, dest_dir: Path, out_name: str = None, headers: list = None, label: str = None, user_agent: str = None) -> Path:
        if not self.aria_proc:
            self.start_aria()
        dest_dir.mkdir(parents=True, exist_ok=True)
        opts = {"dir": str(dest_dir)}
        if out_name:
            opts["out"] = out_name
        if headers:
            opts["header"] = headers
        if user_agent:
            opts["user-agent"] = user_agent
        elif is_sourceforge_url(url):
            opts["user-agent"] = WGET_UA
        add_res = aria2_rpc("aria2.addUri", [[url], opts])
        gid = add_res.get("result")
        if not gid:
            raise RuntimeError("Failed to start download in aria2c.")

        cur_name = out_name or label or "Downloading..."
        final_path = None
        while True:
            st = (aria2_rpc("aria2.tellStatus", [gid]).get("result")) or {}
            if st.get("followedBy"):
                gid = st["followedBy"][0]
                continue

            status = st.get("status", "active")
            total_len = int(st.get("totalLength") or 0)
            done_len = int(st.get("completedLength") or 0)
            dl_spd = int(st.get("downloadSpeed") or 0)
            files = st.get("files") or []
            if files and files[0].get("path"):
                final_path = Path(files[0]["path"])
                cur_name = final_path.name

            pct = (100.0 * done_len / total_len) if total_len > 0 else 0.0
            eta = ((total_len - done_len) / dl_spd) if (dl_spd > 0 and total_len > done_len) else None
            try:
                self.tick(cur_name, "Download..", pct, done_len, total_len, dl_spd, eta, ARIA_ENGINE)
            except InterruptedError:
                aria2_rpc("aria2.forceRemove", [gid])
                raise

            if status == "complete":
                break
            if status in ("error", "removed"):
                raise RuntimeError(f"Download failed: {st.get('errorMessage') or 'unknown aria2c error'}")
            time.sleep(1.0)

        if not final_path or not final_path.exists():
            cands = [p for p in dest_dir.iterdir() if p.is_file() and not p.name.endswith(".aria2")]
            if not cands:
                raise RuntimeError("No file found after download completed.")
            final_path = max(cands, key=lambda p: p.stat().st_mtime)
        return final_path

    # ---------------- Subprocess with live progress (7-Zip / tar) ----------------

    def run_progress(self, cmd, filename, status_text, engine, total_bytes, cwd=None, estimate_dir: Path = None):
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=cwd)
        state = {"pct": None, "buf": ""}

        def reader():
            fd = proc.stdout.fileno()
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                s = chunk.decode("utf-8", "ignore")
                state["buf"] = (state["buf"] + s)[-16000:]
                found = re.findall(r"(\d{1,3})%", s)
                if found:
                    state["pct"] = min(100.0, float(found[-1]))

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        start = time.time()
        est_pct = 0.0
        last_est = 0.0
        try:
            while proc.poll() is None:
                pct = state["pct"]
                now = time.time()
                if pct is None and estimate_dir is not None and total_bytes > 0:
                    if now - last_est >= TICK_SECONDS:
                        last_est = now
                        est_pct = min(99.0, 100.0 * path_size(estimate_dir) / total_bytes)
                    pct = est_pct
                pct = pct or 0.0
                done = total_bytes * pct / 100.0
                elapsed = max(0.001, now - start)
                speed = done / elapsed
                eta = (total_bytes - done) / speed if speed > 0 else None
                self.tick(filename, status_text, pct, done, total_bytes, speed, eta, engine)
                time.sleep(0.5)
        except InterruptedError:
            proc.kill()
            proc.wait()
            raise
        t.join(timeout=3)
        return proc.returncode, state["buf"]

    # ---------------- Rclone ----------------

    def run_rclone(self, args: list, filename: str, status_text: str, size_hint: float, engine: str = "Rclone Drive"):
        global cancelled
        log_path = WORK_DIR / "rclone.log"
        log_path.unlink(missing_ok=True)
        cmd = ["rclone", *args,
               "--rc", "--rc-addr=127.0.0.1:5572", "--rc-no-auth",
               "--drive-chunk-size=128M", "--transfers=4", "--checkers=8",
               "--drive-stop-on-upload-limit", "--drive-stop-on-download-limit",
               "--retries=3", "--low-level-retries=10",
               "--log-level=ERROR", f"--log-file={log_path}"]
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL)
        last = 0.0
        last_bytes = 0.0
        try:
            while proc.poll() is None:
                if cancelled:
                    raise InterruptedError("Cancelled by user")
                now = time.time()
                if now - last >= TICK_SECONDS:
                    last = now
                    st = http_json("http://127.0.0.1:5572/core/stats", data={}, timeout=3)
                    done = float(st.get("bytes") or 0)
                    last_bytes = max(last_bytes, done)
                    total = float(st.get("totalBytes") or size_hint or 0)
                    spd = float(st.get("speed") or 0)
                    eta = st.get("eta")
                    if total > 0:
                        pct = 100.0 * done / total
                    else:
                        tt = float(st.get("totalTransfers") or 0)
                        pct = (100.0 * float(st.get("transfers") or 0) / tt) if tt > 0 else 0.0
                    self.tick(filename, status_text, min(100.0, pct), done, total, spd, eta, engine, force=True)
                time.sleep(1.0)
        except InterruptedError:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            raise

        if proc.returncode != 0:
            tail = ""
            try:
                tail = log_path.read_text(encoding="utf-8", errors="ignore")[-4000:]
            except OSError:
                pass
            last_line = tail.strip().splitlines()[-1] if tail.strip() else ""
            raise RuntimeError(
                friendly_drive_error(tail) or f"Rclone exited with code {proc.returncode}. {last_line[-200:]}".strip()
            )
        return int(last_bytes)

    # ---------------- Upload with conflict policy ----------------

    def upload_file(self, local: Path) -> dict:
        name = local.name
        size = path_size(local)
        action, final, ex = self.resolve_conflict(self.folder_id, name, False)
        if action == "skip":
            return self.finalize(ex, name, size, False, status="skipped")
        self.run_rclone(["copyto", str(local), remote_path(self.folder_id) + final], final, "Uploading..", size)
        f = self.lookup(self.folder_id, final)
        return self.finalize(f, final, size, False)

    def upload_dir(self, local: Path) -> dict:
        name = local.name
        size = path_size(local)
        action, final, ex = self.resolve_conflict(self.folder_id, name, True)
        if action == "skip":
            return self.finalize(ex, name, size, True, status="skipped")
        if action == "overwrite" and ex and ex.get("mimeType") == FOLDER_MIME:
            target = ex["id"]
        else:
            target = self.create_folder(self.folder_id, final)
        self.run_rclone(["copy", str(local), remote_path(target)], final, "Uploading..", size)
        return self.finalize({"id": target, "name": final, "mimeType": FOLDER_MIME}, final, size, True)

    # ---------------- Gofile (per-task guest account) ----------------

    def _gofile_pick_server(self) -> str:
        res = http_json("https://api.gofile.io/servers", headers={"User-Agent": "curl/8.5.0"}, timeout=15)
        servers = ((res.get("data") or {}).get("servers")) or []
        if servers and servers[0].get("name"):
            return f"{servers[0]['name']}.gofile.io"
        return "upload.gofile.io"

    def _gofile_upload_once(self, local: Path, host: str, path: str, folder_id: str = "", label: str = "") -> dict:
        global cancelled
        boundary = uuid.uuid4().hex
        parts = []
        if folder_id:
            parts.append(
                f'--{boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n{folder_id}\r\n'.encode("utf-8")
            )
        safe_name = local.name.replace('"', "_").replace("\r", "").replace("\n", "")
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{safe_name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode("utf-8")
        )
        prefix = b"".join(parts)
        suffix = f"\r\n--{boundary}--\r\n".encode("utf-8")
        file_size = local.stat().st_size
        total_len = len(prefix) + file_size + len(suffix)
        disp_name = label or local.name

        conn = http.client.HTTPSConnection(host, 443, timeout=180)
        try:
            conn.putrequest("POST", path)
            conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
            conn.putheader("Content-Length", str(total_len))
            conn.putheader("User-Agent", "curl/8.5.0")
            conn.putheader("Accept", "*/*")
            if self.gofile_token:
                conn.putheader("Authorization", f"Bearer {self.gofile_token}")
            conn.endheaders()
            conn.send(prefix)

            sent = 0
            start = time.time()
            with open(local, "rb") as f:
                while True:
                    if cancelled:
                        raise InterruptedError("Cancelled by user")
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    conn.send(chunk)
                    sent += len(chunk)
                    now = time.time()
                    elapsed = max(0.001, now - start)
                    speed = sent / elapsed
                    pct = (100.0 * sent / file_size) if file_size > 0 else 100.0
                    eta = ((file_size - sent) / speed) if (speed > 0 and file_size > sent) else None
                    self.tick(disp_name, "Uploading..", min(99.9, pct), sent, file_size, speed, eta, "Gofile Stream")

            conn.send(suffix)
            self.tick(disp_name, "Finalizing..", 99.9, file_size, file_size, 0, None, "Gofile Stream", force=True)
            resp = conn.getresponse()
            raw = resp.read().decode("utf-8", "replace")
            if resp.status in (301, 302, 307, 308):
                loc = resp.getheader("Location")
                if loc:
                    u = urllib.parse.urlparse(loc)
                    if u.hostname:
                        return self._gofile_upload_once(local, u.hostname, u.path or "/uploadfile", folder_id, label)
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {}
            if resp.status >= 400 or parsed.get("status") != "ok":
                err_code = parsed.get("status") or f"HTTP {resp.status}"
                raise RuntimeError(f"Gofile upload failed ({err_code}): {raw[:180]}")
            return parsed.get("data") or {}
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def gofile_upload_file(self, local: Path, folder_id: str = "", label: str = "") -> dict:
        last_err = None
        targets = [("upload.gofile.io", "/uploadfile")]
        for attempt in range(3):
            if attempt > 0:
                srv_host = self._gofile_pick_server()
                targets.append((srv_host, "/contents/uploadfile" if srv_host != "upload.gofile.io" else "/uploadfile"))
            host, path = targets[-1]
            try:
                data = self._gofile_upload_once(local, host, path, folder_id=folder_id, label=label)
                if not self.gofile_token and data.get("guestToken"):
                    self.gofile_token = data["guestToken"]
                    mask_secret(self.gofile_token)
                if not self.gofile_root_id and data.get("parentFolder"):
                    self.gofile_root_id = data["parentFolder"]
                    self.gofile_link = data.get("downloadPage") or f"https://gofile.io/d/{data.get('parentFolderCode', '')}"
                    self.gofile_folders[""] = self.gofile_root_id
                return data
            except InterruptedError:
                raise
            except Exception as e:
                last_err = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(str(last_err or "Gofile upload failed"))

    def gofile_create_folder(self, parent_id: str, name: str) -> str:
        res = http_json(
            "https://api.gofile.io/contents/createFolder",
            data={"parentFolderId": parent_id, "folderName": name},
            headers={"Authorization": f"Bearer {self.gofile_token}", "User-Agent": "curl/8.5.0"},
            method="POST",
            timeout=30,
        )
        fid = (res.get("data") or {}).get("id")
        if res.get("status") != "ok" or not fid:
            raise RuntimeError(f"Gofile folder creation failed ({res.get('status') or 'error'})")
        return fid

    def gofile_ensure_dir(self, rel_dir: Path) -> str:
        key = str(rel_dir)
        if key in ("", "."):
            return self.gofile_root_id
        if key in self.gofile_folders:
            return self.gofile_folders[key]
        parent_id = self.gofile_ensure_dir(rel_dir.parent)
        fid = self.gofile_create_folder(parent_id, rel_dir.name)
        self.gofile_folders[key] = fid
        return fid

    def upload_gofile(self, target: Path) -> dict:
        if target.is_file():
            size = path_size(target)
            d = self.gofile_upload_file(target, folder_id=self.gofile_root_id)
            return {
                "name": target.name,
                "link": d.get("downloadPage") or self.gofile_link,
                "id": d.get("id", ""),
                "size": size,
                "status": "completed",
                "isDir": False,
                "shared": True,
                "direct": "",
            }

        files = sorted(
            [p for p in target.rglob("*") if p.is_file()],
            key=lambda p: (len(p.relative_to(target).parts), str(p)),
        )
        if not files:
            raise RuntimeError("Directory is empty — nothing to upload.")

        total_size = path_size(target)
        for f in files:
            rel = f.relative_to(target)
            rel_parent = rel.parent
            if not self.gofile_root_id:
                self.gofile_upload_file(f, folder_id="", label=str(rel))
            else:
                fid = self.gofile_ensure_dir(rel_parent) if str(rel_parent) != "." else self.gofile_root_id
                self.gofile_upload_file(f, folder_id=fid, label=str(rel))

        return {
            "name": target.name,
            "link": self.gofile_link,
            "id": self.gofile_root_id,
            "size": total_size,
            "status": "completed",
            "isDir": True,
            "shared": True,
            "direct": "",
        }

    def upload(self, target: Path):
        if self.dest == "ghrelease":
            return self.upload_github_release(target)
        if self.dest == "telegram":
            return self.upload_telegram(target)
        if self.dest == "gofile":
            return self.upload_gofile(target)
        self.ensure_token(max_age=10 * 60)
        return self.upload_dir(target) if target.is_dir() else self.upload_file(target)

    # ---------------- Google Drive sources ----------------

    def gdrive_meta(self, item: dict) -> dict:
        res = self.drive(
            "GET", f"files/{item['id']}",
            {"fields": "id,name,mimeType,size,webViewLink"},
            resource_key=item.get("resourceKey"),
        )
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Could not read Google Drive link"))
        return res

    def gdrive_copy_file(self, item: dict, meta: dict, name: str) -> dict:
        size = int(meta.get("size") or 0)
        self.tick(name, "Server Copy..", 50.0, 0, size, 0, None, "Drive Server-Side", force=True)
        action, final, ex = self.resolve_conflict(self.folder_id, name, False)
        if action == "skip":
            return self.finalize(ex, name, size, False, status="skipped")
        if action == "overwrite" and ex:
            self.drive("PATCH", f"files/{ex['id']}", {"fields": "id"}, body={"trashed": True})
        res = self.drive(
            "POST", f"files/{meta['id']}/copy",
            {"fields": "id,name,mimeType,webViewLink,size"},
            body={"name": final, "parents": [self.folder_id or "root"]},
            resource_key=item.get("resourceKey"),
            timeout=600,
        )
        if not res.get("id"):
            raise RuntimeError(drive_error_text(res, "Drive copy failed"))
        return self.finalize(res, final, int(res.get("size") or size), False)

    def gdrive_clone_folder(self, meta: dict, name: str) -> dict:
        action, final, ex = self.resolve_conflict(self.folder_id, name, True)
        if action == "skip":
            return self.finalize(ex, name, 0, True, status="skipped")
        if action == "overwrite" and ex and ex.get("mimeType") == FOLDER_MIME:
            target = ex["id"]
        else:
            target = self.create_folder(self.folder_id, final)
        rclone_bytes = self.run_rclone(
            ["copy", remote_path(meta["id"]), remote_path(target), "--drive-server-side-across-configs"],
            final, "Cloning..", 0, engine="Drive Server-Side",
        )
        f = {"id": target, "name": final, "mimeType": FOLDER_MIME}
        size = rclone_bytes
        if size <= 0:
            sz = self.drive("GET", "files", {
                "q": f"'{target}' in parents and trashed = false",
                "fields": "files(size)",
                "pageSize": "1000",
            })
            for x in sz.get("files") or []:
                size += int(x.get("size") or 0)
        return self.finalize(f, final, size, True)

    def gdrive_download_file(self, item: dict, meta: dict, dest_dir: Path, name: str) -> Path:
        self.ensure_token(max_age=5 * 60)  # aria2 headers are fixed for the whole download
        url = f"https://www.googleapis.com/drive/v3/files/{meta['id']}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true"
        headers = [f"Authorization: Bearer {self.access_token}"]
        if item.get("resourceKey"):
            headers.append(f"X-Goog-Drive-Resource-Keys: {meta['id']}/{item['resourceKey']}")
        return self.aria_download(url, dest_dir, out_name=name, headers=headers)

    def gdrive_download_folder(self, meta: dict, dest_dir: Path, name: str) -> Path:
        local = dest_dir / name
        local.mkdir(parents=True, exist_ok=True)
        self.ensure_token(max_age=10 * 60)
        self.run_rclone(["copy", remote_path(meta["id"]), str(local)], name, "Download..", 0)
        return local

    # ---------------- Archive processing ----------------

    def extract(self, archive: Path):
        name = archive.name
        size = path_size(archive)
        out = OUT_DIR / archive_stem(name)
        if out.exists():
            out = OUT_DIR / f"{archive_stem(name)}_{self.idx + 1}"
        out.mkdir(parents=True, exist_ok=True)

        low = name.lower()
        if low.endswith(TAR_SUFFIXES):
            rc, _ = self.run_progress(["tar", "-xf", str(archive), "-C", str(out)], name, "Extracting..", "GNU tar", size, estimate_dir=out)
            ok = rc == 0
        else:
            cmd = ["7z", "x", "-y", "-bsp1", "-bb0", f"-o{out}", str(archive)]
            if self.password:
                cmd.insert(2, f"-p{self.password}")
            rc, output = self.run_progress(cmd, name, "Extracting..", "7-Zip Engine", size, estimate_dir=out)
            lower = output.lower()
            if rc not in (0, 1) and ("wrong password" in lower or "enter password" in lower or "encrypted" in lower):
                shutil.rmtree(out, ignore_errors=True)
                raise RuntimeError(
                    "Wrong archive password." if self.password
                    else "Archive is password-protected. Set a password in the task options."
                )
            ok = rc in (0, 1) and any(out.iterdir())
            if not ok:
                shutil.rmtree(out, ignore_errors=True)
                out.mkdir(parents=True, exist_ok=True)
                rc2, _ = self.run_progress(["tar", "-xf", str(archive), "-C", str(out)], name, "Extracting..", "GNU tar", size, estimate_dir=out)
                ok = rc2 == 0

        if not ok:
            shutil.rmtree(out, ignore_errors=True)
            send_message(
                self.chat_id,
                f"<blockquote><b>Extraction Notice</b>\n\n<code>{html.escape(name)}</code>\n\n"
                f"Unsupported or corrupted archive. Uploading original file instead.</blockquote>",
            )
            return archive

        archive.unlink(missing_ok=True)

        if self.select_filter:
            exts = [e.strip().lower() for e in self.select_filter.split(",") if e.strip()]
            exts = [e if e.startswith(".") else "." + e for e in exts]
            if exts:
                for root, _, files_in_dir in os.walk(out):
                    for fn in files_in_dir:
                        if not any(fn.lower().endswith(ext) for ext in exts):
                            try:
                                (Path(root) / fn).unlink()
                            except OSError:
                                pass
                if path_size(out) == 0 and not any(p.is_file() for p in out.rglob("*")):
                    raise RuntimeError("No extracted files matched the Select filter.")
        return out

    def make_zip(self, sources: list, zip_name: str, cwd: Path, total_bytes: int):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        zip_path = OUT_DIR / zip_name
        zip_path.unlink(missing_ok=True)
        cmd = ["7z", "a", "-tzip", "-mx=1", "-bsp1", "-bb0"]
        if self.password:
            cmd += [f"-p{self.password}", "-mem=AES256"]
        cmd += [str(zip_path), *sources]
        rc, _ = self.run_progress(cmd, zip_name, "Archiving ZIP", "7-Zip Fast", total_bytes, cwd=str(cwd))
        if rc in (0, 1) and zip_path.exists():
            return zip_path
        return None

    # ---------------- Item pipeline ----------------

    def item_label(self, item: dict) -> str:
        if item.get("name"):
            return item["name"]
        if item.get("type") == "gdrive":
            return f"drive:{item.get('id', '')}"
        if item.get("type") == "tg_media":
            return f"tg:{item.get('chatId', '')}/{item.get('messageId', '')}"
        try:
            seg = urllib.parse.urlparse(item.get("url", "")).path.rstrip("/").split("/")[-1]
            return urllib.parse.unquote(seg) or "link"
        except Exception:
            return "link"

    def single_name(self):
        return self.custom_name if (self.custom_name and not self.batch) else None

    def ytdl_download(self, url: str, dest_dir: Path):
        global cancelled
        self.tick(self.job.get("detectedName") or "Media", "Setting up yt-dlp..", 0.0, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
        prewarm_tools_async(need_kurigram=True)
        ensure_ytdl_tools()
        import yt_dlp
        from yt_dlp.utils import DownloadCancelled, download_range_func

        yt_dir = dest_dir / f"yt_{self.idx}"
        yt_dir.mkdir(parents=True, exist_ok=True)

        quality = self.job.get("ytQuality") or "best"
        container = self.job.get("ytContainer") or "mp4"
        is_audio = quality in YT_AUDIO_QUALITIES
        use_subs = bool(self.job.get("ytSubs")) and not is_audio
        sub_lang = (self.job.get("ytSubLang") or "en").strip() or "en"
        use_meta = self.job.get("ytMeta", True) is not False
        use_sb = bool(self.job.get("ytSponsorBlock"))
        pl_mode = self.job.get("ytPlaylist") or "single"
        pl_items = (self.job.get("ytPlaylistItems") or "").strip()
        trim_spec = (self.job.get("ytTrim") or "").strip()

        postprocessors = []
        if is_audio:
            postprocessors.append({
                "key": "FFmpegExtractAudio",
                "preferredcodec": quality,
                "preferredquality": "0",
            })
        if use_sb:
            cats = ["sponsor", "selfpromo", "interaction"]
            postprocessors.append({"key": "SponsorBlock", "categories": cats})
            postprocessors.append({"key": "ModifyChapters", "remove_sponsor_segments": cats})
        if use_subs and container in ("mp4", "mkv"):
            postprocessors.append({"key": "FFmpegEmbedSubtitle"})
        if use_meta:
            postprocessors.append({"key": "FFmpegMetadata", "add_chapters": True, "add_metadata": True})
            postprocessors.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})

        state = {
            "title": self.job.get("detectedName") or "Media",
            "playlist_title": "",
            "native_tick_at": time.time(),
            "phase": "Downloading (16x)..",
            "engine": "yt-dlp (16x)",
            "dl_phase": "Downloading (16x)..",
            "dl_engine": "yt-dlp (16x)",
        }

        def progress_hook(d):
            global cancelled
            if cancelled:
                raise DownloadCancelled("Cancelled by user")
            info = d.get("info_dict") or {}
            title = info.get("title") or state["title"]
            p_idx = info.get("playlist_index")
            p_cnt = info.get("n_entries")
            if p_idx and p_cnt and p_cnt > 1:
                disp = f"[{p_idx}/{p_cnt}] {title}"
            else:
                disp = title
            state["title"] = disp

            st = d.get("status")
            if st == "downloading":
                state["native_tick_at"] = time.time()
                done = float(d.get("downloaded_bytes") or 0)
                total = float(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
                spd = float(d.get("speed") or 0)
                eta = d.get("eta")
                pct = (100.0 * done / total) if total > 0 else 0.0
                try:
                    self.tick(disp, state["dl_phase"], min(99.9, pct), done, total, spd, eta, state["dl_engine"])
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")
            elif st == "finished":
                state["native_tick_at"] = time.time()
                state["phase"] = "Processing.."
                total = float(d.get("total_bytes") or d.get("downloaded_bytes") or 0)
                try:
                    self.tick(disp, "Processing..", 99.0, total, total, 0, None, state["dl_engine"], force=True)
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")

        def post_hook(d):
            global cancelled
            if cancelled:
                raise DownloadCancelled("Cancelled by user")
            st = d.get("status")
            if st == "started":
                state["native_tick_at"] = time.time()
                state["phase"] = "Merging (FFmpeg).."
                state["engine"] = "yt-dlp + FFmpeg"
                try:
                    self.tick(state["title"], "Merging (FFmpeg)..", 99.5, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
                except InterruptedError:
                    cancelled = True
                    raise DownloadCancelled("Cancelled by user")
            elif st == "finished":
                state["native_tick_at"] = time.time()
                state["phase"] = state["dl_phase"]
                state["engine"] = state["dl_engine"]

        def build_ydl_opts(use_aria: bool, use_dashy: bool) -> dict:
            opts = {
                "format": ytdl_format_spec(quality, container),
                "outtmpl": str(yt_dir / "%(title).150B [%(id)s].%(ext)s"),
                "restrictfilenames": False,
                "noplaylist": (pl_mode != "all"),
                "ignoreerrors": (pl_mode == "all"),
                "writethumbnail": use_meta,
                "postprocessors": postprocessors,
                "progress_hooks": [progress_hook],
                "postprocessor_hooks": [post_hook],
                "concurrent_fragment_downloads": 16,
                "http_chunk_size": 10 * 1024 * 1024,
                "buffersize": 1024 * 1024,
                "retries": 10,
                "fragment_retries": 10,
                "file_access_retries": 5,
                "extractor_retries": 5,
                "quiet": True,
                "no_warnings": True,
                "noprogress": True,
            }
            if use_dashy:
                # Split YouTube HTTPS streams into 10 MiB &range= DASH segments for 16x native concurrency
                opts["extractor_args"] = {"youtube": {"formats": ["dashy"]}}
            elif use_aria:
                opts["external_downloader"] = {"http": "aria2c", "https": "aria2c"}
                opts["external_downloader_args"] = {
                    "aria2c": [
                        "-x", "16", "-s", "16", "-k", "1M",
                        "--file-allocation=none",
                        "--max-tries=5", "--retry-wait=2",
                        "--connect-timeout=15", "--timeout=30",
                        "--summary-interval=0",
                    ]
                }
            if shutil.which("node"):
                opts["js_runtimes"] = {"node": {}}
            if not is_audio and container in ("mp4", "mkv"):
                opts["merge_output_format"] = container
            if use_subs:
                opts["writesubtitles"] = True
                opts["writeautomaticsub"] = True
                opts["subtitleslangs"] = [s.strip() for s in sub_lang.split(",") if s.strip()] or ["en"]
                opts["subtitlesformat"] = "srt/best"
            if pl_mode == "all" and pl_items:
                opts["playlist_items"] = pl_items
            if trim_spec:
                rng = parse_trim_range(trim_spec)
                if rng:
                    opts["download_ranges"] = download_range_func(None, [rng])
                    opts["force_keyframes_at_cuts"] = True
            return opts

        is_yt = _is_youtube_url(url)
        use_dashy_primary = is_yt and not trim_spec
        use_aria_primary = bool(shutil.which("aria2c")) and not is_yt and not trim_spec
        cookie_path = prepare_ytdl_cookiefile()

        def run_ydl(use_aria: bool, use_dashy: bool):
            global cancelled
            opts = build_ydl_opts(use_aria, use_dashy)
            if cookie_path:
                opts["cookiefile"] = str(cookie_path)
            dl_engine = "yt-dlp (16x)" if use_dashy else ("yt-dlp + Aria2c" if use_aria else "yt-dlp + FFmpeg")
            dl_phase = "Downloading (16x).." if (use_dashy or use_aria) else "Downloading.."
            state["engine"] = dl_engine
            state["phase"] = dl_phase
            state["dl_engine"] = dl_engine
            state["dl_phase"] = dl_phase

            stop_mon = threading.Event()

            def monitor():
                global cancelled
                prev_bytes = _ytdir_written_bytes(yt_dir)
                prev_t = time.time()
                while not stop_mon.wait(1.0):
                    if cancelled:
                        _kill_child_procs()
                        break
                    now = time.time()
                    if now - state["native_tick_at"] < 3.0:
                        prev_bytes = _ytdir_written_bytes(yt_dir)
                        prev_t = now
                        continue
                    cur_bytes = _ytdir_written_bytes(yt_dir)
                    dt = max(0.001, now - prev_t)
                    spd = max(0.0, (cur_bytes - prev_bytes) / dt)
                    prev_bytes = cur_bytes
                    prev_t = now
                    try:
                        self.tick(state["title"], state["phase"], 0.0, cur_bytes, 0, spd, None, state["engine"])
                    except InterruptedError:
                        cancelled = True
                        _kill_child_procs()
                        break

            mon_thread = threading.Thread(target=monitor, daemon=True)
            mon_thread.start()
            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(url, download=True)
                    if isinstance(info, dict):
                        state["playlist_title"] = info.get("title") or ""
            finally:
                stop_mon.set()
                mon_thread.join(timeout=2)

        try:
            try:
                run_ydl(use_aria_primary, use_dashy_primary)
            except DownloadCancelled:
                raise
            except Exception:
                if cancelled or not (use_aria_primary or use_dashy_primary):
                    raise
                # Accelerated path failed (e.g. live/no-clen YouTube or strict CDN); clean partial files and fall back
                for p in list(yt_dir.iterdir()):
                    if p.is_file() and (p.name.endswith((".aria2", ".part", ".temp")) or ".part-Frag" in p.name):
                        p.unlink(missing_ok=True)
                state["native_tick_at"] = time.time()
                self.tick(state["title"], "Retrying (Native)..", 0.0, 0, 0, 0, None, "yt-dlp + FFmpeg", force=True)
                run_ydl(False, False)
        except DownloadCancelled:
            raise InterruptedError("Cancelled by user")
        except Exception as e:
            if cancelled:
                raise InterruptedError("Cancelled by user")
            raise RuntimeError(friendly_ytdl_error(str(e)))
        finally:
            if cookie_path:
                cookie_path.unlink(missing_ok=True)

        if cancelled:
            raise InterruptedError("Cancelled by user")

        files = [
            p for p in yt_dir.iterdir()
            if p.is_file() and not p.name.endswith((".part", ".ytdl", ".temp"))
        ]
        # Drop stray unembedded thumbnail images if actual media files exist
        media_files = [p for p in files if p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp")]
        if media_files:
            for img in files:
                if img not in media_files:
                    img.unlink(missing_ok=True)
            files = media_files

        if not files:
            raise RuntimeError("yt-dlp finished without producing any downloadable media file.")

        if len(files) == 1:
            f = files[0]
            custom = self.single_name()
            if custom:
                has_ext = "." in Path(custom).name and len(Path(custom).suffix) <= 10
                new_name = custom if has_ext else f"{custom}{f.suffix}"
                renamed = f.with_name(new_name)
                if renamed != f:
                    f.rename(renamed)
                    f = renamed
            return f

        # Multiple files (playlist or external subtitle files): wrap in a cleanly named folder
        raw_dir_name = self.single_name() or state["playlist_title"] or f"Playlist_{JOB_ID}"
        safe_dir_name = re.sub(r'[/\\?%*:|"<>]', "_", raw_dir_name).strip() or f"Playlist_{JOB_ID}"
        bundle = dest_dir / safe_dir_name
        if bundle.exists():
            bundle = dest_dir / f"{safe_dir_name}_{self.idx + 1}"
        bundle.mkdir(parents=True, exist_ok=True)
        for f in files:
            shutil.move(str(f), str(bundle / f.name))
        shutil.rmtree(yt_dir, ignore_errors=True)
        return bundle

    def resolve_item(self, item: dict) -> dict:
        if item.get("_resolved") or item.get("type") in ("gdrive", "ytdl", "tg_media", "sf_folder", "gofile"):
            return item
        target = item.get("sourceUrl") or item.get("url") or ""
        if not target:
            return item
        gid = gofile_parse_id(target)
        if gid:
            return {
                "type": "gofile",
                "id": gid,
                "url": target,
                "name": item.get("name") or gofile_name_from_url(target),
                "_resolved": True,
            }
        tg = parse_telegram_post_url(target)
        if tg:
            tg["_resolved"] = True
            return tg
        if is_media_site_url(target):
            return {"type": "ytdl", "url": target, "name": item.get("name") or target, "_resolved": True}
        # Only resolve on runner when batch (not pre-resolved) or sourceUrl is present (IP-bound page extractor)
        if not self.batch and not item.get("sourceUrl"):
            return item
        try:
            resolved = resolve_download_url(target)
            if resolved.get("type") in ("gdrive", "tg_media", "gofile"):
                resolved["_resolved"] = True
                return resolved
            if resolved.get("url"):
                updated = dict(item)
                updated["url"] = resolved["url"]
                updated["_resolved"] = True
                return updated
        except Exception as e:
            cur_u = item.get("url") or ""
            if item.get("sourceUrl") and cur_u and not is_sourceforge_url(cur_u):
                return item
            raise RuntimeError(str(e))
        return item

    # ---------------- Gofile sources ----------------

    def gofile_src_account(self, force: bool = False) -> str:
        if force or not self.gofile_src_token:
            self.gofile_src_token = gofile_new_account()
        return self.gofile_src_token

    def gofile_src_list(self, content_id: str) -> dict:
        cid = urllib.parse.quote(str(content_id))
        page = 1
        children = {}
        first = None
        while page <= 50:
            url = (
                f"/contents/{cid}?cache=true&sortField=createTime&sortDirection=1"
                f"&page={page}&pageSize=1000"
            )
            status, data = gofile_api_json(url, token=self.gofile_src_account())
            if data.get("status") == "error-notPremium":
                self.gofile_src_account(force=True)
                status, data = gofile_api_json(
                    url, token=self.gofile_src_account(), refresh_salt=True
                )
            if data.get("status") != "ok":
                raise RuntimeError(gofile_error_text(data.get("status")))
            d = data.get("data") or {}
            if d.get("canAccess") is False:
                raise RuntimeError("Gofile content is not publicly accessible.")
            if first is None:
                first = d
            batch = d.get("children") or {}
            children.update(batch)
            total = int(d.get("childrenCount") or 0)
            if not batch or (total > 0 and len(children) >= total):
                break
            page += 1
        if first is None:
            raise RuntimeError("Gofile content was not found.")
        first["children"] = children
        return first

    def gofile_probe_link(self, link: str, token: str):
        status, headers, _body = gofile_http(
            link,
            token=token,
            range_header="bytes=0-0",
            timeout=40,
            allow_redirects=False,
        )
        ctype = str(headers.get("content-type") or "").lower()
        if status in (200, 206) and "text/html" not in ctype:
            return True, headers
        return False, headers

    def _gofile_stream_download(self, link: str, out_path: Path, token: str, size_hint: int = 0, label: str = "") -> Path:
        global cancelled
        out_path.parent.mkdir(parents=True, exist_ok=True)
        ua = DEFAULT_UA
        headers = {
            "User-Agent": ua,
            "Accept": "*/*",
            "Origin": "https://gofile.io",
            "Referer": "https://gofile.io/",
            "X-Website-Token": gofile_website_token(ua, token),
            "X-BL": "en-US",
            "Authorization": f"Bearer {token}",
            "Cookie": f"accountToken={token}",
        }
        _prepare_pkg_paths()
        try:
            from curl_cffi import requests as cffi_req
        except ImportError:
            _pip_install_target(["curl_cffi"], _TG_PKG_TARGET)
            from curl_cffi import requests as cffi_req

        sess = cffi_req.Session(impersonate="chrome")
        resp = sess.get(link, headers=headers, stream=True, timeout=120, allow_redirects=False)
        try:
            if resp.status_code not in (200, 206):
                raise RuntimeError(f"Gofile download failed (HTTP {resp.status_code}).")
            ctype = str(resp.headers.get("content-type") or "").lower()
            if "text/html" in ctype:
                raise RuntimeError("Gofile returned the share page instead of the file.")
            total = int(resp.headers.get("content-length") or size_hint or 0)
            done = 0
            started = time.time()
            with open(out_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1024 * 256):
                    if cancelled:
                        raise InterruptedError("Cancelled by user")
                    if not chunk:
                        continue
                    f.write(chunk)
                    done += len(chunk)
                    elapsed = max(0.001, time.time() - started)
                    speed = done / elapsed
                    pct = (100.0 * done / total) if total > 0 else 0.0
                    eta = ((total - done) / speed) if speed > 0 and total > done else None
                    self.tick(out_path.name, "Download..", pct, done, total, speed, eta, "Gofile API")
        finally:
            try:
                resp.close()
            except Exception:
                pass
        return out_path

    def gofile_download_file(self, item: dict, dest_dir: Path, out_name: str = None, label: str = None) -> Path:
        global cancelled
        content_id = str(item.get("id") or "")
        link = str(item.get("link") or "")
        name = out_name or item.get("name") or f"gofile_{content_id[:8] or 'file'}"
        name = re.sub(r'[/\\?%*:|"<>]', "_", str(name)).strip() or f"gofile_{JOB_ID}"
        size_hint = int(item.get("size") or 0)
        md5 = str(item.get("md5") or "").lower()
        token = self.gofile_src_account()
        dest_dir.mkdir(parents=True, exist_ok=True)

        authorized = False
        for attempt in range(4):
            if cancelled:
                raise InterruptedError("Cancelled by user")
            if link:
                ok, _headers = self.gofile_probe_link(link, token)
                if ok:
                    authorized = True
                    break
            # Re-list the file itself; this re-authorizes its store link for the token.
            try:
                fresh = self.gofile_src_list(content_id) if content_id else {}
                if fresh.get("link"):
                    link = fresh["link"]
                token = self.gofile_src_account()
            except Exception:
                if attempt >= 2:
                    break
            if attempt >= 1:
                token = self.gofile_src_account(force=True)
            time.sleep(1.0 + attempt)
        if not authorized:
            raise RuntimeError("Gofile did not authorize the download link (it redirected to the share page).")

        ua = DEFAULT_UA
        headers_list = [
            f"Authorization: Bearer {token}",
            f"Cookie: accountToken={token}",
            "Referer: https://gofile.io/",
            "Origin: https://gofile.io",
            f"X-Website-Token: {gofile_website_token(ua, token)}",
            "X-BL: en-US",
        ]
        try:
            local = self.aria_download(
                link,
                dest_dir,
                out_name=name,
                headers=headers_list,
                label=label or name,
                user_agent=ua,
            )
        except InterruptedError:
            raise
        except Exception:
            local = self._gofile_stream_download(link, dest_dir / name, token, size_hint, label or name)

        if not local.exists() or local.stat().st_size <= 0:
            raise RuntimeError("Gofile download produced an empty file.")
        got_size = local.stat().st_size
        if size_hint > 0 and got_size < int(size_hint * 0.99):
            raise RuntimeError(f"Gofile download incomplete ({got_size} of {size_hint} bytes).")
        if md5:
            got_md5 = md5_file(local)
            if got_md5 and got_md5 != md5:
                raise RuntimeError(f"Gofile MD5 mismatch (expected {md5[:8]}…, got {got_md5[:8]}…).")
        return local

    def _gofile_walk_folder(self, folder: dict, out_dir: Path, depth: int = 0):
        global cancelled
        if depth > 25:
            return
        children = folder.get("children") or {}
        if not children and int(folder.get("childrenCount") or 0) > 0 and folder.get("id"):
            folder = self.gofile_src_list(folder["id"])
            children = folder.get("children") or {}
        folders = [c for c in children.values() if isinstance(c, dict) and c.get("type") == "folder"]
        files = [c for c in children.values() if isinstance(c, dict) and c.get("type") == "file"]
        folders.sort(key=lambda c: str(c.get("name") or "").lower())
        files.sort(key=lambda c: str(c.get("name") or "").lower())

        for child in folders:
            if cancelled:
                raise InterruptedError("Cancelled by user")
            sub_name = re.sub(r'[/\\?%*:|"<>]', "_", str(child.get("name") or child.get("id") or "folder")).strip() or "folder"
            sub_dir = out_dir / sub_name
            sub_dir.mkdir(parents=True, exist_ok=True)
            self._gofile_walk_folder(child, sub_dir, depth + 1)

        total = len(files)
        for idx, child in enumerate(files, 1):
            if cancelled:
                raise InterruptedError("Cancelled by user")
            fname = re.sub(r'[/\\?%*:|"<>]', "_", str(child.get("name") or child.get("id") or f"file_{idx}")).strip() or f"file_{idx}"
            target = out_dir / fname
            if target.exists():
                stem, suffix = target.stem, target.suffix
                n = 2
                while target.exists():
                    target = out_dir / f"{stem} ({n}){suffix}"
                    n += 1
                fname = target.name
            label = f"[{idx}/{total}] {fname}" if total > 1 else fname
            self.gofile_download_file(child, out_dir, out_name=fname, label=label)

    def gofile_download_item(self, item: dict, dest_dir: Path) -> Path:
        content_id = str(item.get("id") or gofile_parse_id(item.get("url") or ""))
        if not content_id:
            raise RuntimeError("Could not parse the Gofile content ID.")
        self.tick(
            item.get("name") or "Gofile",
            "Inspecting Gofile..",
            0.0, 0, 0, 0, None,
            "Gofile API",
            force=True,
        )
        data = self.gofile_src_list(content_id)
        is_folder = data.get("type") == "folder"
        root_name = self.single_name() or data.get("name") or f"Gofile_{content_id[:8]}"
        root_name = re.sub(r'[/\\?%*:|"<>]', "_", str(root_name)).strip() or f"Gofile_{content_id[:8]}"

        if not is_folder:
            return self.gofile_download_file(
                data,
                dest_dir,
                out_name=(self.single_name() or data.get("name")),
                label=self.item_label(item),
            )

        out_root = dest_dir / root_name
        out_root.mkdir(parents=True, exist_ok=True)
        self._gofile_walk_folder(data, out_root, depth=0)
        if not any(p.is_file() for p in out_root.rglob("*")):
            raise RuntimeError("This Gofile folder is empty.")
        return out_root

    def sf_folder_download(self, item: dict, dest_dir: Path) -> Path:
        folder_url = item.get("url") or ""
        project = item.get("project") or ""
        rel_path = (item.get("relPath") or "").strip("/")
        folder_name = self.single_name() or item.get("name") or project or f"SourceForge_{JOB_ID}"
        safe_folder = re.sub(r'[/\\?%*:|"<>]', "_", folder_name).strip() or f"SourceForge_{JOB_ID}"
        out_root = dest_dir / safe_folder
        out_root.mkdir(parents=True, exist_ok=True)

        self.tick(safe_folder, "Scanning SF Folder..", 0.0, 0, 0, 0, None, "SourceForge", force=True)

        queue = [folder_url]
        seen_pages = set()
        found_files = []
        seen_links = set()

        while queue and len(seen_pages) < 25 and len(found_files) < 50:
            page = queue.pop(0)
            if page in seen_pages:
                continue
            seen_pages.add(page)
            try:
                code, body, _ = _fetch_text_resilient(page)
                if code >= 400 or not body:
                    continue
            except Exception:
                continue
            for m in re.finditer(r"<tr\b([^>]*)>([\s\S]*?)</tr>", body, re.I):
                tr_cls = _extract_attr(m.group(1), "class").lower()
                hm = re.search(r'<a\b[^>]*\bhref=["\']([^"\']+)["\']', m.group(2), re.I)
                if not hm:
                    continue
                abs_u = urllib.parse.urljoin(page, html.unescape(hm.group(1)))
                if re.search(r"\bfile\b", tr_cls) and "/files/" in abs_u and abs_u.endswith("/download"):
                    if abs_u.lower().endswith("/files/latest/download"):
                        continue
                    if abs_u not in seen_links:
                        seen_links.add(abs_u)
                        found_files.append(abs_u)
                        if len(found_files) >= 50:
                            break
                elif re.search(r"\bfolder\b", tr_cls) and "/files/" in abs_u and not abs_u.endswith("/download"):
                    clean_d = abs_u.split("#")[0].split("?")[0]
                    if clean_d not in seen_pages and clean_d not in queue:
                        queue.append(clean_d)

        if not found_files and project:
            rss_path = f"/{rel_path}" if rel_path else "/"
            rss_url = f"https://sourceforge.net/projects/{urllib.parse.quote(project)}/rss?path={urllib.parse.quote(rss_path)}"
            try:
                code, xml_text, _ = _fetch_text_resilient(rss_url, accept="application/rss+xml, application/xml, text/xml")
                if code < 400 and xml_text:
                    for lm in re.finditer(r"<link>(https?://sourceforge\.net/projects/[^<]+/download)</link>", xml_text, re.I):
                        lnk = html.unescape(lm.group(1).strip())
                        if not lnk.lower().endswith("/files/latest/download") and lnk not in seen_links:
                            seen_links.add(lnk)
                            found_files.append(lnk)
                            if len(found_files) >= 50:
                                break
            except Exception:
                pass

        if not found_files:
            raise RuntimeError("No downloadable files found in this SourceForge project/folder.")

        for idx_f, f_url in enumerate(found_files, 1):
            if cancelled:
                raise InterruptedError("Cancelled by user")
            resolved = resolve_download_url(f_url)
            dl_url = resolved.get("url") or f_url
            fname = urllib.parse.unquote(urllib.parse.urlparse(dl_url).path.rstrip("/").split("/")[-1]) or f"file_{idx_f}"
            if fname == "download":
                parts = [p for p in urllib.parse.urlparse(f_url).path.split("/") if p]
                if len(parts) >= 2 and parts[-1] == "download":
                    fname = urllib.parse.unquote(parts[-2])
            self.aria_download(dl_url, out_root, out_name=fname, label=f"[{idx_f}/{len(found_files)}] {fname}")
        return out_root

    async def _kurigram_download_item(self, item: dict, dest_dir: Path) -> Path:
        global cancelled
        from pyrogram import Client

        chat_id = item.get("chatId")
        msg_id = item.get("messageId")
        file_id = item.get("fileId") or ""
        hint_name = item.get("name") or ""
        hint_size = int(item.get("size") or 0)

        FastClient = self._make_fast_kurigram_client_cls(Client)
        loop = asyncio.get_running_loop()
        async with FastClient(
            f"tgdl_{JOB_ID or 'run'}_{self.idx}",
            **_kurigram_client_kwargs(Client, {
                "api_id": int(TELEGRAM_API_ID),
                "api_hash": TELEGRAM_API_HASH,
                "bot_token": BOT_TOKEN,
            }),
        ) as app:
            msg = None
            if chat_id is not None and msg_id:
                s_chat = str(chat_id).strip()
                target_chat = int(s_chat) if s_chat.lstrip("-").isdigit() else s_chat.lstrip("@")
                try:
                    msg = await app.get_messages(target_chat, int(msg_id))
                except Exception as e:
                    if not file_id:
                        raise RuntimeError(f"Could not access Telegram chat/channel ({target_chat}): {e}")

            media_obj = None
            if msg and not getattr(msg, "empty", False) and getattr(msg, "media", None):
                for attr in ("document", "video", "audio", "animation", "voice", "video_note", "photo"):
                    m = getattr(msg, attr, None)
                    if m is not None:
                        media_obj = m
                        break

            if media_obj is not None:
                real_size = int(getattr(media_obj, "file_size", 0) or hint_size or 0)
                orig_name = getattr(media_obj, "file_name", None) or ""
                mime = (getattr(media_obj, "mime_type", None) or "").lower()
                ext = Path(orig_name).suffix if orig_name else ""
                if not ext:
                    if getattr(msg, "video", None) or getattr(msg, "animation", None) or getattr(msg, "video_note", None) or "mp4" in mime:
                        ext = ".mp4"
                    elif "matroska" in mime or "mkv" in mime:
                        ext = ".mkv"
                    elif "webm" in mime:
                        ext = ".webm"
                    elif getattr(msg, "audio", None) or "mpeg" in mime or "mp3" in mime:
                        ext = ".mp3"
                    elif getattr(msg, "voice", None) or "ogg" in mime:
                        ext = ".ogg"
                    elif getattr(msg, "photo", None) or "jpeg" in mime or "jpg" in mime:
                        ext = ".jpg"
                    elif "zip" in mime:
                        ext = ".zip"
                    elif "pdf" in mime:
                        ext = ".pdf"
                    else:
                        ext = ".bin"
                custom = self.single_name()
                if custom:
                    has_ext = "." in Path(custom).name and len(Path(custom).suffix) <= 10
                    target_name = custom if has_ext else f"{custom}{ext}"
                elif orig_name:
                    target_name = orig_name
                elif hint_name and not hint_name.startswith("Telegram_"):
                    has_ext = "." in Path(hint_name).name and len(Path(hint_name).suffix) <= 10
                    target_name = hint_name if has_ext else f"{hint_name}{ext}"
                else:
                    target_name = f"telegram_{msg_id or 'media'}{ext}"
                dl_target = msg
            elif file_id:
                real_size = hint_size
                target_name = self.single_name() or hint_name or f"telegram_{JOB_ID or 'file'}.bin"
                dl_target = file_id
            else:
                raise RuntimeError(
                    "Telegram message contains no downloadable file or media (or the channel is private and the bot is not a member)."
                )

            safe_name = re.sub(r'[/\\?%*:|"<>]', "_", target_name).strip() or "telegram_file.bin"
            dest_dir.mkdir(parents=True, exist_ok=True)
            out_path = dest_dir / safe_name

            t_start = time.time()
            win = [t_start, 0]
            tick_busy = [False]
            tick_err = [None]
            self.tick(out_path.name, "Downloading (TG)..", 0.0, 0, real_size, 0, None, "Kurigram MTProto", force=True)

            def on_prog(current, total):
                global cancelled
                if cancelled or tick_err[0] is not None:
                    app.stop_transmission()
                    return
                now = time.time()
                dt = max(0.05, now - win[0])
                spd = max(0.0, (current - win[1]) / dt) if current >= win[1] else 0.0
                tot = total or real_size
                pct = (100.0 * current / tot) if tot > 0 else 0.0
                eta = ((tot - current) / spd) if spd > 0 and tot > current else None
                if not tick_busy[0] and (now - self.last_tick >= TICK_SECONDS):
                    tick_busy[0] = True
                    def _run_tick():
                        global cancelled
                        try:
                            self.tick(out_path.name, "Downloading (TG)..", pct, current, tot, spd, eta, "Kurigram MTProto")
                        except InterruptedError as ie:
                            cancelled = True
                            tick_err[0] = ie
                        except Exception:
                            pass
                        finally:
                            tick_busy[0] = False
                    loop.run_in_executor(None, _run_tick)
                if now - win[0] >= TICK_SECONDS:
                    win[0] = now
                    win[1] = current

            try:
                saved = await app.download_media(dl_target, file_name=str(out_path), progress=on_prog)
            finally:
                await app.close_media_pool()
            if cancelled or tick_err[0] is not None:
                raise InterruptedError("Cancelled by user")
            final_p = Path(saved) if saved else out_path
            if not final_p.exists() or final_p.stat().st_size == 0:
                raise RuntimeError("Kurigram finished without saving the Telegram file.")
            return final_p

    def tg_download(self, item: dict, dest_dir: Path) -> Path:
        if not BOT_TOKEN or not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
            raise RuntimeError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required to download Telegram files.")
        label = self.single_name() or item.get("name") or "Telegram File"
        sz = int(item.get("size") or 0)
        self.tick(label, "Setting up Kurigram..", 0.0, 0, sz, 0, None, "Kurigram MTProto", force=True)
        ensure_kurigram_tools()
        return _run_async_fast(self._kurigram_download_item(item, dest_dir))

    def acquire_local(self, item: dict, dest_dir: Path) -> Path:
        """Downloads an item to local disk (used for extract/zip modes, yt-dlp, Telegram media, and URL items)."""
        item = self.resolve_item(item)
        if item.get("type") == "gofile":
            return self.gofile_download_item(item, dest_dir)
        if item.get("type") == "sf_folder":
            return self.sf_folder_download(item, dest_dir)
        if item.get("type") == "tg_media":
            return self.tg_download(item, dest_dir)
        if item.get("type") == "ytdl":
            return self.ytdl_download(item["url"], dest_dir)
        if item.get("type") == "gdrive":
            meta = self.gdrive_meta(item)
            name = self.single_name() or meta["name"]
            mime = meta.get("mimeType", "")
            if mime == FOLDER_MIME:
                return self.gdrive_download_folder(meta, dest_dir, name)
            if mime.startswith("application/vnd.google-apps."):
                raise RuntimeError("Google Docs/Sheets/Slides files cannot be downloaded for archiving.")
            return self.gdrive_download_file(item, meta, dest_dir, name)
        return self.aria_download(item["url"], dest_dir, out_name=self.single_name(), label=self.item_label(item))

    def _make_fast_kurigram_client_cls(self, base_client_cls):
        """Build a Client subclass with per-DC pooled temporary media sessions for fast uploads and downloads."""
        import pyrogram
        from pyrogram import raw

        class _FastKurigramClient(base_client_cls):
            def __init__(self_cli, *args, **kwargs):
                super().__init__(*args, **kwargs)
                self_cli._media_pools = {}
                self_cli._media_pool_lock = asyncio.Lock()
                self_cli._preuploaded = {}
                self_cli._concurrent_hint = 1

            @property
            def _media_pool(self_cli):
                return [s for pool in self_cli._media_pools.values() for s in pool]

            async def _ensure_media_pool(self_cli, dc_id: int, target_size: int = 6) -> list:
                async with self_cli._media_pool_lock:
                    pool = self_cli._media_pools.setdefault(dc_id, [])
                    if not pool:
                        try:
                            await self_cli.get_session(dc_id)
                        except Exception:
                            pass
                    while len(pool) < target_size:
                        try:
                            sess = await self_cli.get_session(dc_id, is_media=True, temporary=True)
                        except TypeError:
                            sess = await self_cli.get_session(dc_id, is_media=True)
                            if sess not in pool:
                                pool.append(sess)
                            break
                        except Exception:
                            break
                        if sess is not None:
                            pool.append(sess)
                    return list(pool)

            async def close_media_pool(self_cli):
                for pool in list(self_cli._media_pools.values()):
                    for sess in list(pool):
                        try:
                            if getattr(sess, "is_started", None):
                                await sess.stop()
                        except Exception:
                            pass
                self_cli._media_pools.clear()

            async def get_file(self_cli, file_id, file_size=0, limit=0, offset=0, progress=None, progress_args=()):
                try:
                    from pyrogram.file_id import FileType
                except Exception:
                    FileType = None

                file_type = getattr(file_id, "file_type", None)
                is_chat_photo = (FileType is not None and file_type == FileType.CHAT_PHOTO)
                if is_chat_photo or limit != 0 or offset != 0 or not file_size or file_size <= 2 * 1024 * 1024:
                    async for chunk in super().get_file(
                        file_id, file_size=file_size, limit=limit, offset=offset, progress=progress, progress_args=progress_args
                    ):
                        yield chunk
                    return

                dc_id = file_id.dc_id
                try:
                    pool = await self_cli._ensure_media_pool(dc_id, target_size=6)
                except Exception:
                    pool = []

                if not pool:
                    async for chunk in super().get_file(
                        file_id, file_size=file_size, limit=limit, offset=offset, progress=progress, progress_args=progress_args
                    ):
                        yield chunk
                    return

                if FileType is not None and file_type == FileType.PHOTO:
                    location = raw.types.InputPhotoFileLocation(
                        id=file_id.media_id,
                        access_hash=file_id.access_hash,
                        file_reference=file_id.file_reference,
                        thumb_size=file_id.thumbnail_size,
                    )
                else:
                    location = raw.types.InputDocumentFileLocation(
                        id=file_id.media_id,
                        access_hash=file_id.access_hash,
                        file_reference=file_id.file_reference,
                        thumb_size=file_id.thumbnail_size,
                    )

                chunk_size = 1024 * 1024
                async with self_cli.get_file_semaphore:
                    r0 = await pool[0].invoke(
                        raw.functions.upload.GetFile(location=location, offset=0, limit=chunk_size),
                        sleep_threshold=60,
                    )
                    if not isinstance(r0, raw.types.upload.File):
                        # Release semaphore and fall back cleanly for CDN redirects
                        pass
                    else:
                        chunk0 = r0.bytes
                        yield chunk0
                        done_bytes = len(chunk0)
                        if progress:
                            res = progress(min(done_bytes, file_size), file_size, *progress_args)
                            if inspect.isawaitable(res):
                                await res
                        if len(chunk0) < chunk_size or done_bytes >= file_size:
                            return

                        total_chunks = int(math.ceil(file_size / chunk_size))
                        workers_count = min(12, total_chunks - 1)
                        max_ahead = 16
                        next_req = 1
                        next_yield = 1
                        eof_idx = None
                        results: dict[int, bytes] = {}
                        failures: list[Exception] = []
                        data_event = asyncio.Event()
                        space_event = asyncio.Event()

                        async def _dl_worker(w_idx: int):
                            nonlocal next_req, eof_idx
                            sess = pool[w_idx % len(pool)]
                            while True:
                                if failures or cancelled:
                                    data_event.set()
                                    return
                                if eof_idx is not None and next_req >= eof_idx:
                                    return
                                if next_req >= total_chunks:
                                    return
                                if next_req - next_yield >= max_ahead:
                                    space_event.clear()
                                    if next_req - next_yield >= max_ahead and not (failures or cancelled):
                                        await space_event.wait()
                                        continue
                                idx = next_req
                                next_req += 1
                                if idx >= total_chunks or (eof_idx is not None and idx >= eof_idx):
                                    return
                                try:
                                    resp = await sess.invoke(
                                        raw.functions.upload.GetFile(
                                            location=location,
                                            offset=idx * chunk_size,
                                            limit=chunk_size,
                                        ),
                                        sleep_threshold=60,
                                    )
                                    if not isinstance(resp, raw.types.upload.File):
                                        raise RuntimeError("Unexpected non-file response during GetFile")
                                    b = resp.bytes
                                    results[idx] = b
                                    if len(b) < chunk_size and (eof_idx is None or idx + 1 < eof_idx):
                                        eof_idx = idx + 1
                                    data_event.set()
                                except Exception as exc:
                                    failures.append(exc)
                                    data_event.set()
                                    return

                        worker_tasks = [asyncio.create_task(_dl_worker(i)) for i in range(workers_count)]
                        try:
                            while next_yield < total_chunks:
                                if eof_idx is not None and next_yield >= eof_idx:
                                    break
                                if cancelled:
                                    raise pyrogram.StopTransmission()
                                if failures:
                                    raise failures[0]
                                if next_yield not in results:
                                    data_event.clear()
                                    if next_yield not in results and not failures and not cancelled:
                                        if eof_idx is not None and next_yield >= eof_idx:
                                            break
                                        await data_event.wait()
                                    continue

                                chunk = results.pop(next_yield)
                                next_yield += 1
                                space_event.set()
                                if not chunk:
                                    break
                                yield chunk
                                done_bytes += len(chunk)
                                if progress:
                                    res = progress(min(done_bytes, file_size), file_size, *progress_args)
                                    if inspect.isawaitable(res):
                                        await res
                        finally:
                            space_event.set()
                            for t in worker_tasks:
                                if not t.done():
                                    t.cancel()
                            await asyncio.gather(*worker_tasks, return_exceptions=True)
                        return

                async for chunk in super().get_file(
                    file_id, file_size=file_size, limit=limit, offset=offset, progress=progress, progress_args=progress_args
                ):
                    yield chunk

            async def save_file(self_cli, path, file_id=None, file_part=0, progress=None, progress_args=()):
                if path is None:
                    return None
                if file_id is None and file_part == 0 and isinstance(path, (str, os.PathLike)):
                    cached = self_cli._preuploaded.pop(str(path), None)
                    if cached is not None:
                        return cached

                is_eligible = (
                    file_id is None
                    and file_part == 0
                    and isinstance(path, (str, os.PathLike))
                    and os.path.isfile(path)
                )
                if not is_eligible:
                    return await super().save_file(
                        path, file_id=file_id, file_part=file_part, progress=progress, progress_args=progress_args
                    )

                file_size = os.path.getsize(path)
                if file_size <= 10 * 1024 * 1024:
                    return await super().save_file(
                        path, file_id=file_id, file_part=file_part, progress=progress, progress_args=progress_args
                    )

                max_mib = 4000 if (getattr(self_cli, "me", None) and getattr(self_cli.me, "is_premium", False)) else 2000
                if file_size > max_mib * 1024 * 1024:
                    raise ValueError(f"Can't upload files bigger than {max_mib} MiB")

                try:
                    dc_id = await self_cli.storage.dc_id()
                    pool = await self_cli._ensure_media_pool(dc_id, target_size=6)
                except Exception:
                    pool = []

                if not pool:
                    return await super().save_file(
                        path, file_id=file_id, file_part=file_part, progress=progress, progress_args=progress_args
                    )

                part_size = 512 * 1024
                total_parts = int(math.ceil(file_size / part_size))
                gen_id = self_cli.rnd_id()
                workers_count = min(total_parts, 12 if self_cli._concurrent_hint <= 1 else 4)
                start_offset = abs(gen_id) % len(pool)

                async with self_cli.save_file_semaphore:
                    queue: asyncio.Queue = asyncio.Queue(workers_count * 2)
                    failures: list[Exception] = []
                    done_bytes = 0

                    async def _chunk_worker(w_idx: int):
                        nonlocal done_bytes
                        sess = pool[(start_offset + w_idx) % len(pool)]
                        while True:
                            item = await queue.get()
                            if item is None:
                                return
                            if failures or cancelled:
                                continue
                            part_no, chunk_bytes = item
                            try:
                                rpc = raw.functions.upload.SaveBigFilePart(
                                    file_id=gen_id,
                                    file_part=part_no,
                                    file_total_parts=total_parts,
                                    bytes=chunk_bytes,
                                )
                                await sess.invoke(rpc)
                                done_bytes += len(chunk_bytes)
                                if progress:
                                    res = progress(min(done_bytes, file_size), file_size, *progress_args)
                                    if inspect.isawaitable(res):
                                        await res
                            except Exception as exc:
                                failures.append(exc)

                    fp = open(path, "rb")
                    worker_tasks = [asyncio.create_task(_chunk_worker(i)) for i in range(workers_count)]
                    try:
                        part_no = 0
                        while not failures:
                            if cancelled:
                                failures.append(InterruptedError("Cancelled by user"))
                                break
                            chunk = fp.read(part_size)
                            if not chunk:
                                break
                            await queue.put((part_no, chunk))
                            part_no += 1
                    except Exception as exc:
                        failures.append(exc)
                    finally:
                        for _ in worker_tasks:
                            await queue.put(None)
                        await asyncio.gather(*worker_tasks, return_exceptions=True)
                        fp.close()

                    if failures:
                        raise failures[0]

                    return raw.types.InputFileBig(
                        id=gen_id,
                        parts=total_parts,
                        name=Path(path).name,
                    )

        return _FastKurigramClient

    async def _kurigram_send_files(self, files: list, as_doc: bool = False, base_root: Path = None) -> list:
        from pyrogram import Client
        try:
            from pyrogram.errors import FloodWait
        except Exception:
            FloodWait = None
        try:
            from pyrogram.enums import ParseMode
            pm_html = ParseMode.HTML
        except Exception:
            pm_html = None

        reply_id = self.job.get("replyToMsgId")
        try:
            reply_id = int(reply_id) if reply_id else None
        except Exception:
            reply_id = None

        valid_files = []
        for fpath in files:
            sz = fpath.stat().st_size
            if sz > 0:
                valid_files.append((fpath, sz))
        if not valid_files:
            return []

        n_files = len(valid_files)
        total_all = sum(sz for _, sz in valid_files)
        per_done = [0] * n_files
        win = [time.time(), 0]
        tick_busy = [False]
        tick_err = [None]
        sent_items = []
        loop = asyncio.get_running_loop()

        FastClient = self._make_fast_kurigram_client_cls(Client)
        async with FastClient(
            f"mirror_{JOB_ID or 'run'}",
            **_kurigram_client_kwargs(Client, {
                "api_id": int(TELEGRAM_API_ID),
                "api_hash": TELEGRAM_API_HASH,
                "bot_token": BOT_TOKEN,
            }),
        ) as app:
            upload_conc = min(n_files, 4) if n_files > 1 else 1
            app._concurrent_hint = upload_conc

            def report_progress(file_idx: int, current: int, total: int, fname: str):
                global cancelled
                if cancelled or tick_err[0] is not None:
                    raise InterruptedError("Cancelled by user")
                sz_i = valid_files[file_idx][1]
                cur = min(max(0, int(current)), total or sz_i)
                if cur > per_done[file_idx]:
                    per_done[file_idx] = cur

                agg_done = sum(per_done) if n_files > 1 else cur
                agg_tot = total_all if n_files > 1 else (total or sz_i)
                now = time.time()
                dt = max(0.05, now - win[0])
                spd = max(0.0, (agg_done - win[1]) / dt) if agg_done >= win[1] else 0.0
                if now - win[0] >= TICK_SECONDS:
                    win[0] = now
                    win[1] = agg_done

                pct = (100.0 * agg_done / agg_tot) if agg_tot > 0 else 0.0
                eta = ((agg_tot - agg_done) / spd) if spd > 0 and agg_tot > agg_done else None
                if n_files > 1:
                    label = f"TG {len(sent_items)}/{n_files} ({upload_conc}x).."
                else:
                    label = "Uploading (TG).."

                if not tick_busy[0] and (now - self.last_tick >= TICK_SECONDS):
                    tick_busy[0] = True
                    def _run_tick():
                        global cancelled
                        try:
                            self.tick(fname, label, pct, agg_done, agg_tot, spd, eta, "Kurigram MTProto")
                        except InterruptedError as ie:
                            cancelled = True
                            tick_err[0] = ie
                        except Exception:
                            pass
                        finally:
                            tick_busy[0] = False
                    loop.run_in_executor(None, _run_tick)

            items_meta = []
            for file_idx, (fpath, sz) in enumerate(valid_files):
                try:
                    rel_label = str(fpath.relative_to(base_root)) if base_root else fpath.name
                except Exception:
                    rel_label = fpath.name
                suffix = fpath.suffix.lower()
                is_audio = (not as_doc) and (suffix in AUDIO_EXTS)
                is_video = (not as_doc) and (suffix in VIDEO_EXTS)
                is_image = (not as_doc) and (suffix in IMAGE_EXTS) and (sz <= 10 * 1024 * 1024)
                need_probe = is_audio or is_video or (as_doc and suffix in VIDEO_EXTS)
                meta = probe_media_meta(fpath) if need_probe else {"duration": 0, "width": 0, "height": 0}
                thumb = make_media_thumb(fpath, fpath.parent) if need_probe else None
                items_meta.append({
                    "idx": file_idx + 1,
                    "file_idx": file_idx,
                    "fpath": fpath,
                    "sz": sz,
                    "rel_label": rel_label,
                    "is_audio": is_audio,
                    "is_video": is_video,
                    "is_image": is_image,
                    "meta": meta,
                    "thumb": thumb,
                })

            upload_sem = asyncio.Semaphore(upload_conc)
            pre_tasks: list = [None] * n_files

            async def _preupload_one(info: dict):
                fpath = info["fpath"]
                sz = info["sz"]
                file_idx = info["file_idx"]

                def on_prog_pre(current, total):
                    report_progress(file_idx, current, total, fpath.name)

                async with upload_sem:
                    for attempt in range(3):
                        if cancelled:
                            raise InterruptedError("Cancelled by user")
                        try:
                            uploaded = await app.save_file(str(fpath), progress=on_prog_pre)
                            app._preuploaded[str(fpath)] = uploaded
                            return uploaded
                        except Exception as err:
                            if FloodWait is not None and isinstance(err, FloodWait):
                                wait_s = min(int(getattr(err, "value", 10)) + 1, 180)
                                await loop.run_in_executor(
                                    None,
                                    lambda n=fpath.name, w=wait_s, d=sum(per_done): self.tick(
                                        n, f"FloodWait ({w}s)..", 0.0, d, total_all, 0, w, "Kurigram MTProto", force=True
                                    ),
                                )
                                await asyncio.sleep(wait_s)
                                continue
                            if attempt < 2 and any(t in str(err).lower() for t in ("timed out", "timeout", "connection", "reset", "eof")):
                                await asyncio.sleep(2 * (attempt + 1))
                                continue
                            raise

            try:
                if n_files > 1:
                    for i, info in enumerate(items_meta):
                        if info["sz"] > 10 * 1024 * 1024 and not info["is_image"]:
                            pre_tasks[i] = asyncio.create_task(_preupload_one(info))

                for i, info in enumerate(items_meta):
                    if cancelled or tick_err[0] is not None:
                        raise InterruptedError("Cancelled by user")
                    idx = info["idx"]
                    file_idx = info["file_idx"]
                    fpath = info["fpath"]
                    sz = info["sz"]
                    rel_label = info["rel_label"]
                    is_audio = info["is_audio"]
                    is_video = info["is_video"]
                    is_image = info["is_image"]
                    meta = info["meta"]
                    thumb = info["thumb"]

                    if pre_tasks[i] is not None:
                        await pre_tasks[i]

                    def on_prog(current, total):
                        report_progress(file_idx, current, total, fpath.name)

                    caption = f"<code>{html.escape(rel_label)}</code>  ·  <code>{fmt_bytes(sz)}</code>"
                    if len(caption) > 1000:
                        caption = f"<code>{html.escape(truncate(fpath.name, 180))}</code>  ·  <code>{fmt_bytes(sz)}</code>"
                    kw = {"caption": caption, "progress": on_prog}
                    if pm_html is not None:
                        kw["parse_mode"] = pm_html
                    if thumb:
                        kw["thumb"] = str(thumb)
                    if reply_id and idx == 1:
                        kw["reply_to_message_id"] = reply_id
                    elif self.thread_id and idx == 1:
                        kw["message_thread_id"] = int(self.thread_id)

                    async def _send_once():
                        if is_audio:
                            akw = dict(kw)
                            if meta["duration"]:
                                akw["duration"] = meta["duration"]
                            akw["title"] = fpath.stem
                            try:
                                return await app.send_audio(self.chat_id, audio=str(fpath), **akw)
                            except Exception:
                                akw.pop("reply_to_message_id", None)
                                return await app.send_audio(self.chat_id, audio=str(fpath), **akw)
                        if is_video:
                            vkw = dict(kw)
                            if meta["duration"]:
                                vkw["duration"] = meta["duration"]
                            if meta["width"] and meta["height"]:
                                vkw["width"] = meta["width"]
                                vkw["height"] = meta["height"]
                            vkw["supports_streaming"] = True
                            try:
                                return await app.send_video(self.chat_id, video=str(fpath), **vkw)
                            except Exception:
                                if "reply_to_message_id" in vkw:
                                    vkw.pop("reply_to_message_id", None)
                                    try:
                                        return await app.send_video(self.chat_id, video=str(fpath), **vkw)
                                    except Exception:
                                        pass
                                dkw = {k: v for k, v in vkw.items() if k in ("caption", "progress", "parse_mode", "thumb", "message_thread_id")}
                                return await app.send_document(self.chat_id, document=str(fpath), **dkw)
                        if is_image:
                            pkw = {k: v for k, v in kw.items() if k in ("caption", "progress", "parse_mode", "reply_to_message_id", "message_thread_id")}
                            try:
                                return await app.send_photo(self.chat_id, photo=str(fpath), **pkw)
                            except Exception:
                                dkw = {k: v for k, v in kw.items() if k in ("caption", "progress", "parse_mode", "thumb", "message_thread_id")}
                                return await app.send_document(self.chat_id, document=str(fpath), **dkw)
                        dkw = {k: v for k, v in kw.items() if k in ("caption", "progress", "parse_mode", "thumb", "reply_to_message_id", "message_thread_id")}
                        try:
                            return await app.send_document(self.chat_id, document=str(fpath), **dkw)
                        except Exception:
                            dkw.pop("reply_to_message_id", None)
                            return await app.send_document(self.chat_id, document=str(fpath), **dkw)

                    sent_msg = None
                    try:
                        for attempt in range(3):
                            try:
                                sent_msg = await _send_once()
                                break
                            except Exception as err:
                                if FloodWait is not None and isinstance(err, FloodWait):
                                    wait_s = min(int(getattr(err, "value", 10)) + 1, 180)
                                    await loop.run_in_executor(
                                        None,
                                        lambda: self.tick(fpath.name, f"FloodWait ({wait_s}s)..", 0.0, sum(per_done), total_all, 0, wait_s, "Kurigram MTProto", force=True),
                                    )
                                    await asyncio.sleep(wait_s)
                                    continue
                                if attempt < 2 and any(t in str(err).lower() for t in ("timed out", "timeout", "connection", "reset", "eof")):
                                    await asyncio.sleep(2 * (attempt + 1))
                                    continue
                                raise
                        per_done[file_idx] = sz
                        msg_link = getattr(sent_msg, "link", "") or ""
                        sent_items.append({
                            "name": rel_label,
                            "size": sz,
                            "status": "completed",
                            "link": msg_link,
                            "msgId": getattr(sent_msg, "id", None),
                            "direct": "",
                            "shared": False,
                        })
                    finally:
                        if thumb:
                            thumb.unlink(missing_ok=True)
            finally:
                for t in pre_tasks:
                    if t is not None and not t.done():
                        t.cancel()
                pending = [t for t in pre_tasks if t is not None]
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                for info in items_meta:
                    if info.get("thumb"):
                        info["thumb"].unlink(missing_ok=True)
                await app.close_media_pool()
        return sent_items

    def _split_7z_volumes(self, fpath: Path, max_bytes: int, vol_bytes: int, limit_desc: str) -> list:
        sz = fpath.stat().st_size
        if sz < max_bytes:
            return [fpath]
        du_free = shutil.disk_usage("/").free
        if du_free < sz * 1.05:
            raise RuntimeError(
                f"File '{fpath.name}' ({fmt_bytes(sz)}) exceeds {limit_desc} limit and remaining disk ({fmt_bytes(du_free)}) is too small to split it."
            )
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        split_dir = OUT_DIR / f"split_{uuid.uuid4().hex[:8]}"
        split_dir.mkdir(parents=True, exist_ok=True)
        base_archive = split_dir / f"{fpath.name}.7z"
        vol_mb = vol_bytes // (1024 * 1024)
        cmd = ["7z", "a", "-t7z", "-mx=0", f"-v{vol_mb}m", "-bsp1", "-bb0"]
        if self.password:
            cmd += [f"-p{self.password}", "-mhe=on"]
        cmd += [str(base_archive), fpath.name]
        rc, _ = self.run_progress(cmd, fpath.name, "Splitting (>2GB)..", "7-Zip Store", sz, cwd=str(fpath.parent), estimate_dir=split_dir)
        parts = sorted(p for p in split_dir.iterdir() if p.is_file() and p.stat().st_size > 0)
        if rc not in (0, 1) or not parts:
            shutil.rmtree(split_dir, ignore_errors=True)
            raise RuntimeError(f"Failed to split '{fpath.name}' into < {limit_desc} volumes.")
        fpath.unlink(missing_ok=True)
        return parts

    def split_for_telegram(self, fpath: Path) -> list:
        return self._split_7z_volumes(fpath, TG_BOT_MAX_BYTES, TG_SPLIT_BYTES, "2 GB Telegram")

    def _run_gh_cli(self, args: list, env: dict, tick_ctx: dict = None) -> tuple:
        global cancelled
        proc = subprocess.Popen(
            ["gh", *args],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        buf = []

        def _drain():
            try:
                for line in proc.stdout:
                    buf.append(line)
            except Exception:
                pass

        reader = threading.Thread(target=_drain, daemon=True)
        reader.start()

        step_start = time.time()
        while True:
            rc = proc.poll()
            if cancelled:
                try:
                    proc.terminate()
                except Exception:
                    pass
                reader.join(timeout=2)
                raise InterruptedError("Cancelled by user")
            if tick_ctx:
                now = time.time()
                done_prev = tick_ctx["done_prev"]
                total_all = max(1, tick_ctx["total_all"])
                cur_sz = tick_ctx["cur_sz"]
                # Estimate gradual progress during single asset upload so status card stays responsive
                elapsed_s = max(0.0, now - step_start)
                est_rate = tick_ctx.get("avg_bps") or (8 * 1024 * 1024)
                est_cur = min(int(cur_sz * 0.95), int(elapsed_s * est_rate))
                agg_done = min(total_all, done_prev + est_cur)
                pct = (100.0 * agg_done / total_all) if total_all > 0 else 0.0
                spd = est_cur / elapsed_s if elapsed_s > 1.0 and est_cur > 0 else tick_ctx.get("avg_bps", 0)
                eta = ((total_all - agg_done) / spd) if spd > 0 and total_all > agg_done else None
                self.tick(
                    tick_ctx["fname"],
                    tick_ctx["label"],
                    pct,
                    agg_done,
                    total_all,
                    spd,
                    eta,
                    "GitHub CLI (gh)",
                )
            if rc is not None:
                break
            time.sleep(0.5)

        reader.join(timeout=5)
        out = "".join(buf)
        if self.gh_pat:
            out = out.replace(self.gh_pat, "***")
        return rc, out.strip()

    def upload_github_release(self, target: Path) -> list:
        if not self.gh_pat or not self.gh_repo:
            raise RuntimeError("GitHub Release requires a connected GitHub PAT (/ghlogin) and target repository.")
        if not shutil.which("gh"):
            raise RuntimeError("GitHub CLI (gh) is not installed on the runner.")

        if target.is_file():
            raw_files = [target]
            base_root = target.parent
        elif target.is_dir():
            raw_files = sorted(
                p for p in target.rglob("*")
                if p.is_file() and not p.name.endswith((".aria2", ".ytdl", ".part")) and p.stat().st_size > 0
            )
            base_root = target
        else:
            raise RuntimeError("No downloaded file found to publish to GitHub Release.")
        if not raw_files:
            raise RuntimeError("Downloaded folder contains no files to publish to GitHub Release.")

        upload_queue = []
        split_dirs = set()
        stage_dir = None
        seen_names = set()
        try:
            for f in raw_files:
                if f.stat().st_size >= GH_ASSET_MAX_BYTES:
                    parts = self._split_7z_volumes(f, GH_ASSET_MAX_BYTES, GH_SPLIT_BYTES, "2 GiB GitHub Release")
                    for part in parts:
                        split_dirs.add(part.parent)
                        upload_queue.append(part)
                else:
                    if f.name in seen_names:
                        if stage_dir is None:
                            OUT_DIR.mkdir(parents=True, exist_ok=True)
                            stage_dir = OUT_DIR / f"ghstage_{uuid.uuid4().hex[:8]}"
                            stage_dir.mkdir(parents=True, exist_ok=True)
                        try:
                            rel_safe = str(f.relative_to(base_root)).replace("/", "__")
                        except Exception:
                            rel_safe = f"{uuid.uuid4().hex[:4]}_{f.name}"
                        staged = stage_dir / rel_safe
                        os.link(f, staged) if not staged.exists() else None
                        upload_queue.append(staged)
                    else:
                        seen_names.add(f.name)
                        upload_queue.append(f)

            gh_env = {**os.environ, "GH_TOKEN": self.gh_pat, "GH_PAGER": "cat", "NO_COLOR": "1"}
            tag = self.gh_tag or datetime.now(timezone.utc).strftime("v%Y%m%d-%H%M%S")
            title = self.gh_title or (target.name if not self.batch else f"Release {tag}")

            self.tick(upload_queue[0].name, "Preparing GH Release..", 0.0, 0, sum(p.stat().st_size for p in upload_queue), 0, None, "GitHub CLI (gh)", force=True)

            rc_view, out_view = self._run_gh_cli(
                ["release", "view", tag, "--repo", self.gh_repo, "--json", "url,isDraft"],
                gh_env,
            )
            rel_existed = (rc_view == 0)
            created_draft_tag = None

            if not rel_existed:
                create_cmd = [
                    "release", "create", tag,
                    "--repo", self.gh_repo,
                    "--title", title,
                    "--draft",
                ]
                if self.gh_generate_notes:
                    create_cmd.append("--generate-notes")
                else:
                    create_cmd.extend(["--notes", self.gh_notes or ""])
                if self.gh_prerelease:
                    create_cmd.append("--prerelease")

                rc_cr, out_cr = self._run_gh_cli(create_cmd, gh_env)
                if rc_cr != 0:
                    raise RuntimeError(f"gh release create failed: {truncate(out_cr, 300)}")
                created_draft_tag = tag

            total_all = sum(p.stat().st_size for p in upload_queue)
            done_bytes = 0
            up_start = time.time()
            n_assets = len(upload_queue)

            try:
                for idx, fpath in enumerate(upload_queue, 1):
                    sz = fpath.stat().st_size
                    label = f"GH Asset {idx}/{n_assets}.." if n_assets > 1 else "Uploading GH Asset.."
                    avg_bps = (done_bytes / max(0.5, time.time() - up_start)) if done_bytes > 0 else 0
                    self.tick(fpath.name, label, (100.0 * done_bytes / total_all) if total_all else 0.0, done_bytes, total_all, avg_bps, None, "GitHub CLI (gh)", force=True)

                    rc_up, out_up = self._run_gh_cli(
                        ["release", "upload", tag, str(fpath), "--repo", self.gh_repo, "--clobber"],
                        gh_env,
                        tick_ctx={
                            "fname": fpath.name,
                            "label": label,
                            "done_prev": done_bytes,
                            "total_all": total_all,
                            "cur_sz": sz,
                            "avg_bps": avg_bps,
                        },
                    )
                    if rc_up != 0:
                        raise RuntimeError(f"gh release upload failed for {fpath.name}: {truncate(out_up, 280)}")
                    done_bytes += sz
            except InterruptedError:
                if created_draft_tag:
                    subprocess.run(
                        ["gh", "release", "delete", created_draft_tag, "--repo", self.gh_repo, "--yes"],
                        env=gh_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                raise

            if not self.gh_draft and (created_draft_tag or (rel_existed and '"isDraft":true' in out_view.replace(" ", ""))):
                edit_cmd = ["release", "edit", tag, "--repo", self.gh_repo, "--draft=false"]
                if self.gh_prerelease:
                    edit_cmd.append("--prerelease=true")
                rc_ed, out_ed = self._run_gh_cli(edit_cmd, gh_env)
                if rc_ed != 0:
                    raise RuntimeError(f"Failed to publish GitHub Release: {truncate(out_ed, 280)}")

            rc_fin, out_fin = self._run_gh_cli(
                ["release", "view", tag, "--repo", self.gh_repo, "--json", "url,tagName,name,isDraft,isPrerelease,assets"],
                gh_env,
            )
            rel_url = f"https://github.com/{self.gh_repo}/releases/tag/{urllib.parse.quote(tag)}"
            assets_by_name = {}
            if rc_fin == 0 and out_fin:
                try:
                    rel_info = json.loads(out_fin)
                    rel_url = rel_info.get("url") or rel_url
                    for a in rel_info.get("assets") or []:
                        if a.get("name"):
                            assets_by_name[a["name"]] = a.get("url") or ""
                except Exception:
                    pass
            self.gh_release_url = rel_url
            self.gh_tag = tag
            self.gh_title = title

            items_out = []
            for fpath in upload_queue:
                sz = fpath.stat().st_size
                dl_url = assets_by_name.get(fpath.name) or f"https://github.com/{self.gh_repo}/releases/download/{urllib.parse.quote(tag)}/{urllib.parse.quote(fpath.name)}"
                items_out.append({
                    "name": fpath.name,
                    "size": sz,
                    "status": "completed",
                    "link": dl_url if not self.gh_draft else rel_url,
                    "direct": dl_url if not self.gh_draft else "",
                    "releaseUrl": rel_url,
                    "shared": not self.gh_draft,
                })
            return items_out
        finally:
            for sd in split_dirs:
                shutil.rmtree(sd, ignore_errors=True)
            if stage_dir:
                shutil.rmtree(stage_dir, ignore_errors=True)

    def upload_telegram(self, target: Path) -> list:
        if not BOT_TOKEN or not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
            raise RuntimeError("Telegram Leech requires TELEGRAM_API_ID, TELEGRAM_API_HASH, and BOT_TOKEN configured on the runner.")
        if target.is_file():
            raw_files = [target]
            base_root = target.parent
        elif target.is_dir():
            raw_files = sorted(
                p for p in target.rglob("*")
                if p.is_file() and not p.name.endswith((".aria2", ".ytdl", ".part")) and p.stat().st_size > 0
            )
            base_root = target
        else:
            raise RuntimeError("No downloaded file found to leech.")
        if not raw_files:
            raise RuntimeError("Downloaded folder contains no files to leech.")

        upload_queue = []
        split_dirs = set()
        for f in raw_files:
            if f.stat().st_size >= TG_BOT_MAX_BYTES:
                parts = self.split_for_telegram(f)
                for part in parts:
                    split_dirs.add(part.parent)
                upload_queue.extend(parts)
            else:
                upload_queue.append(f)

        self.tick(upload_queue[0].name, "Setting up Kurigram..", 0.0, 0, path_size(upload_queue[0]), 0, None, "Kurigram MTProto", force=True)
        ensure_kurigram_tools()
        try:
            sent_items = _run_async_fast(
                self._kurigram_send_files(
                    upload_queue,
                    as_doc=self.leech_as_doc,
                    base_root=(None if split_dirs else base_root),
                )
            )
            self.tg_sent += len(sent_items)
            return sent_items
        finally:
            for sd in split_dirs:
                shutil.rmtree(sd, ignore_errors=True)

    def _wait_tg_overlimit_decision(self, under: list, over: list) -> str:
        over_lines = "\n".join(
            f"• <code>{html.escape(truncate(p.name, 48))}</code> (<code>{fmt_bytes(p.stat().st_size)}</code>)"
            for p in over[:8]
        )
        if len(over) > 8:
            over_lines += f"\n<i>…and {len(over) - 8} more oversized file(s)</i>"
        dest_label = "Gofile (Guest)" if self.dest == "gofile" else html.escape(self.folder_name)
        prompt_text = (
            f"<blockquote><b>Telegram 2 GB Limit Notice</b>\n\n"
            f"{len(over)} file(s) exceed Telegram's <code>2.00 GB</code> Bot upload limit:\n"
            f"{over_lines}</blockquote>\n\n"
            f"<code>{len(under)}</code> file(s) are under <code>2 GB</code>. Nothing has been sent to Telegram yet.\n"
            f"Standard upload to <b>{dest_label}</b> will still proceed either way:"
        )
        kb = {
            "inline_keyboard": [
                [{"text": f"📤 Mirror < 2 GB Only ({len(under)} files)", "callback_data": f"tg_dec:{JOB_ID}:lt2gb", "style": "success"}],
                [{"text": "⏭ Skip Whole TG Upload", "callback_data": f"tg_dec:{JOB_ID}:skip", "style": "danger"}],
            ]
        }
        sent = send_message(self.chat_id, prompt_text, kb, thread_id=self.thread_id)
        prompt_msg_id = (sent.get("result") or {}).get("message_id")
        deadline = time.time() + 180.0
        while time.time() < deadline:
            global cancelled
            if cancelled:
                raise InterruptedError("Cancelled by user")
            self.tick(
                over[0].name,
                "Waiting for TG Choice..",
                0.0,
                0,
                0,
                0,
                None,
                "Kurigram MTProto",
            )
            is_canc, synced_msg_id, dec = poll_worker_state(JOB_ID)
            if synced_msg_id is not None:
                self.message_id = synced_msg_id
            if is_canc:
                cancelled = True
                raise InterruptedError("Cancelled by user")
            if dec in ("lt2gb", "skip"):
                return dec
            time.sleep(2.0)
        if prompt_msg_id:
            edit_status(
                self.chat_id,
                prompt_msg_id,
                "<blockquote><b>Telegram Media Upload Skipped</b>\n\nTimed out waiting for choice. Continuing standard mirror upload...</blockquote>",
            )
        return "skip"

    def tg_upload_ytdl_media(self, local: Path):
        if not BOT_TOKEN or not TELEGRAM_API_ID or not TELEGRAM_API_HASH:
            return
        all_exts = VIDEO_EXTS | AUDIO_EXTS
        if local.is_file():
            candidates = [local] if local.suffix.lower() in all_exts else []
        elif local.is_dir():
            candidates = sorted(p for p in local.rglob("*") if p.is_file() and p.suffix.lower() in all_exts)
        else:
            candidates = []
        candidates = [p for p in candidates if p.stat().st_size > 0]
        if not candidates:
            return

        under = [p for p in candidates if p.stat().st_size < TG_BOT_MAX_BYTES]
        over = [p for p in candidates if p.stat().st_size >= TG_BOT_MAX_BYTES]
        dest_label = "Gofile (Guest)" if self.dest == "gofile" else html.escape(self.folder_name)

        if over and not under:
            names = html.escape(truncate(over[0].name, 60))
            sz = fmt_bytes(over[0].stat().st_size)
            extra = f"\n<i>(+{len(over) - 1} more file(s) &gt; 2 GB)</i>" if len(over) > 1 else ""
            send_message(
                self.chat_id,
                f"<blockquote><b>Telegram Upload Skipped (&gt; 2 GB)</b>\n\n"
                f"<code>{names}</code> (<code>{sz}</code>){extra}\n\n"
                f"Exceeds Telegram's <code>2 GB</code> Bot upload limit. Continuing standard upload to <b>{dest_label}</b>...</blockquote>",
                thread_id=self.thread_id,
            )
            self.tg_skipped += len(over)
            self.tg_note = "Skipped (> 2 GB limit)"
            return

        targets = under
        if over and under:
            choice = self._wait_tg_overlimit_decision(under, over)
            if choice != "lt2gb":
                self.tg_skipped += len(candidates)
                self.tg_note = "Skipped by user (> 2 GB present)"
                return
            self.tg_skipped += len(over)

        try:
            self.tick(targets[0].name, "Setting up Kurigram..", 0.0, 0, path_size(targets[0]), 0, None, "Kurigram MTProto", force=True)
            ensure_kurigram_tools()
            sent_items = asyncio.run(self._kurigram_send_files(targets))
            self.tg_sent += len(sent_items)
        except InterruptedError:
            raise
        except Exception as e:
            self.tg_note = f"TG upload failed: {truncate(str(e), 90)}"
            send_message(
                self.chat_id,
                f"<blockquote><b>Telegram Media Notice</b>\n\n"
                f"Could not upload media to chat: <code>{html.escape(truncate(str(e), 200))}</code>\n"
                f"Continuing standard upload to <b>{dest_label}</b>...</blockquote>",
                thread_id=self.thread_id,
            )

    def process_and_upload(self, local: Path) -> dict:
        size = path_size(local)
        mode = self.mode
        if mode in ("extract", "zip"):
            du_free = shutil.disk_usage("/").free
            if du_free < size * 1.15:
                send_message(
                    self.chat_id,
                    f"<blockquote><b>Workspace Notice</b>\n\n"
                    f"Remaining disk (<code>{fmt_bytes(du_free)}</code>) is tight for archive processing. "
                    f"Uploading original directly.</blockquote>",
                    thread_id=self.thread_id,
                )
                mode = "normal"

        target = local
        if mode == "extract" and local.is_file():
            target = self.extract(local)
        elif mode == "zip":
            zip_name = local.name if (local.is_file() and local.name.lower().endswith(".zip")) else local.name + ".zip"
            zipped = self.make_zip([local.name], zip_name, local.parent, size)
            if zipped:
                if local.is_dir():
                    shutil.rmtree(local, ignore_errors=True)
                else:
                    local.unlink(missing_ok=True)
                target = zipped
        return self.upload(target)

    def process_item(self, item: dict, item_dir: Path) -> dict:
        item = self.resolve_item(item)
        if item.get("type") == "gdrive":
            if not self.access_token:
                if item.get("url"):
                    local = self.aria_download(item["url"], item_dir, out_name=self.single_name(), label=self.item_label(item))
                    return self.process_and_upload(local)
                rk = f"&resourcekey={urllib.parse.quote(item['resourceKey'])}" if item.get("resourceKey") else ""
                pub_url = f"https://drive.usercontent.google.com/download?id={urllib.parse.quote(item['id'])}&export=download&confirm=t{rk}"
                local = self.aria_download(pub_url, item_dir, out_name=self.single_name(), label=self.item_label(item))
                return self.process_and_upload(local)
            meta = self.gdrive_meta(item)
            name = self.single_name() or meta["name"]
            mime = meta.get("mimeType", "")
            if self.dest not in ("gofile", "telegram", "ghrelease"):
                if mime == FOLDER_MIME and self.mode != "zip":
                    return self.gdrive_clone_folder(meta, name)
                if mime != FOLDER_MIME and (self.mode == "normal" or mime.startswith("application/vnd.google-apps.")):
                    return self.gdrive_copy_file(item, meta, name)
        local = self.acquire_local(item, item_dir)
        if item.get("type") == "ytdl" and self.dest != "telegram":
            self.tg_upload_ytdl_media(local)
        res = self.process_and_upload(local)
        if isinstance(res, list):
            return res[0] if len(res) == 1 else {"_multi": res}
        return res

    def run_batch_zip(self) -> list:
        bdir = DL_DIR / "batch"
        bdir.mkdir(parents=True, exist_ok=True)
        results = []
        for i, item in enumerate(self.items):
            self.idx = i
            try:
                local = self.acquire_local(item, bdir)
                if item.get("type") == "ytdl" and self.dest != "telegram":
                    self.tg_upload_ytdl_media(local)
            except InterruptedError:
                raise
            except Exception as e:
                results.append({"name": self.item_label(item), "status": "failed", "error": str(e)[:200]})
        if not any(bdir.iterdir()):
            return results
        zip_name = self.custom_name or f"Batch_{JOB_ID}.zip"
        if not zip_name.lower().endswith(".zip"):
            zip_name += ".zip"
        total = path_size(bdir)
        zipped = self.make_zip(["*"], zip_name, bdir, total)
        if not zipped:
            raise RuntimeError("Failed to create batch ZIP archive.")
        shutil.rmtree(bdir, ignore_errors=True)
        up = self.upload(zipped)
        if isinstance(up, list):
            for entry in reversed(up):
                results.insert(0, entry)
        else:
            results.insert(0, up)
        return results

    def run(self) -> list:
        DL_DIR.mkdir(parents=True, exist_ok=True)
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        all_light_disk = all(it.get("type") in ("ytdl", "tg_media") for it in self.items)
        if not all_light_disk:
            est = int(self.job.get("fileSize") or 0)
            needs_split = (self.dest in ("telegram", "ghrelease")) and est >= TG_BOT_MAX_BYTES
            mult = 2.2 if (self.mode in ("extract", "zip") or needs_split) else 1.15
            needed = (int(est * mult) + 4 * 1024**3) if est > 0 else (35 * 1024**3 if self.batch else 0)
            if needed > 0:
                ensure_disk_space(needed)
        if self.access_token:
            self.start_token_server()
            self.write_rclone_conf()

        need_bg_kg = (self.dest == "telegram") or any(
            it.get("type") in ("ytdl", "tg_media") or is_media_site_url(it.get("url") or "")
            for it in self.items
        )
        need_bg_ytdl = len(self.items) > 1 and any(
            it.get("type") == "ytdl" or is_media_site_url(it.get("url") or "")
            for it in self.items[1:]
        )
        if need_bg_ytdl or need_bg_kg:
            prewarm_tools_async(need_ytdl=need_bg_ytdl, need_kurigram=need_bg_kg)

        if self.batch and self.mode == "zip":
            return self.run_batch_zip()

        results = []
        for i, item in enumerate(self.items):
            self.idx = i
            item_dir = DL_DIR / f"item_{i}"
            try:
                out_res = self.process_item(item, item_dir)
                if isinstance(out_res, dict) and "_multi" in out_res:
                    results.extend(out_res["_multi"])
                elif isinstance(out_res, list):
                    results.extend(out_res)
                else:
                    results.append(out_res)
            except InterruptedError:
                raise
            except Exception as e:
                if not self.batch:
                    raise
                results.append({"name": self.item_label(item), "status": "failed", "error": str(e)[:200]})
            finally:
                shutil.rmtree(item_dir, ignore_errors=True)
                for p in list(OUT_DIR.iterdir()) if OUT_DIR.exists() else []:
                    shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        return results

    # ---------------- Final report ----------------

    def uname(self) -> str:
        u = self.job.get("username") or "User"
        if not u.startswith("@") and re.match(r"^[A-Za-z0-9_]{4,}$", u) and u != "User":
            u = "@" + u
        role = (self.job.get("userRole") or "").strip()
        return f"{u} [{role}]" if role else u

    def report(self, results: list):
        elapsed = fmt_duration(time.time() - self.task_start)
        ok = [r for r in results if r.get("status") in ("completed", "skipped")]
        overall = "completed" if ok else "failed"
        is_leech = self.dest == "telegram"
        is_gofile = self.dest == "gofile"
        is_gh_release = self.dest == "ghrelease"
        is_gc_temp = bool(self.is_shared_gc_temp and not is_gofile and not is_leech and not is_gh_release)
        completed_with_id = [r for r in ok if r.get("status") == "completed" and r.get("id")]
        total_gc_size = sum(int(r.get("size") or 0) for r in completed_with_id)
        can_req_perm = bool(is_gc_temp and completed_with_id and total_gc_size <= PERM_REQ_MAX_BYTES)

        if is_gh_release:
            if not ok and len(results) == 1 and results[0].get("status") == "failed":
                raise RuntimeError(results[0].get("error") or "GitHub Release failed")
            rel_url = self.gh_release_url or next((r.get("releaseUrl") for r in ok if r.get("releaseUrl")), "") or f"https://github.com/{self.gh_repo}/releases"
            total_sz = sum(int(r.get("size") or 0) for r in ok)
            flags = []
            if self.gh_draft:
                flags.append("Draft")
            if self.gh_prerelease:
                flags.append("Pre-release")
            flag_line = f"Type  ·  <code>{', '.join(flags)}</code>\n\n" if flags else ""

            if len(results) == 1 and ok:
                r = ok[0]
                text = (
                    f"<blockquote><b>GitHub Release Published</b>\n\n"
                    f"<code>{html.escape(r['name'])}</code></blockquote>\n\n"
                    f"Size  ·  <code>{fmt_bytes(r.get('size', 0))}</code>\n\n"
                    f"Repo  ·  <code>{html.escape(self.gh_repo)}</code>\n\n"
                    f"Tag  ·  <code>{html.escape(self.gh_tag)}</code>\n\n"
                    f"{flag_line}"
                    f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                )
                btns = [{"text": "▸  Open Release", "url": rel_url, "style": "success"}]
                if r.get("direct"):
                    btns.append({"text": "⬇ Download Asset", "url": r["direct"], "style": "primary"})
                kb = {"inline_keyboard": [btns]}
            else:
                header = (
                    f"<blockquote><b>{'GitHub Release Published' if ok else 'GitHub Release Failed'}</b>\n\n"
                    f"<code>{len(ok)} / {len(results)} asset(s)</code>"
                    f"{f' · {fmt_bytes(total_sz)}' if total_sz > 0 else ''}</blockquote>\n\n"
                )
                footer = (
                    f"\nRepo  ·  <code>{html.escape(self.gh_repo)}</code>\n\n"
                    f"Tag  ·  <code>{html.escape(self.gh_tag)}</code>\n\n"
                    f"{flag_line}"
                    f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                )
                body = ""
                for n, r in enumerate(results, 1):
                    name = html.escape(truncate(r.get("name", "asset"), 48))
                    if r.get("status") == "completed":
                        if r.get("direct"):
                            line = f"{n}. ✓ <a href=\"{html.escape(r['direct'], quote=True)}\">{name}</a>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                        else:
                            line = f"{n}. ✓ <code>{name}</code>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                    else:
                        line = f"{n}. ✗ <code>{name}</code>\n    <i>{html.escape(truncate(r.get('error', 'failed'), 120))}</i>\n"
                    if len(header) + len(body) + len(line) + len(footer) > 3900:
                        body += f"\n<i>…and {len(results) - n + 1} more asset(s).</i>\n"
                        break
                    body += line
                text = header + body + footer
                btns = [{"text": "▸  Open Release", "url": rel_url, "style": "success"}]
                first_dl = next((r.get("direct") for r in ok if r.get("direct")), "")
                if first_dl:
                    btns.append({"text": "⬇ Download First Asset", "url": first_dl, "style": "primary"})
                kb = {"inline_keyboard": [btns]}
        elif is_leech:
            if not ok and len(results) == 1 and results[0].get("status") == "failed":
                raise RuntimeError(results[0].get("error") or "Leech failed")
            total_sz = sum(int(r.get("size") or 0) for r in ok)
            if len(results) == 1 and ok:
                r = ok[0]
                text = (
                    f"<blockquote><b>Leech Complete</b>\n\n"
                    f"<code>{html.escape(r['name'])}</code></blockquote>\n\n"
                    f"Size  ·  <code>{fmt_bytes(r.get('size', 0))}</code>\n\n"
                    f"Dest  ·  Telegram Chat ({'Document' if self.leech_as_doc else 'Media'})\n\n"
                    f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                )
                kb = {"inline_keyboard": [[{"text": "▸  Jump to File", "url": r["link"], "style": "success"}]]} if r.get("link") else None
            else:
                header = (
                    f"<blockquote><b>{'Leech Complete' if ok else 'Leech Failed'}</b>\n\n"
                    f"<code>{len(ok)} / {len(results)} uploaded</code>"
                    f"{f' · {fmt_bytes(total_sz)}' if total_sz > 0 else ''}</blockquote>\n\n"
                )
                footer = (
                    f"\nDest  ·  Telegram Chat ({'Document' if self.leech_as_doc else 'Media'})\n\n"
                    f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                )
                body = ""
                for n, r in enumerate(results, 1):
                    name = html.escape(truncate(r.get("name", "item"), 48))
                    if r.get("status") == "completed":
                        if r.get("link"):
                            line = f"{n}. ✓ <a href=\"{html.escape(r['link'], quote=True)}\">{name}</a>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                        else:
                            line = f"{n}. ✓ <code>{name}</code>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                    else:
                        line = f"{n}. ✗ <code>{name}</code>\n    <i>{html.escape(truncate(r.get('error', 'failed'), 120))}</i>\n"
                    if len(header) + len(body) + len(line) + len(footer) > 3900:
                        body += f"\n<i>…and {len(results) - n + 1} more file(s).</i>\n"
                        break
                    body += line
                text = header + body + footer
                first_link = next((r.get("link") for r in ok if r.get("link")), "")
                kb = {"inline_keyboard": [[{"text": "▸  Jump to First File", "url": first_link, "style": "success"}]]} if first_link else None
        elif not self.batch and len(results) == 1:
            r = results[0]
            if r.get("status") == "failed":
                raise RuntimeError(r.get("error") or "Transfer failed")
            title = "Transfer Complete" if r["status"] == "completed" else "Skipped — Already Exists"
            text = (
                f"<blockquote><b>{title}</b>\n\n"
                f"<code>{html.escape(r['name'])}</code></blockquote>\n\n"
                f"Size  ·  <code>{fmt_bytes(r.get('size', 0))}</code>\n\n"
            )
            if is_gofile:
                text += "Dest  ·  Gofile (Guest Session)\n\nAccess  ·  Public Link\n\n"
            else:
                text += f"Folder  ·  {html.escape(self.folder_name)}\n\n"
                if r.get("shared") or is_gc_temp:
                    text += "Access  ·  Anyone with the link\n\n"
            text += f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
            if self.tg_sent > 0 or self.tg_skipped > 0 or self.tg_note:
                if self.tg_sent > 0 and self.tg_skipped > 0:
                    tg_status = f"Sent {self.tg_sent} file(s) (< 2 GB), skipped {self.tg_skipped} (> 2 GB)"
                elif self.tg_sent > 0:
                    tg_status = f"Sent {self.tg_sent} media file(s) to chat"
                else:
                    tg_status = self.tg_note or "Skipped"
                text += f"\n\nTelegram  ·  {html.escape(tg_status)}"
            if is_gofile:
                text += f"\n\n<blockquote>{GOFILE_NOTICE_HTML}</blockquote>"
                rows = [[{"text": "▸  Open Gofile Folder" if r.get("isDir") else "▸  Open Gofile", "url": r["link"], "style": "success"}]]
            else:
                if is_gc_temp:
                    text += f"\n\n<blockquote>{GC_TEMP_NOTICE_HTML}</blockquote>"
                primary_label = (
                    ("⬇ Download Folder" if r.get("isDir") else "⬇ Download File")
                    if is_gc_temp
                    else ("▸  Open Folder" if r.get("isDir") else "▸  Open File")
                )
                rows = [[
                    {"text": primary_label, "url": r["link"], "style": "success"},
                    {"text": "Open Folder", "url": self.folder_url(), "style": "primary"},
                ]]
                if r.get("direct") and not is_gc_temp:
                    rows.append([{"text": "⬇ Direct Download", "url": r["direct"], "style": "primary"}])
                if can_req_perm:
                    rows.append([{"text": "📌 Request Permanent Storage", "callback_data": f"perm_req:{JOB_ID}", "style": "primary"}])
            kb = {"inline_keyboard": rows}
        else:
            header = (
                f"<blockquote><b>{'Batch Complete' if ok else 'Batch Failed'}</b>\n\n"
                f"<code>{len(ok)} / {len(results)} succeeded</code></blockquote>\n\n"
            )
            dest_line = "Dest  ·  Gofile (Guest Session)" if is_gofile else f"Folder  ·  {html.escape(self.folder_name)}"
            tg_line = ""
            if self.tg_sent > 0 or self.tg_skipped > 0 or self.tg_note:
                if self.tg_sent > 0 and self.tg_skipped > 0:
                    tg_status = f"Sent {self.tg_sent} file(s) (< 2 GB), skipped {self.tg_skipped} (> 2 GB)"
                elif self.tg_sent > 0:
                    tg_status = f"Sent {self.tg_sent} media file(s) to chat"
                else:
                    tg_status = self.tg_note or "Skipped"
                tg_line = f"\nTelegram  ·  {html.escape(tg_status)}\n"
            warn_block = (
                f"\n\n<blockquote>{GOFILE_NOTICE_HTML}</blockquote>"
                if (is_gofile and ok)
                else (f"\n\n<blockquote>{GC_TEMP_NOTICE_HTML}</blockquote>" if (is_gc_temp and ok) else "")
            )
            footer = (
                f"\n{dest_line}\n{tg_line}\n"
                f"Elapsed  ·  <code>{elapsed}</code>\n\nUser  ·  {html.escape(self.uname())}"
                f"{warn_block}"
            )
            body = ""
            for n, r in enumerate(results, 1):
                name = html.escape(truncate(r.get("name", "item"), 48))
                if r.get("status") == "completed":
                    line = f"{n}. ✓ <a href=\"{html.escape(r['link'], quote=True)}\">{name}</a>  <code>{fmt_bytes(r.get('size', 0))}</code>\n"
                elif r.get("status") == "skipped":
                    line = f"{n}. ↷ <a href=\"{html.escape(r['link'], quote=True)}\">{name}</a>  <i>exists, skipped</i>\n"
                else:
                    line = f"{n}. ✗ <code>{name}</code>\n    <i>{html.escape(truncate(r.get('error', 'failed'), 120))}</i>\n"
                if len(header) + len(body) + len(line) + len(footer) > 3900:
                    body += f"\n<i>…and {len(results) - n + 1} more. See /history.</i>\n"
                    break
                body += line
            text = header + body + footer
            if is_gofile:
                kb = {"inline_keyboard": [[{"text": "▸  Open Gofile Folder", "url": self.gofile_link, "style": "success"}]]} if self.gofile_link else None
            else:
                rows = [[{"text": "▸  Open Folder", "url": self.folder_url(), "style": "success"}]]
                if can_req_perm:
                    rows.append([{"text": "📌 Request Permanent Storage", "callback_data": f"perm_req:{JOB_ID}", "style": "primary"}])
                kb = {"inline_keyboard": rows}

        _, synced_msg_id = sync_worker_state(JOB_ID)
        if synced_msg_id is not None:
            self.message_id = synced_msg_id
        leech_msg_ids = [r.get("msgId") for r in ok if r.get("msgId")] if is_leech else []
        if is_leech:
            finish_status(self.chat_id, self.message_id, text, kb, thread_id=self.thread_id)
            worker_call("/internal/complete", {
                "job_id": JOB_ID,
                "status": overall,
                "items": results,
                "msg_id": self.message_id,
                "leech_msg_ids": leech_msg_ids,
            })
        else:
            worker_call("/internal/complete", {
                "job_id": JOB_ID,
                "status": overall,
                "items": results,
                "msg_id": self.message_id,
                "mirror_html": text,
                "mirror_kb": kb,
            })
            finish_status(self.chat_id, self.message_id, text, kb, thread_id=self.thread_id)


def main():
    if not WORKER_URL or not JOB_SECRET or not JOB_ID:
        print("Missing WORKER_URL, JOB_SECRET, or JOB_ID", flush=True)
        sys.exit(1)

    mask_secret(JOB_SECRET)
    mask_secret(BOT_TOKEN)
    mask_secret(TELEGRAM_API_ID)
    mask_secret(TELEGRAM_API_HASH)

    init_res = worker_call("/internal/job", {"job_id": JOB_ID, "run_id": GITHUB_RUN_ID})
    if not init_res.get("ok"):
        print("Failed to fetch job from worker:", init_res.get("error"), flush=True)
        sys.exit(1)

    job = init_res["job"]
    access_token = job.get("accessToken") or ""
    mask_secret(access_token)
    mask_secret(job.get("fileUrl", ""))

    m = Mirror(job, access_token, job.get("tokenExpiry"))
    display = job.get("customName") or job.get("detectedName") or "Task"

    try:
        results = m.run()
        m.report(results)
    except InterruptedError:
        text = (
            f"<blockquote><b>Task Cancelled</b>\n\n"
            f"<code>{html.escape(display)}</code></blockquote>\n\n"
            f"Task ID  ·  <code>{html.escape(JOB_ID)}</code>"
        )
        _, synced = sync_worker_state(JOB_ID)
        if synced is not None:
            m.message_id = synced
        finish_status(m.chat_id, m.message_id, text, thread_id=m.thread_id)
        worker_call("/internal/complete", {"job_id": JOB_ID, "status": "cancelled"})
    except Exception as e:
        reason = friendly_drive_error(str(e)) or str(e)
        text = (
            f"<blockquote><b>Transfer Failed</b>\n\n"
            f"<code>{html.escape(display)}</code></blockquote>\n\n"
            f"Reason  ·  <code>{html.escape(reason[:300])}</code>"
        )
        _, synced = sync_worker_state(JOB_ID)
        if synced is not None:
            m.message_id = synced
        finish_status(m.chat_id, m.message_id, text, thread_id=m.thread_id)
        worker_call("/internal/complete", {
            "job_id": JOB_ID,
            "status": "failed",
            "error": reason[:300],
            "items": [{"name": display, "status": "failed", "error": reason[:200]}],
        })
        sys.exit(1)
    finally:
        m.stop_aria()
        m.stop_token_server()


if __name__ == "__main__":
    main()
