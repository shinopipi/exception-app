/* 例外対応アプリ
 * 取込 → ルールで自動判定 → 期間を選んで精査 → この端末のブラウザに保存
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'exception-app/v1';
  const STATUSES = ['未判定', '対応不要', '部署共有', '部署確認中', '対応済'];
  const TYPES = ['早退', '遅刻', '早出', '残業', '打刻漏れ'];
  const REF_SOURCES = { kintai: '勤怠入力', ctk: 'CTK', soutai: '早退履歴', vto: 'VTO' };
  const PAGE = 150;

  // ---------- 状態 ----------
  let db = load();
  let refSets = buildRefSets();
  let shown = PAGE;

  function emptyDb() {
    return {
      version: 1,
      settings: { thEarly: 60, thOver: 60 },
      records: {},
      refs: { kintai: [], ctk: [], soutai: [], vto: [] },
      filters: null,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyDb();
      const d = JSON.parse(raw);
      return Object.assign(emptyDb(), d, {
        settings: Object.assign(emptyDb().settings, d.settings),
        refs: Object.assign(emptyDb().refs, d.refs),
      });
    } catch (e) {
      console.warn('load failed', e);
      return emptyDb();
    }
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      } catch (e) {
        toast('保存できませんでした（容量不足の可能性）。バックアップを書き出してください。');
        console.error(e);
      }
    }, 200);
  }

  function buildRefSets() {
    const s = {};
    for (const k of Object.keys(REF_SOURCES)) s[k] = new Set(db.refs[k] || []);
    return s;
  }

  // ---------- ユーティリティ ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  const refKey = (login, date) => `${String(login).trim().toLowerCase()}|${date}`;
  const weekday = (s) => '日月火水木金土'[new Date(s + 'T00:00:00').getDay()];

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function normDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return ymd(v);
    if (typeof v === 'number') {
      // Excel シリアル値
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = String(v).trim();
    let m = s.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); // MM/DD/YYYY
    if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
    return '';
  }

  function normTime(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return `${pad(v.getHours())}:${pad(v.getMinutes())}`;
    if (typeof v === 'number') {
      const frac = v % 1;
      const mins = Math.round(frac * 1440);
      return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
    }
    const m = String(v).match(/(\d{1,2}):(\d{2})/);
    return m ? `${pad(m[1])}:${m[2]}` : '';
  }

  const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  function normType(v) {
    const s = String(v ?? '');
    if (/早退|early\s*out/i.test(s)) return '早退';
    if (/遅刻|late/i.test(s)) return '遅刻';
    if (/早出|early\s*in/i.test(s)) return '早出';
    if (/残業|超過|over/i.test(s)) return '残業';
    if (/打刻|漏れ|missed|missing/i.test(s)) return '打刻漏れ';
    return s.trim() || 'その他';
  }

  function calcDiff(r) {
    const ss = toMin(r.shiftStart), se = toMin(r.shiftEnd), pi = toMin(r.punchIn), po = toMin(r.punchOut);
    const fix = (a, b) => { let d = a - b; if (d < -720) d += 1440; if (d > 720) d -= 1440; return d; };
    switch (r.type) {
      case '早退': return se != null && po != null ? fix(se, po) : null;
      case '遅刻': return pi != null && ss != null ? fix(pi, ss) : null;
      case '早出': return ss != null && pi != null ? fix(ss, pi) : null;
      case '残業': return po != null && se != null ? fix(po, se) : null;
      default: return null;
    }
  }

  // ---------- 判定ルール ----------
  function judge(r) {
    const k = refKey(r.login, r.date);
    const hits = (srcs) => srcs.filter((s) => refSets[s].has(k)).map((s) => REF_SOURCES[s]);
    const { thEarly, thOver } = db.settings;

    switch (r.type) {
      case '早退': {
        const h = hits(['kintai', 'ctk', 'soutai', 'vto']);
        return h.length
          ? { status: '対応不要', reason: `${h.join('・')}に記録あり` }
          : { status: '部署共有', reason: '勤怠入力・CTK・早退履歴・VTOのどれにも記録なし' };
      }
      case '遅刻': {
        const h = hits(['kintai', 'ctk']);
        return h.length
          ? { status: '対応不要', reason: `${h.join('・')}に記録あり` }
          : { status: '部署共有', reason: '勤怠入力・CTKに記録なし' };
      }
      case '早出':
        if (r.diff == null) return { status: '部署共有', reason: '早出時間が不明' };
        return r.diff >= thEarly
          ? { status: '部署共有', reason: `早出${r.diff}分（${thEarly}分以上・現場確認）` }
          : { status: '対応不要', reason: `早出${r.diff}分（${thEarly}分未満）` };
      case '残業':
        if (r.diff == null) return { status: '部署共有', reason: '残業時間が不明' };
        return r.diff >= thOver
          ? { status: '部署共有', reason: `残業${r.diff}分（${thOver}分以上・現場確認）` }
          : { status: '対応不要', reason: `残業${r.diff}分（${thOver}分未満）` };
      case '打刻漏れ':
        return { status: '部署共有', reason: '打刻漏れ' };
      default:
        return { status: '部署共有', reason: `種別「${r.type}」は自動判定対象外` };
    }
  }

  // 判定を変えるときは必ずここを通す（部署共有にした日を記録するため）
  function setStatus(r, status, on = today()) {
    if (status === '部署共有' && r.status !== '部署共有') r.sharedOn = on;
    if (status !== '部署共有' && status !== '部署確認中') r.sharedOn = '';
    r.status = status;
  }

  function applyJudge(r) {
    const j = judge(r);
    r.autoStatus = j.status;
    r.autoReason = j.reason;
    if (!r.manual && !r.done) setStatus(r, j.status);
  }

  // 部署共有した翌日以降も「部署共有」のまま（部署の対応待ち）→ 自動で「部署確認中」
  function autoCarry() {
    const t = today();
    let n = 0;
    for (const r of Object.values(db.records)) {
      if (r.status !== '部署共有') continue;
      if (!r.sharedOn) r.sharedOn = t; // 旧データ：今日共有した扱い
      if (r.sharedOn < t) {
        r.status = '部署確認中';
        r.manual = true;
        r.carriedOn = t;
        r.updatedAt = Date.now();
        n++;
      }
    }
    return n;
  }

  function runAuto(silent) {
    const n = autoCarry();
    if (n) {
      save();
      if (!silent) toast(`部署共有のまま翌日以降になった ${n} 件を「部署確認中」に切り替えました`);
    }
    return n;
  }

  function rejudgeOpen() {
    let n = 0;
    for (const r of Object.values(db.records)) {
      if (r.done) continue;
      const before = r.status;
      applyJudge(r);
      if (r.status !== before) n++;
    }
    return n;
  }

  // ---------- 取込 ----------
  const COLS = {
    date: ['日付', '勤務日', '対象日', '年月日', 'date', 'work date', 'shift date'],
    login: ['ログインid', 'ログイン', 'login', 'login id', 'user id', 'alias', '社員番号', '社員id', 'employee id', 'badge'],
    name: ['氏名', '名前', 'name', 'employee name', 'associate'],
    dept: ['部署', '所属', 'department', 'dept', 'home department'],
    company: ['派遣会社', '会社', 'agency', 'vendor', 'company'],
    type: ['例外種別', '種別', '例外', '例外内容', 'exception', 'exception type', 'type'],
    shiftStart: ['シフト開始', '始業', '開始予定', 'shift start', 'scheduled start'],
    shiftEnd: ['シフト終了', '終業', '終了予定', 'shift end', 'scheduled end'],
    punchIn: ['出勤打刻', '出勤', '打刻開始', 'punch in', 'clock in', 'in'],
    punchOut: ['退勤打刻', '退勤', '打刻終了', 'punch out', 'clock out', 'out'],
    diff: ['差分', '差分(分)', '時間(分)', '分', 'minutes', 'diff'],
  };

  function findCol(headers, cands) {
    const hs = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of cands) { const i = hs.indexOf(c); if (i >= 0) return headers[i]; }
    for (const c of cands) { if (c.length < 3) continue; const i = hs.findIndex((h) => h.includes(c)); if (i >= 0) return headers[i]; }
    return null;
  }

  async function readSheet(file) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
  }

  function importExceptions(rows) {
    if (!rows.length) return '行がありません';
    const headers = Object.keys(rows[0]);
    const map = {};
    for (const [k, c] of Object.entries(COLS)) map[k] = findCol(headers, c);
    const missing = ['date', 'login', 'type'].filter((k) => !map[k]);
    if (missing.length) {
      return `必須の列が見つかりません：${missing.map((k) => ({ date: '日付', login: 'ログインID', type: '例外種別' }[k])).join('、')}\n見出し：${headers.join(' / ')}`;
    }
    let added = 0, kept = 0, skipped = 0;
    for (const row of rows) {
      const r = {
        date: normDate(row[map.date]),
        login: String(row[map.login] ?? '').trim(),
        name: map.name ? String(row[map.name] ?? '').trim() : '',
        dept: map.dept ? String(row[map.dept] ?? '').trim() : '',
        company: map.company ? String(row[map.company] ?? '').trim() : '',
        type: normType(row[map.type]),
        shiftStart: map.shiftStart ? normTime(row[map.shiftStart]) : '',
        shiftEnd: map.shiftEnd ? normTime(row[map.shiftEnd]) : '',
        punchIn: map.punchIn ? normTime(row[map.punchIn]) : '',
        punchOut: map.punchOut ? normTime(row[map.punchOut]) : '',
      };
      if (!r.date || !r.login) { skipped++; continue; }
      const d = map.diff ? Number(row[map.diff]) : NaN;
      r.diff = Number.isFinite(d) && row[map.diff] !== '' ? d : calcDiff(r);
      if (upsert(r)) added++; else kept++;
    }
    const used = Object.entries(map).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ');
    return `新規 ${added} 件 / 既存 ${kept} 件（判定・メモは保持）/ スキップ ${skipped} 件\n使った列：${used}`;
  }

  // 既存行は元データだけ更新し、判定・メモ・精査済は残す
  function upsert(r) {
    r.id = `${r.date}|${r.login.toLowerCase()}|${r.type}`;
    const ex = db.records[r.id];
    if (ex) {
      Object.assign(ex, {
        name: r.name || ex.name, dept: r.dept || ex.dept, company: r.company || ex.company,
        shiftStart: r.shiftStart || ex.shiftStart, shiftEnd: r.shiftEnd || ex.shiftEnd,
        punchIn: r.punchIn || ex.punchIn, punchOut: r.punchOut || ex.punchOut,
        diff: r.diff ?? ex.diff,
      });
      applyJudge(ex);
      return false;
    }
    Object.assign(r, { status: '未判定', memo: '', done: false, manual: false, createdAt: Date.now(), updatedAt: Date.now() });
    applyJudge(r);
    db.records[r.id] = r;
    return true;
  }

  function importRefs(src, rows) {
    if (!rows.length) return '行がありません';
    const headers = Object.keys(rows[0]);
    const dc = findCol(headers, COLS.date), lc = findCol(headers, COLS.login);
    if (!dc || !lc) return `日付・ログインIDの列が見つかりません\n見出し：${headers.join(' / ')}`;
    const set = refSets[src];
    const before = set.size;
    for (const row of rows) {
      const d = normDate(row[dc]), l = String(row[lc] ?? '').trim();
      if (d && l) set.add(refKey(l, d));
    }
    db.refs[src] = Array.from(set);
    return `${set.size - before} 件追加（合計 ${set.size} 件）`;
  }

  // ---------- サンプル ----------
  function loadSample() {
    let seed = 20261118;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const depts = ['Inbound', 'Outbound', 'ICQA', 'Pack', 'Ship'];
    const companies = ['A派遣', 'Bスタッフ', 'Cワークス'];
    const sei = ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤', '吉田', '山田', '松本', '井上', '木村'];
    const mei = ['太郎', '花子', '一郎', '美咲', '健', '由美', '翔', '彩', '大輔', '愛'];
    const people = Array.from({ length: 24 }, (_, i) => ({
      login: `sample${String(i + 1).padStart(3, '0')}`,
      name: `${pick(sei)} ${pick(mei)}`,
      dept: pick(depts),
      company: pick(companies),
      shift: rnd() < 0.6 ? ['08:00', '17:00'] : ['13:00', '22:00'],
    }));
    const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    const refAdd = (src, login, date) => refSets[src].add(refKey(login, date));
    const rows = [];
    const t = today();
    for (let back = 13; back >= 0; back--) {
      const date = addDays(t, -back);
      const n = 5 + Math.floor(rnd() * 6);
      for (let i = 0; i < n; i++) {
        const p = pick(people);
        const type = pick(['早退', '早退', '遅刻', '早出', '残業', '残業', '打刻漏れ']);
        const ss = toMin(p.shift[0]), se = toMin(p.shift[1]);
        let pi = ss - 5, po = se + 3;
        if (type === '早退') po = se - (30 + Math.floor(rnd() * 8) * 30);
        if (type === '遅刻') pi = ss + 5 + Math.floor(rnd() * 12) * 5;
        if (type === '早出') pi = ss - (15 + Math.floor(rnd() * 8) * 15);
        if (type === '残業') po = se + (10 + Math.floor(rnd() * 10) * 10);
        rows.push({
          日付: date, ログインID: p.login, 氏名: p.name, 部署: p.dept, 派遣会社: p.company, 例外種別: type,
          シフト開始: p.shift[0], シフト終了: p.shift[1],
          出勤打刻: hm(pi), 退勤打刻: type === '打刻漏れ' ? '' : hm(po),
        });
        // 照合データ：早退の6割・遅刻の5割は記録ありにする
        if (type === '早退' && rnd() < 0.6) refAdd(pick(['kintai', 'ctk', 'soutai', 'vto']), p.login, date);
        if (type === '遅刻' && rnd() < 0.5) refAdd(pick(['kintai', 'ctk']), p.login, date);
      }
    }
    for (const k of Object.keys(REF_SOURCES)) db.refs[k] = Array.from(refSets[k]);
    const msg = importExceptions(rows);
    // サンプル：例外の翌日に部署共有した想定にする（古い分は自動で部署確認中になる）
    for (const r of Object.values(db.records)) {
      if (r.login.startsWith('sample') && r.status === '部署共有') {
        const d = addDays(r.date, 1);
        r.sharedOn = d < t ? d : t;
      }
    }
    const c = autoCarry();
    save();
    return msg + (c ? `\n部署共有のまま翌日以降の ${c} 件を部署確認中に切替` : '');
  }

  // ---------- フィルタ ----------
  function setRange(kind) {
    const t = today();
    let from = '', to = '';
    if (kind === 'today') from = to = t;
    if (kind === 'yesterday') from = to = addDays(t, -1);
    if (kind === 'week') { from = addDays(t, -6); to = t; }
    if (kind === 'month') { from = t.slice(0, 8) + '01'; to = t; }
    $('#fFrom').value = from;
    $('#fTo').value = to;
    onFilter();
  }

  function getFilters() {
    return {
      from: $('#fFrom').value, to: $('#fTo').value,
      type: $('#fType').value, status: $('#fStatus').value, dept: $('#fDept').value,
      done: $('#fDone').value, text: $('#fText').value.trim().toLowerCase(),
    };
  }

  function filtered(ignoreStatus = false) {
    const f = getFilters();
    return Object.values(db.records).filter((r) => {
      if (f.from && r.date < f.from) return false;
      if (f.to && r.date > f.to) return false;
      if (f.type && r.type !== f.type) return false;
      if (!ignoreStatus && f.status && r.status !== f.status) return false;
      if (f.dept && r.dept !== f.dept) return false;
      if (f.done === 'todo' && r.done) return false;
      if (f.done === 'done' && !r.done) return false;
      if (f.text && !`${r.login} ${r.name} ${r.memo} ${r.company}`.toLowerCase().includes(f.text)) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date) || a.dept.localeCompare(b.dept) || a.login.localeCompare(b.login));
  }

  function fillSelect(sel, label, values) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}：すべて</option>` + values.map((v) => `<option>${esc(v)}</option>`).join('');
    if (values.includes(cur)) sel.value = cur;
  }

  function refreshOptions() {
    const recs = Object.values(db.records);
    const types = Array.from(new Set([...TYPES, ...recs.map((r) => r.type)]));
    fillSelect($('#fType'), '種別', types);
    fillSelect($('#fStatus'), '判定', STATUSES);
    fillSelect($('#fDept'), '部署', Array.from(new Set(recs.map((r) => r.dept).filter(Boolean))).sort());
  }

  function onFilter() {
    shown = PAGE;
    db.filters = getFilters();
    save();
    renderList();
  }

  // ---------- 描画 ----------
  function renderSummary() {
    const rows = filtered(true);
    const cnt = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    let todo = 0;
    for (const r of rows) { cnt[r.status] = (cnt[r.status] || 0) + 1; if (!r.done) todo++; }
    $('#summary').innerHTML =
      `<span class="chip" data-status="">全 <b>${rows.length}</b></span>` +
      STATUSES.filter((s) => cnt[s]).map((s) => `<span class="chip" data-status="${s}">${s}<b>${cnt[s]}</b></span>`).join('') +
      `<span class="chip" data-done="todo">未精査<b>${todo}</b></span>`;
  }

  function itemHtml(r) {
    const times = [
      r.shiftStart || r.shiftEnd ? `シフト ${r.shiftStart || '?'}–${r.shiftEnd || '?'}` : '',
      r.punchIn || r.punchOut ? `打刻 ${r.punchIn || '—'}–${r.punchOut || '—'}` : '',
      r.diff != null ? `${r.diff}分` : '',
    ].filter(Boolean).join('　');
    const opts = STATUSES.map((s) => `<option${s === r.status ? ' selected' : ''}>${s}</option>`).join('');
    const md = (s) => s ? s.slice(5).replace('-', '/') : '';
    const changed = r.status === '部署確認中' && r.carriedOn
      ? `<span class="auto">（${md(r.sharedOn)}に部署共有 → ${md(r.carriedOn)}に自動で部署確認中）</span>`
      : r.manual && r.status !== r.autoStatus ? `<span class="auto">（自動：${esc(r.autoStatus)}）</span>` : '';
    return `<div class="item s-${esc(r.status)}${r.done ? ' done' : ''}" data-id="${esc(r.id)}">
      <div class="item-head">
        <div><span class="badge">${esc(r.type)}</span><span class="who">${esc(r.name || r.login)}</span>
          <span class="meta">${esc(r.login)}</span></div>
        <div class="meta">${esc(r.date.slice(5).replace('-', '/'))}(${weekday(r.date)})　${esc(r.dept)}${r.company ? '・' + esc(r.company) : ''}</div>
      </div>
      ${times ? `<div class="times">${esc(times)}</div>` : ''}
      <div class="reason">${esc(r.autoReason || '')} ${changed}</div>
      <div class="edit">
        <select class="status">${opts}</select>
        <textarea class="memo" rows="1" placeholder="メモ（部署への共有内容・回答など）">${esc(r.memo)}</textarea>
        <label class="check"><input type="checkbox" class="done"${r.done ? ' checked' : ''}>精査済</label>
      </div>
    </div>`;
  }

  function renderList() {
    renderSummary();
    const rows = filtered();
    const list = $('#list');
    if (!Object.keys(db.records).length) {
      list.innerHTML = '<div class="empty">データがありません。「取込」タブからサンプルかファイルを読み込んでください。</div>';
      return;
    }
    if (!rows.length) { list.innerHTML = '<div class="empty">条件に合う例外はありません。</div>'; return; }
    list.innerHTML = rows.slice(0, shown).map(itemHtml).join('') +
      (rows.length > shown ? `<div class="more"><button id="btnMore">さらに表示（残り ${rows.length - shown} 件）</button></div>` : '');
  }

  function renderStats() {
    const n = Object.keys(db.records).length;
    const dates = Object.values(db.records).map((r) => r.date).sort();
    $('#dataStats').innerHTML = `<table class="stats">
      <tr><td>例外</td><td>${n} 件${n ? `（${dates[0]} 〜 ${dates[dates.length - 1]}）` : ''}</td></tr>
      ${Object.entries(REF_SOURCES).map(([k, l]) => `<tr><td>${l}</td><td>${refSets[k].size} 件</td></tr>`).join('')}
    </table>`;
  }

  function renderAll() {
    refreshOptions();
    renderList();
    renderStats();
  }

  // ---------- イベント ----------
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'review') renderList();
    if (b.dataset.tab === 'import') renderStats();
  }));

  $$('.quick button').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
  ['#fFrom', '#fTo', '#fType', '#fStatus', '#fDept', '#fDone'].forEach((s) => $(s).addEventListener('change', onFilter));
  $('#fText').addEventListener('input', onFilter);

  $('#summary').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.done) { $('#fDone').value = 'todo'; }
    else { $('#fStatus').value = c.dataset.status || ''; if (!c.dataset.status) $('#fDone').value = ''; }
    onFilter();
  });

  const list = $('#list');
  const recOf = (el) => db.records[el.closest('.item')?.dataset.id];
  list.addEventListener('change', (e) => {
    const r = recOf(e.target);
    if (!r) return;
    if (e.target.classList.contains('status')) {
      setStatus(r, e.target.value);
      r.manual = r.status !== r.autoStatus;
    } else if (e.target.classList.contains('done')) {
      r.done = e.target.checked;
    } else return;
    r.updatedAt = Date.now();
    save();
    const el = e.target.closest('.item');
    el.outerHTML = itemHtml(r);
    renderSummary();
  });
  list.addEventListener('input', (e) => {
    if (!e.target.classList.contains('memo')) return;
    const r = recOf(e.target);
    if (!r) return;
    r.memo = e.target.value;
    r.updatedAt = Date.now();
    save();
  });
  list.addEventListener('click', (e) => {
    if (e.target.id === 'btnMore') { shown += PAGE; renderList(); }
  });

  $('#btnDoneAll').addEventListener('click', () => {
    const targets = filtered().filter((r) => !r.done);
    if (!targets.length) { toast('未精査の行はありません'); return; }
    if (!confirm(`表示中の ${targets.length} 件を精査済にします。よろしいですか？`)) return;
    for (const r of targets) { r.done = true; r.updatedAt = Date.now(); }
    save(); renderList();
    toast(`${targets.length} 件を精査済にしました`);
  });

  const log = (msg) => { const l = $('#importLog'); l.textContent = msg + '\n' + l.textContent; l.classList.add('show'); };

  $('#btnSample').addEventListener('click', () => {
    const msg = loadSample();
    log('【サンプル】' + msg);
    renderAll();
    setRange('week');
    $('.tab[data-tab=review]').click();
    toast('サンプルを読み込みました');
  });

  $$('input[type=file][data-src]').forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files[0];
    if (!file) return;
    const src = inp.dataset.src;
    const label = src === 'exceptions' ? '例外リスト' : REF_SOURCES[src];
    try {
      const rows = await readSheet(file);
      let msg = src === 'exceptions' ? importExceptions(rows) : importRefs(src, rows);
      if (src !== 'exceptions') {
        const n = rejudgeOpen();
        msg += `\n未精査の例外を自動で再判定（判定が変わった行：${n} 件）`;
      }
      const c = autoCarry();
      if (c) msg += `\n部署共有のまま翌日以降の ${c} 件を部署確認中に切替`;
      save();
      log(`【${label}】${file.name}\n${msg}`);
      renderAll();
    } catch (e) {
      console.error(e);
      log(`【${label}】${file.name}\n読み込みに失敗しました：${e.message}`);
    }
    inp.value = '';
  }));

  // 設定
  $('#thEarly').value = db.settings.thEarly;
  $('#thOver').value = db.settings.thOver;
  ['thEarly', 'thOver'].forEach((k) => $('#' + k).addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    db.settings[k] = v;
    rejudgeOpen();
    save();
    toast('しきい値を変更し、未精査の行を再判定しました');
  }));

  $('#btnBackup').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `例外対応_バックアップ_${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#restoreFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.records) throw new Error('形式が違います');
      if (!confirm('今のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      db = Object.assign(emptyDb(), d);
      refSets = buildRefSets();
      save(); renderAll();
      toast('バックアップから戻しました');
    } catch (err) {
      toast('戻せませんでした：' + err.message);
    }
    e.target.value = '';
  });

  $('#btnClear').addEventListener('click', () => {
    if (!confirm('この端末に保存した例外・判定・メモ・照合データをすべて削除します。元に戻せません。よろしいですか？')) return;
    db = emptyDb();
    refSets = buildRefSets();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
    renderAll();
    toast('削除しました');
  });

  // ---------- 起動 ----------
  refreshOptions();
  if (db.filters) {
    const f = db.filters;
    $('#fFrom').value = f.from || ''; $('#fTo').value = f.to || '';
    $('#fType').value = f.type || ''; $('#fStatus').value = f.status || '';
    $('#fDept').value = f.dept || ''; $('#fDone').value = f.done || ''; $('#fText').value = f.text || '';
  } else {
    $('#fFrom').value = addDays(today(), -6);
    $('#fTo').value = today();
  }
  runAuto(false);
  renderAll();

  // 開いたまま日付が変わったときも自動で切り替える
  const tick = () => { if (runAuto(false)) renderAll(); };
  setInterval(tick, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
