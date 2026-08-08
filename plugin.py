"""
QwenPaw 本地资源监控插件（qwenpaw-resource-monitor）v0.1.0

在 QwenPaw 界面内实时展示**服务器本地资源占用**：CPU / 内存 / 磁盘 /
网络 / 进程 / GPU，纯只读监控，不做任何写操作。

数据采集：
  - psutil 采集 CPU（总体 + 每核）、内存（含 swap）、磁盘分区、网络接口、
    进程列表、负载、开机时长；零系统包依赖（psutil 为纯 Python 包）。
  - GPU 通过 `nvidia-smi` 探测（有 N 卡才返回数据，否则 null），
    探测失败/超时静默降级，不影响主监控。

接口：
  - GET /api/qwenpaw-resource-monitor/status    插件版本/名称/运行时长
  - GET /api/qwenpaw-resource-monitor/snapshot 全量资源快照（一次请求全部数据）

性能与正确性：
  - CPU 使用率用 cpu_times 差值计算（非阻塞，不 sleep；首次请求返回 0，
    之后每次基于与上次请求的差值，前端轮询即自动准确）。
  - 网络速率用字节计数器差值 / 时间差（bytes/s）。
  - 进程扫描 try/except 容错（进程可能随时退出），按 CPU 降序取 Top 80，
    前端可再按内存排序展示。
  - 磁盘分区排除伪文件系统（proc/sysfs/devtmpfs 等），根分区 overlay 保留。
"""
import logging
import os
import platform
import socket
import subprocess
import time
from datetime import datetime, timezone

import psutil
from fastapi import APIRouter
from qwenpaw.pawapp import PawApp

logger = logging.getLogger(__name__)

PLUGIN_VERSION = "0.1.0"
PLUGIN_NAME = "资源监控"
PLUGIN_ID = "qwenpaw-resource-monitor"

STARTED_AT = time.time()

# 伪文件系统 / 内存盘（不展示的分区类型；根分区 "/" 无论类型都保留）
_FAKE_FSTYPES = {
    "proc", "sysfs", "devtmpfs", "cgroup", "cgroup2", "autofs",
    "securityfs", "pstore", "bpf", "debugfs", "tracefs", "configfs",
    "fusectl", "mqueue", "hugetlbfs", "rpc_pipefs", "binfmt_misc",
    "devpts", "nsfs", "tmpfs", "ramfs", "shm", "squashfs",
}

# 上一帧采样（CPU 差值 / 网络差值）
_last_cpu_times = None
_last_cpu_wall = None
_last_net = None
_last_net_wall = None


# ---------- 采集工具 ----------

def _cpu_usage() -> float:
    """CPU 总使用率（%），基于 cpu_times 差值，非阻塞。"""
    global _last_cpu_times, _last_cpu_wall
    t = psutil.cpu_times()
    now = time.monotonic()
    if _last_cpu_times is None or _last_cpu_wall is None:
        _last_cpu_times, _last_cpu_wall = t, now
        return 0.0
    dt = now - _last_cpu_wall
    if dt <= 0:
        return 0.0
    idle_delta = t.idle - _last_cpu_times.idle
    if hasattr(t, "iowait"):
        idle_delta += t.iowait - _last_cpu_times.iowait
    busy_delta = (
        (t.user - _last_cpu_times.user)
        + (t.system - _last_cpu_times.system)
        + (t.nice - _last_cpu_times.nice)
    )
    total = idle_delta + busy_delta
    pct = 100.0 * busy_delta / total if total > 0 else 0.0
    _last_cpu_times, _last_cpu_wall = t, now
    return round(pct, 1)


def _net_rate() -> tuple:
    """网络收发速率（rx_bps, tx_bps），基于字节计数器差值。"""
    global _last_net, _last_net_wall
    n = psutil.net_io_counters()
    now = time.monotonic()
    if _last_net is None or _last_net_wall is None:
        _last_net, _last_net_wall = n, now
        return 0.0, 0.0
    dt = now - _last_net_wall
    if dt <= 0:
        return 0.0, 0.0
    rx = (n.bytes_recv - _last_net.bytes_recv) / dt
    tx = (n.bytes_sent - _last_net.bytes_sent) / dt
    _last_net, _last_net_wall = n, now
    return max(rx, 0.0), max(tx, 0.0)


def _gpu_info():
    """nvidia-smi 探测 GPU（失败/无卡返回 None）。"""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return None
        gpus = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 4:
                continue
            gpus.append({
                "name": parts[0],
                "util": int(parts[1]),
                "mem_used": int(parts[2]),
                "mem_total": int(parts[3]),
                "temp": int(parts[4]) if len(parts) > 4 else None,
            })
        return gpus or None
    except Exception:  # noqa: BLE001
        return None


def _procs_top():
    """进程列表（Top 80 by CPU），容错收集。"""
    out = []
    for p in psutil.process_iter(["pid", "name", "username", "cpu_percent",
                                  "memory_percent", "memory_info", "status"]):
        try:
            info = p.info
            rss = 0
            if info.get("memory_info"):
                rss = info["memory_info"].rss
            out.append({
                "pid": info.get("pid") or 0,
                "name": (info.get("name") or "?")[:64],
                "username": (info.get("username") or "?")[:32],
                "cpu": round(info.get("cpu_percent") or 0.0, 1),
                "mem": round(info.get("memory_percent") or 0.0, 2),
                "rss": rss,
                "status": info.get("status") or "?",
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    out.sort(key=lambda x: x["cpu"], reverse=True)
    return out[:80]


def _disks():
    """磁盘分区（all=True 才能看到 overlay/NFS），过滤伪文件系统/单文件/内存盘。"""
    disks = []
    for part in psutil.disk_partitions(all=True):
        mp = part.mountpoint
        # 根分区无论 fstype 都保留（容器根常是 overlay）
        if part.fstype in _FAKE_FSTYPES and mp != "/":
            continue
        # 单文件 bind mount（/etc/hosts、/etc/resolv.conf、/dev/termination-log 等）
        if not os.path.isdir(mp):
            continue
        # 小内存盘（/dev/shm）无监控意义
        if mp == "/dev/shm":
            continue
        # 容器运行时特殊挂载（CSI socket / sandbox 注入），无监控意义
        if mp.startswith("/run/csi/sockets/") or mp == "/var/opt/sandbox/agent-token":
            continue
        try:
            usage = psutil.disk_usage(mp)
        except (OSError, PermissionError):
            continue
        disks.append({
            "device": part.device,
            "mountpoint": mp,
            "fstype": part.fstype,
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": usage.percent,
        })
    disks.sort(key=lambda x: x["mountpoint"])
    return disks


def _net_interfaces():
    """网络接口：名称 / 地址 / 速率。"""
    try:
        io = psutil.net_io_counters(pernic=True)
    except Exception:  # noqa: BLE001
        return []
    addrs = psutil.net_if_addrs()
    now = time.monotonic()
    out = []
    for name, counters in io.items():
        ipv4 = ""
        ipv6 = ""
        for a in addrs.get(name, []):
            if a.family == socket.AF_INET and not ipv4:
                ipv4 = a.address
            elif a.family == socket.AF_INET6 and not ipv6 and "%" not in a.address:
                ipv6 = a.address
        out.append({
            "name": name,
            "ipv4": ipv4,
            "ipv6": ipv6,
            "rx_bps": 0.0,
            "tx_bps": 0.0,
            "bytes_recv": counters.bytes_recv,
            "bytes_sent": counters.bytes_sent,
            "ts": now,
        })
    return out


# 接口级网络速率缓存（pernic 差值）
_prev_iface = {}
_prev_iface_wall = {}


def _iface_rates(interfaces):
    """基于上一帧 pernic 计数计算各接口速率（就地更新 rx_bps/tx_bps）。"""
    global _prev_iface, _prev_iface_wall
    now = time.monotonic()
    for itf in interfaces:
        name = itf["name"]
        prev = _prev_iface.get(name)
        prev_wall = _prev_iface_wall.get(name)
        if prev is not None and prev_wall is not None:
            dt = now - prev_wall
            if dt > 0:
                itf["rx_bps"] = max((itf["bytes_recv"] - prev) / dt, 0.0)
                itf["tx_bps"] = max((itf["bytes_sent"] - prev) / dt, 0.0)
        _prev_iface[name] = itf["bytes_recv"]
        _prev_iface_wall[name] = now
    return interfaces


# ---------- 快照 ----------

def _snapshot() -> dict:
    rx_bps, tx_bps = _net_rate()
    mem = psutil.virtual_memory()
    swap = psutil.swap_memory()
    load = None
    try:
        load = [round(x, 2) for x in psutil.getloadavg()]
    except (OSError, AttributeError):
        pass
    boot = psutil.boot_time()
    uname = platform.uname()
    net_total = psutil.net_io_counters()
    interfaces = _iface_rates(_net_interfaces())
    return {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "system": {
            "hostname": socket.gethostname(),
            "system": uname.system,
            "release": uname.release,
            "version": uname.version,
            "machine": uname.machine,
            "python": platform.python_version(),
            "boot_ts": int(boot),
            "uptime_s": int(time.time() - boot),
        },
        "cpu": {
            "percent": _cpu_usage(),
            "per_core": psutil.cpu_percent(interval=None, percpu=True),
            "count": psutil.cpu_count(logical=True),
            "physical": psutil.cpu_count(logical=False) or psutil.cpu_count(logical=True),
            "load_avg": load,
        },
        "mem": {
            "total": mem.total,
            "used": mem.used,
            "free": mem.free,
            "available": mem.available,
            "percent": mem.percent,
            "swap_total": swap.total,
            "swap_used": swap.used,
            "swap_percent": swap.percent,
        },
        "disk": _disks(),
        "net": {
            "rx_bps": rx_bps,
            "tx_bps": tx_bps,
            "bytes_recv": net_total.bytes_recv,
            "bytes_sent": net_total.bytes_sent,
            "interfaces": interfaces,
        },
        "procs": _procs_top(),
        "gpu": _gpu_info(),
    }


# ---------- 路由 ----------

router = APIRouter()


@router.get("/status")
async def get_status():
    """插件状态：版本/名称/运行时长。"""
    return {
        "id": PLUGIN_ID,
        "name": PLUGIN_NAME,
        "version": PLUGIN_VERSION,
        "uptime_s": int(time.time() - STARTED_AT),
    }


@router.get("/snapshot")
async def get_snapshot():
    """全量资源快照。"""
    try:
        return _snapshot()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[qwenpaw-resource-monitor] snapshot failed: %s", exc)
        return {"error": str(exc)}


# ============ 应用注册 ============

app = PawApp(name=PLUGIN_NAME, app_id=PLUGIN_ID)
app.include_router(router)


@app.hook("shutdown")
async def _shutdown() -> None:
    logger.info("[qwenpaw-resource-monitor] Plugin stopped")


# REQUIRED: 模块级 plugin 实例（PawApp 导出为 'app'；loader 同时接受 'plugin'）
plugin = app
