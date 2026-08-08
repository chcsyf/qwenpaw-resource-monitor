/**
 * QwenPaw 本地资源监控 v0.1.0 — 前端 GUI
 * （qwenpaw-resource-monitor 插件）
 *
 * 展示服务器本地资源占用：
 *  - 顶部系统信息条（主机名/OS/内核/开机时长/刷新间隔选择）
 *  - 概览卡片：CPU / 内存 / 磁盘(根) / 网络速率 / 进程数 / 运行时长
 *  - CPU + 内存 2 分钟实时折线图（canvas 自绘，不依赖外部图表库）
 *  - 磁盘分区进度条列表、网络接口速率列表、GPU 卡片（有 N 卡才显示）
 *  - 进程 Top 榜：点击表头切换按 CPU / 内存排序
 * 数据来源：GET /api/qwenpaw-resource-monitor/snapshot（psutil 采集）
 */
(function () {
  "use strict";

  if (!window.QwenPaw || !window.QwenPaw.host) {
    console.error("[qwenpaw-resource-monitor] QwenPaw not ready");
    return;
  }

  var QP = window.QwenPaw;
  var React = QP.host.React;
  var h = React.createElement;

  var PLUGIN_ID = "qwenpaw-resource-monitor";
  var PLUGIN_NAME = "资源监控";
  var VERSION = "0.1.0";
  var API = "/api/" + PLUGIN_ID;
  var MAX_HISTORY = 60; // 60 点 × 2s ≈ 2 分钟窗口

  // ---------- 样式（GitHub Dark） ----------
  var C = {
    bg: "#0d1117",
    panel: "#161b22",
    border: "#30363d",
    text: "#e6edf3",
    muted: "#8b949e",
    green: "#3fb950",
    blue: "#58a6ff",
    orange: "#d29922",
    purple: "#bc8cff",
    cyan: "#39c5cf",
    red: "#f85149",
  };

  var S = {
    wrap: {
      display: "flex", flexDirection: "column",
      height: "100%", minHeight: 0,
      background: C.bg, color: C.text,
      fontFamily: "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif",
      fontSize: 13,
    },
    sysBar: {
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "6px 12px",
      background: C.panel,
      borderBottom: "1px solid " + C.border,
      flexShrink: 0, color: C.muted, fontSize: 12,
    },
    sysBarItem: { display: "flex", alignItems: "center", gap: 4 },
    sysLabel: { color: C.muted },
    sysVal: { color: C.text, fontWeight: 600 },
    spacer: { flex: 1 },
    select: {
      background: C.bg, color: C.text,
      border: "1px solid " + C.border, borderRadius: 6,
      padding: "2px 6px", fontSize: 12,
    },
    body: { flex: 1, minHeight: 0, overflow: "auto", padding: 12, boxSizing: "border-box" },
    errBar: {
      margin: "0 0 10px", padding: "6px 10px",
      background: "rgba(248,81,73,0.12)", color: C.red,
      border: "1px solid rgba(248,81,73,0.4)", borderRadius: 6, fontSize: 12,
    },
    cardRow: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 },
    card: {
      flex: "1 1 150px", minWidth: 140,
      background: C.panel,
      border: "1px solid " + C.border, borderRadius: 8,
      padding: "10px 12px",
      display: "flex", flexDirection: "column", gap: 4,
    },
    cardTitle: { color: C.muted, fontSize: 12, display: "flex", alignItems: "center", gap: 5 },
    cardValue: { fontSize: 22, fontWeight: 700, lineHeight: 1.1 },
    cardSub: { color: C.muted, fontSize: 11 },
    bar: {
      height: 6, borderRadius: 3,
      background: "#21262d", overflow: "hidden",
    },
    barFill: { height: "100%", borderRadius: 3, transition: "width .4s ease" },
    section: {
      background: C.panel,
      border: "1px solid " + C.border, borderRadius: 8,
      marginBottom: 10, padding: "10px 12px",
    },
    sectionTitle: {
      color: C.text, fontSize: 13, fontWeight: 600,
      marginBottom: 8, display: "flex", alignItems: "center", gap: 6,
    },
    chartRow: { display: "flex", gap: 10, flexWrap: "wrap" },
    chartLegend: {
      display: "flex", gap: 14, fontSize: 11, color: C.muted,
      marginBottom: 4,
    },
    legendDot: { width: 10, height: 3, borderRadius: 2, display: "inline-block", marginRight: 4, verticalAlign: "middle" },
    row: {
      display: "flex", alignItems: "center", gap: 8,
      padding: "4px 0", borderBottom: "1px solid #21262d",
      fontSize: 12,
    },
    rowName: { flex: "0 0 180px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.text },
    rowSub: { flex: "0 0 140px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: C.muted, fontSize: 11 },
    rowFlex: { flex: 1, minWidth: 60 },
    pct: { flex: "0 0 44px", textAlign: "right", color: C.text, fontVariantNumeric: "tabular-nums" },
    tabBtn: {
      background: "transparent", color: C.muted,
      border: "1px solid " + C.border, borderRadius: 6,
      padding: "3px 10px", cursor: "pointer", fontSize: 12,
    },
    tabBtnOn: {
      background: "rgba(88,166,255,0.15)", color: C.blue,
      border: "1px solid " + C.blue, borderRadius: 6,
      padding: "3px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
    },
    th: {
      textAlign: "left", color: C.muted, fontSize: 11,
      padding: "4px 8px", borderBottom: "1px solid " + C.border,
      cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
    },
    td: {
      padding: "4px 8px", fontSize: 12,
      borderBottom: "1px solid #21262d",
      fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
    },
    loading: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.muted },
    gpuGrid: { display: "flex", gap: 10, flexWrap: "wrap" },
  };

  // ---------- 工具 ----------
  function fetchJson(url, opts) {
    var o = opts || {};
    return fetch(url, o).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.status); });
      return r.json();
    });
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "-";
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB", "TB"], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + " " + u[i];
  }

  function fmtRate(bps) {
    if (bps == null || isNaN(bps)) return "-";
    return fmtBytes(bps) + "/s";
  }

  function fmtUptime(s) {
    if (!s) return "-";
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + "天 " + h + "小时";
    if (h > 0) return h + "小时 " + m + "分";
    return m + "分 " + Math.floor(s % 60) + "秒";
  }

  function fmtDate(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    var p = function (x) { return x < 10 ? "0" + x : String(x); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function pctColor(p) {
    if (p >= 90) return C.red;
    if (p >= 70) return C.orange;
    return C.green;
  }

  // ---------- 折线图（canvas 自绘） ----------
  function LineChart(props) {
    var ref = React.useRef(null);
    var history = props.history || [];
    var series = props.series || [];
    React.useEffect(function () {
      var canvas = ref.current;
      if (!canvas) return;
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = w * dpr; canvas.height = h * dpr;
      var ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#161b22";
      ctx.fillRect(0, 0, w, h);
      var padL = 34, padR = 8, padT = 8, padB = 16;
      var plotW = w - padL - padR, plotH = h - padT - padB;
      if (plotW <= 0 || plotH <= 0) return;
      ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
      ctx.fillStyle = "#8b949e"; ctx.font = "10px monospace"; ctx.textAlign = "right";
      for (var g = 0; g <= 4; g++) {
        var y = padT + plotH - (g / 4) * plotH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
        ctx.fillText(String(g * 25), padL - 4, y + 3);
      }
      var n = history.length;
      if (n >= 2) {
        series.forEach(function (s) {
          ctx.strokeStyle = s.color; ctx.lineWidth = 1.5; ctx.beginPath();
          for (var i = 0; i < n; i++) {
            var x = padL + (i / (n - 1)) * plotW;
            var val = history[i][s.key] || 0;
            var yv = padT + plotH - Math.max(0, Math.min(val, 100)) / 100 * plotH;
            if (i === 0) ctx.moveTo(x, yv); else ctx.lineTo(x, yv);
          }
          ctx.stroke();
        });
      }
      // 最新值高亮
      if (n > 0) {
        series.forEach(function (s) {
          var val = history[n - 1][s.key] || 0;
          var x = padL + ((n - 1) / (n - 1)) * plotW;
          var yv = padT + plotH - Math.max(0, Math.min(val, 100)) / 100 * plotH;
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(x, yv, 2.5, 0, Math.PI * 2); ctx.fill();
        });
      }
    });
    return h("div", { style: { flex: "1 1 320px", minWidth: 280 } },
      h("div", { style: S.chartLegend },
        series.map(function (s) {
          return h("span", { key: s.key },
            h("span", { style: Object.assign({}, S.legendDot, { background: s.color }) }),
            s.label + " " + ((history.length ? history[history.length - 1][s.key] : 0) || 0) + "%");
        })
      ),
      h("div", { style: { height: 110, position: "relative", border: "1px solid #21262d", borderRadius: 6, overflow: "hidden" } },
        h("canvas", { ref: ref, style: { width: "100%", height: "100%", display: "block" } })));
  }

  // ---------- 概览卡片 ----------
  function StatCard(props) {
    var color = props.color || C.blue;
    return h("div", { style: S.card },
      h("div", { style: S.cardTitle }, h("span", null, props.icon || "•"), props.title),
      h("div", { style: Object.assign({}, S.cardValue, { color: color }) }, props.value),
      h("div", { style: S.cardSub }, props.sub || ""),
      props.barPct != null ? h("div", { style: S.bar },
        h("div", { style: Object.assign({}, S.barFill, { width: Math.max(0, Math.min(100, props.barPct)) + "%", background: color }) })) : null);
  }

  // ---------- 主组件 ----------
  function App() {
    // ⚠ state 必须配对获取：React.useState() 返回 [value, setter]，
    // 分开写两次 useState 会创建两个独立 state，getter/setter 不配对导致 UI 不更新
    var snapPair = React.useState(null);
    var snap = snapPair[0];
    var setSnap = snapPair[1];
    var errPair = React.useState(null);
    var err = errPair[0];
    var setErr = errPair[1];
    var histPair = React.useState([]);
    var history = histPair[0];
    var setHistory = histPair[1];
    var intPair = React.useState(2000);
    var intervalMs = intPair[0];
    var setIntervalMs = intPair[1];
    var sortPair = React.useState("cpu");
    var sortKey = sortPair[0];
    var setSortKey = sortPair[1];

    React.useEffect(function () {
      var alive = true;
      function load() {
        fetchJson(API + "/snapshot").then(function (d) {
          if (!alive) return;
          if (d.error) { setErr(d.error); return; }
          setErr(null);
          setSnap(d);
          setHistory(function (h) {
            var next = h.concat([{ cpu: d.cpu.percent, mem: d.mem.percent }]);
            if (next.length > MAX_HISTORY) next = next.slice(next.length - MAX_HISTORY);
            return next;
          });
        }).catch(function (e) {
          if (alive) setErr(String((e && e.message) || e));
        });
      }
      load();
      if (intervalMs > 0) {
        var t = setInterval(load, intervalMs);
        return function () { alive = false; clearInterval(t); };
      }
      return function () { alive = false; };
    }, [intervalMs]);

    if (!snap) {
      return h("div", { style: S.wrap },
        h("div", { style: S.loading }, "加载中…" + (err ? "（" + err + "）" : "")));
    }

    var sys = snap.system || {};
    var cpu = snap.cpu || {};
    var mem = snap.mem || {};
    var net = snap.net || {};
    var diskRoot = (snap.disk || []).filter(function (d) { return d.mountpoint === "/"; })[0];
    var diskPct = diskRoot ? diskRoot.percent : 0;
    var procs = (snap.procs || []).slice().sort(function (a, b) {
      return sortKey === "mem" ? b.mem - a.mem : b.cpu - a.cpu;
    }).slice(0, 15);
    var gpus = snap.gpu || null;

    var cards = [
      { icon: "🧠", title: "CPU", color: C.green, value: (cpu.percent || 0).toFixed(1) + "%", sub: cpu.count + " 核 / 负载 " + ((cpu.load_avg || [])[0] || "-"), barPct: cpu.percent },
      { icon: "💾", title: "内存", color: C.blue, value: fmtBytes(mem.used) + " / " + fmtBytes(mem.total), sub: "可用 " + fmtBytes(mem.available), barPct: mem.percent },
      { icon: "📀", title: "磁盘 /", color: C.orange, value: diskRoot ? fmtBytes(diskRoot.used) + " / " + fmtBytes(diskRoot.total) : "-", sub: diskRoot ? diskRoot.percent.toFixed(0) + "% 已用（" + (diskRoot.device || "") + "）" : "无根分区数据", barPct: diskPct },
      { icon: "🌐", title: "网络", color: C.purple, value: "↓ " + fmtRate(net.rx_bps), sub: "↑ " + fmtRate(net.tx_bps) + " · 总收 " + fmtBytes(net.bytes_recv) },
      { icon: "⚙️", title: "进程", color: C.cyan, value: String((snap.procs || []).length), sub: "Top 80 展示", barPct: null },
      { icon: "⏱️", title: "运行时长", color: C.muted, value: fmtUptime(sys.uptime_s), sub: "开机 " + fmtDate(sys.boot_ts), barPct: null },
    ];

    return h("div", { style: S.wrap },
      // 系统信息条
      h("div", { style: S.sysBar },
        h("span", { style: S.sysBarItem }, h("span", { style: S.sysLabel }, "🖥 "), h("span", { style: S.sysVal }, sys.hostname || "-")),
        h("span", { style: S.sysBarItem }, h("span", { style: S.sysLabel }, "OS "), h("span", { style: S.sysVal }, (sys.system || "-") + " " + (sys.release || ""))),
        h("span", { style: S.sysBarItem }, h("span", { style: S.sysLabel }, "内核 "), h("span", { style: S.sysVal }, sys.machine || "")),
        h("span", { style: S.sysBarItem }, h("span", { style: S.sysLabel }, "Python "), h("span", { style: S.sysVal }, sys.python || "")),
        h("span", { style: S.spacer }),
        h("span", { style: S.sysBarItem }, h("span", { style: S.sysLabel }, "刷新 "),
          h("select", { style: S.select, value: String(intervalMs), onChange: function (e) { setIntervalMs(parseInt(e.target.value, 10)); } },
            h("option", { value: "1000" }, "1s"),
            h("option", { value: "2000" }, "2s"),
            h("option", { value: "5000" }, "5s"),
            h("option", { value: "10000" }, "10s"),
            h("option", { value: "0" }, "暂停"))),
        h("span", { style: { color: C.muted, fontSize: 11 } }, "v" + VERSION)),
      // 主体
      h("div", { style: S.body },
        err ? h("div", { style: S.errBar }, "⚠ " + err) : null,
        // 概览卡片
        h("div", { style: S.cardRow },
          cards.map(function (c) {
            return h(StatCard, { key: c.title, title: c.title, icon: c.icon, color: c.color, value: c.value, sub: c.sub, barPct: c.barPct });
          })),
        // 实时折线图
        h("div", { style: S.section },
          h("div", { style: S.sectionTitle }, "📈 CPU / 内存 实时趋势（" + (intervalMs > 0 ? Math.round(MAX_HISTORY * intervalMs / 1000) + "s 窗口" : "已暂停") + "）"),
          h("div", { style: S.chartRow },
            h(LineChart, {
              history: history,
              series: [
                { key: "cpu", color: C.green, label: "CPU" },
                { key: "mem", color: C.blue, label: "内存" },
              ]
            }))),
        // 磁盘分区
        h("div", { style: S.section },
          h("div", { style: S.sectionTitle }, "💿 磁盘分区"),
          (snap.disk || []).length === 0 ? h("div", { style: { color: C.muted, fontSize: 12 } }, "无分区数据") :
            (snap.disk || []).map(function (d) {
              return h("div", { key: d.mountpoint, style: S.row },
                h("span", { style: { flex: "0 0 250px", color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, d.mountpoint),
                h("span", { style: { flex: "0 0 90px", color: C.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, d.device || "-"),
                h("span", { style: { flex: "0 0 40px", color: C.muted, fontSize: 11 } }, d.fstype || ""),
                h("div", { style: Object.assign({}, S.rowFlex, { display: "flex", alignItems: "center", gap: 6 }) },
                  h("div", { style: Object.assign({}, S.bar, { flex: 1 }) },
                    h("div", { style: Object.assign({}, S.barFill, { width: d.percent + "%", background: pctColor(d.percent) }) })),
                  h("span", { style: { flex: "0 0 38px", textAlign: "right", color: C.text, fontSize: 11 } }, d.percent.toFixed(0) + "%")),
                h("span", { style: { flex: "0 0 150px", textAlign: "right", color: C.muted, fontSize: 11 } }, fmtBytes(d.used) + " / " + fmtBytes(d.total)));
            })),
        // 网络接口
        h("div", { style: S.section },
          h("div", { style: S.sectionTitle }, "🌐 网络接口"),
          (net.interfaces || []).map(function (itf) {
            return h("div", { key: itf.name, style: S.row },
              h("span", { style: { flex: "0 0 140px", color: C.text } }, itf.name),
              h("span", { style: { flex: "0 0 160px", color: C.muted, fontSize: 11 } }, itf.ipv4 || itf.ipv6 || "-"),
              h("span", { style: { flex: "1" } }),
              h("span", { style: { color: C.cyan, fontSize: 11, flex: "0 0 110px", textAlign: "right" } }, "↓ " + fmtRate(itf.rx_bps)),
              h("span", { style: { color: C.purple, fontSize: 11, flex: "0 0 110px", textAlign: "right" } }, "↑ " + fmtRate(itf.tx_bps)));
          })),
        // GPU
        gpus && gpus.length ? h("div", { style: S.section },
          h("div", { style: S.sectionTitle }, "🎮 GPU"),
          h("div", { style: S.gpuGrid },
            gpus.map(function (g, i) {
              return h("div", { key: i, style: Object.assign({}, S.card, { flex: "1 1 220px" }) },
                h("div", { style: S.cardTitle }, "🎮 " + g.name),
                h("div", { style: Object.assign({}, S.cardValue, { color: C.green, fontSize: 18 }) }, g.util + "%"),
                h("div", { style: S.cardSub }, "显存 " + fmtBytes(g.mem_used) + " / " + fmtBytes(g.mem_total) + (g.temp != null ? " · " + g.temp + "°C" : "")));
            }))) : null,
        // 进程榜
        h("div", { style: S.section },
          h("div", { style: Object.assign({}, S.sectionTitle, { marginBottom: 4 }) },
            "⚙️ 进程 Top 15",
            h("span", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h("button", { style: sortKey === "cpu" ? S.tabBtnOn : S.tabBtn, onClick: function () { setSortKey("cpu"); } }, "按 CPU"),
              h("button", { style: sortKey === "mem" ? S.tabBtnOn : S.tabBtn, onClick: function () { setSortKey("mem"); } }, "按内存"))),
          h("table", { style: { width: "100%", borderCollapse: "collapse" } },
            h("thead", null, h("tr", null,
              h("th", { style: S.th }, "#"),
              h("th", { style: S.th }, "名称"),
              h("th", { style: S.th }, "PID"),
              h("th", { style: S.th }, "用户"),
              h("th", { style: S.th }, "状态"),
              h("th", { style: S.th, onClick: function () { setSortKey("cpu"); } }, "CPU %"),
              h("th", { style: S.th, onClick: function () { setSortKey("mem"); } }, "内存 %"),
              h("th", { style: S.th }, "RSS"))),
            h("tbody", null, procs.map(function (p, i) {
              return h("tr", { key: p.pid },
                h("td", { style: Object.assign({}, S.td, { color: C.muted }) }, String(i + 1)),
                h("td", { style: Object.assign({}, S.td, { color: C.text }) }, p.name),
                h("td", { style: Object.assign({}, S.td, { color: C.muted }) }, String(p.pid)),
                h("td", { style: Object.assign({}, S.td, { color: C.muted }) }, p.username),
                h("td", { style: Object.assign({}, S.td, { color: C.muted }) }, p.status),
                h("td", { style: Object.assign({}, S.td, { color: pctColor(p.cpu), fontWeight: 600 }) }, p.cpu.toFixed(1)),
                h("td", { style: Object.assign({}, S.td, { color: pctColor(p.mem), fontWeight: 600 }) }, p.mem.toFixed(1)),
                h("td", { style: Object.assign({}, S.td, { color: C.muted }) }, fmtBytes(p.rss)));
            })))),
        h("div", { style: { color: C.muted, fontSize: 11, textAlign: "center", padding: "4px 0 8px" } },
          "数据经插件后端 psutil 采集 · 只读监控 · 每秒自动刷新")));
  }

  // ---------- 注册（只注册应用中心入口，不注册侧边栏菜单） ----------
  if (QP.registerRoutes) {
    try { QP.registerRoutes(PLUGIN_ID, [{ path: "/apps/" + PLUGIN_ID, component: App, label: PLUGIN_NAME, icon: "📊" }]); } catch (e) { console.error(e); }
  }
  // 注意：不再注册 QP.menu.add —— 用户反馈侧边栏"资源监控"菜单无用，去掉
  if (QP.route && QP.route.add) {
    try { QP.route.add(PLUGIN_ID, [{ id: PLUGIN_ID, path: "/plugin/" + PLUGIN_ID, component: App }]); } catch (e) { console.error(e); }
  }
})();
