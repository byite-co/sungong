// eval/tools/report_html.mjs — 판독 결과를 사진과 나란히 보는 HTML 보고서.
// 로컬 전용. 사진을 복사하지 않고 상대경로로 참조하므로 파일이 기기 밖으로 나가지 않는다.
//
// usage:
//   node tools/report_html.mjs --run runs/<v2>.json
//   node tools/report_html.mjs --run runs/<v2>.json --compare runs/<v0>.json
//   (옵션) --photos photos/test10   기본값은 run JSON 안의 경로에서 추론
//
// 출력: results/report_<ts>.html   (results/ 는 gitignore)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const runPath = arg('--run'), cmpPath = arg('--compare'), photoDirArg = arg('--photos');
if (!runPath) {
  console.error('usage: node tools/report_html.mjs --run <run.json> [--compare <run.json>] [--photos <dir>]');
  process.exit(1);
}

const ALIAS = {
  c: 'circle', s: 'slash', t: 'triangle', q: 'question', k: 'check', u: 'unmarked',
  circle: 'circle', slash: 'slash', triangle: 'triangle', question: 'question', check: 'check', unmarked: 'unmarked',
  slash_family_unclear: 'slash_family_unclear', unclear_st: 'slash_family_unclear', unclear: 'slash_family_unclear',
  other: 'other', other_handwritten: 'other',
};
const WORKMAP = { s: 'solved', b: 'blank', p: 'partial', solved: 'solved', blank: 'blank', partial: 'partial' };
const GLYPH = {
  circle: '○', slash: '／', triangle: '△', question: '☆',
  check: '✓', unmarked: '·', slash_family_unclear: '／?', other: '?', MISSING: '—',
};
const MARKS = ['circle', 'slash', 'triangle', 'question', 'check', 'unmarked'];

const norm = (m, table) => { if (m == null) return 'MISSING'; const s = String(m).trim().toLowerCase(); return table[s] ?? s; };

const FILE_KEYS = ['file', 'filename', 'fileName', 'image', 'imagePath', 'imageFile', 'photo', 'path', 'src', 'name'];
const NUM_KEYS = ['item_no', 'itemNo', 'item_number', 'number', 'no', 'num', 'qno', 'q_no', 'questionNumber', 'question_no', 'item', 'q', 'id'];
const MARK_KEYS = ['mark', 'markLabel', 'mark_label', 'symbol', 'm'];
const WORK_KEYS = ['work', 'w'];
const CONF_KEYS = ['mark_confidence', 'markConfidence', 'mark_conf', 'conf'];
const IMG_RE = /\.(jpe?g|png|webp|heic|heif|bmp)$/i;
const pick = (o, keys) => { for (const k of keys) if (k in o && o[k] != null) return k; return null; };

function walk(node, file, out, parentKey) {
  if (Array.isArray(node)) { for (const n of node) walk(n, file, out, parentKey); return; }
  if (!node || typeof node !== 'object') return;
  let f = file;
  for (const k of FILE_KEYS) {
    const v = node[k];
    if (typeof v === 'string' && IMG_RE.test(v)) { f = v.split(/[\\/]/).pop(); break; }
  }
  const mk = pick(node, MARK_KEYS), nk = pick(node, NUM_KEYS);
  if (mk && (typeof node[mk] === 'string' || typeof node[mk] === 'number')) {
    const num = nk ? String(node[nk]).trim()
      : (parentKey != null && /^\d+$/.test(String(parentKey)) ? String(parentKey) : null);
    if (num !== null) {
      const wk = pick(node, WORK_KEYS), ck = pick(node, CONF_KEYS);
      out.push({
        file: f ?? 'UNKNOWN', num, mark: norm(node[mk], ALIAS),
        work: wk ? norm(node[wk], WORKMAP) : null,
        conf: ck ? Number(node[ck]) : null,
      });
    }
  }
  for (const [k, v] of Object.entries(node)) {
    const cf = (typeof k === 'string' && IMG_RE.test(k)) ? k.split(/[\\/]/).pop() : f;
    walk(v, cf, out, k);
  }
}

function load(p) {
  const out = [];
  walk(JSON.parse(fs.readFileSync(p, 'utf8')), null, out, null);
  const m = new Map();
  for (const it of out) { const key = it.file + ' ' + it.num; if (!m.has(key)) m.set(key, it); }
  return m;
}

const A = cmpPath ? load(cmpPath) : null;   // 비교 대상 (보통 v0)
const B = load(runPath);                    // 주 대상 (보통 v2)

let photoDir = photoDirArg;
if (!photoDir) {
  const raw = fs.readFileSync(runPath, 'utf8');
  const m = raw.match(/photos[\\/][A-Za-z0-9_.-]+/);
  photoDir = m ? m[0].replace(/\\/g, '/') : 'photos/test10';
}
const relFromResults = (f) => path.posix.join('..', photoDir.replace(/^\.?\/?/, ''), f);

const allVals = [...(A ? [...A.values()] : []), ...B.values()];
const files = [...new Set(allVals.map((x) => x.file))].sort();
const rows = [];
for (const f of files) {
  const nums = [...new Set(allVals.filter((x) => x.file === f).map((x) => x.num))]
    .sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  rows.push({
    file: f,
    items: nums.map((n) => {
      const a = A ? A.get(f + ' ' + n) : null;
      const b = B.get(f + ' ' + n);
      return { num: n, a, b, mismatch: !!(a && b && a.mark !== b.mark) };
    }),
  });
}
const nMismatch = rows.reduce((s, r) => s + r.items.filter((i) => i.mismatch).length, 0);
const nItems = rows.reduce((s, r) => s + r.items.length, 0);

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cell = (x) => x
  ? '<span class="g">' + (GLYPH[x.mark] ?? '?') + '</span><span class="n">' + esc(x.mark) + '</span>'
    + (x.conf != null && !Number.isNaN(x.conf) ? '<span class="c">' + x.conf + '</span>' : '')
  : '<span class="none">없음</span>';

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const labelA = cmpPath ? path.basename(cmpPath).replace(/\.json$/, '') : null;
const labelB = path.basename(runPath).replace(/\.json$/, '');

const body = rows.map((r) => {
  const mm = r.items.filter((i) => i.mismatch).length;
  return '<section class="page">'
    + '<h2>' + esc(r.file) + ' <small>' + r.items.length + '문항' + (mm ? ' · 불일치 ' + mm : '') + '</small></h2>'
    + '<div class="split">'
    + '<div class="imgwrap"><a href="' + esc(relFromResults(r.file)) + '" target="_blank">'
    + '<img src="' + esc(relFromResults(r.file)) + '" alt="' + esc(r.file) + '" loading="lazy"></a>'
    + '<p class="hint">클릭하면 원본 크기로 열립니다</p></div>'
    + '<div class="tblwrap"><table><thead><tr><th>번호</th>'
    + (A ? '<th>' + esc(labelA) + '</th>' : '')
    + '<th>' + esc(labelB) + '</th><th>종이의 실제</th></tr></thead><tbody>'
    + r.items.map((i) =>
      '<tr class="' + (i.mismatch ? 'mm' : '') + '" data-file="' + esc(r.file) + '" data-num="' + esc(i.num) + '">'
      + '<td class="num">' + esc(i.num) + '</td>'
      + (A ? '<td>' + cell(i.a) + '</td>' : '')
      + '<td>' + cell(i.b) + '</td>'
      + '<td><select class="truth"><option value="">—</option>'
      + MARKS.map((m) => '<option value="' + m + '">' + GLYPH[m] + ' ' + m + '</option>').join('')
      + '</select></td></tr>').join('')
    + '</tbody></table></div></div></section>';
}).join('');

const CSS = [
  ':root{--bg:#fbfaf8;--fg:#1c1b19;--mut:#6b6862;--line:#e3e0da;--card:#fff;--mm:#fff4e5;--mmb:#e8a33d;--acc:#2f6f4f}',
  '@media (prefers-color-scheme:dark){:root{--bg:#16151a;--fg:#eceaf0;--mut:#a09daa;--line:#2f2d36;--card:#1e1d24;--mm:#33280f;--mmb:#b3801f;--acc:#6fbf95}}',
  '*{box-sizing:border-box}',
  'body{background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"Segoe UI","Malgun Gothic",sans-serif;margin:0;padding:0 16px 80px}',
  'header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 0;margin-bottom:8px}',
  'h1{font-size:19px;margin:0 0 6px}',
  '.meta{color:var(--mut);font-size:13px}',
  '.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}',
  'button{font:inherit;padding:7px 13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:7px;cursor:pointer}',
  'button.primary{background:var(--acc);color:#fff;border-color:transparent}',
  '.count{color:var(--mut);font-size:13px}',
  'section.page{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}',
  'h2{font-size:15px;margin:0 0 10px;font-weight:600;word-break:break-all}',
  'h2 small{color:var(--mut);font-weight:400;margin-left:8px}',
  '.split{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}',
  '.imgwrap{flex:1 1 380px;min-width:260px}',
  '.imgwrap img{width:100%;max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}',
  '.hint{color:var(--mut);font-size:12px;margin:6px 0 0}',
  '.tblwrap{flex:1 1 340px;min-width:280px;overflow-x:auto}',
  'table{border-collapse:collapse;width:100%;font-size:14px}',
  'th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}',
  'th{color:var(--mut);font-weight:500;font-size:12px}',
  'tr.mm{background:var(--mm)}',
  'tr.mm .num{border-left:3px solid var(--mmb);padding-left:5px}',
  '.num{font-variant-numeric:tabular-nums;font-weight:600}',
  '.g{font-size:17px;margin-right:5px}',
  '.n{color:var(--mut);font-size:12px}',
  '.c{color:var(--mut);font-size:11px;margin-left:5px}',
  '.none{color:var(--mut);font-size:12px}',
  'select.truth{font:inherit;font-size:13px;padding:3px 5px;border:1px solid var(--line);border-radius:5px;background:var(--bg);color:var(--fg)}',
  'select.truth.set{border-color:var(--acc);font-weight:600}',
  'body.only-mm tr:not(.mm){display:none}',
  'body.only-mm section.page.empty{display:none}',
  '#out{position:fixed;inset:auto 0 0 0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px;max-height:38vh;overflow:auto;display:none}',
  '#out textarea{width:100%;height:150px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px}',
].join('\n');

const JS = [
  'var sels = [].slice.call(document.querySelectorAll("select.truth"));',
  'var cnt = document.getElementById("cnt");',
  'function refresh(){',
  '  var n = sels.filter(function(s){return !!s.value;}).length;',
  '  cnt.textContent = n + "개 입력됨";',
  '  sels.forEach(function(s){ s.classList.toggle("set", !!s.value); });',
  '}',
  'sels.forEach(function(s){ s.addEventListener("change", refresh); });',
  'var tgl = document.getElementById("tgl");',
  'if (tgl) tgl.addEventListener("click", function(){',
  '  document.body.classList.toggle("only-mm");',
  '  var on = document.body.classList.contains("only-mm");',
  '  tgl.textContent = on ? "전체 보기" : "불일치만 보기";',
  '  [].forEach.call(document.querySelectorAll("section.page"), function(sec){',
  '    sec.classList.toggle("empty", sec.querySelectorAll("tr.mm").length === 0);',
  '  });',
  '});',
  'document.getElementById("copy").addEventListener("click", function(){',
  '  var lines = [];',
  '  sels.forEach(function(s){',
  '    if (!s.value) return;',
  '    var tr = s.closest("tr");',
  '    lines.push(tr.getAttribute("data-file") + "," + tr.getAttribute("data-num") + "," + s.value);',
  '  });',
  '  var out = document.getElementById("out");',
  '  var ta = out.querySelector("textarea");',
  '  ta.value = lines.length ? lines.join("\\n") : "(입력된 정정이 없습니다)";',
  '  out.style.display = "block";',
  '  ta.removeAttribute("readonly"); ta.select();',
  '  try { document.execCommand("copy"); } catch (e) {}',
  '  ta.setAttribute("readonly", "readonly");',
  '});',
  'refresh();',
].join('\n');

const html = '<title>판독 보고서 ' + ts + '</title>\n<style>\n' + CSS + '\n</style>\n'
  + '<header><h1>판독 보고서</h1>'
  + '<div class="meta">' + esc(labelB) + (labelA ? ' · 비교 ' + esc(labelA) : '')
  + ' · 사진 ' + rows.length + '장 · 문항 ' + nItems + '개'
  + (A ? ' · <b>불일치 ' + nMismatch + '개</b>' : '') + '</div>'
  + '<div class="bar">'
  + (A ? '<button id="tgl">불일치만 보기</button>' : '')
  + '<button id="copy" class="primary">정정 복사</button>'
  + '<span class="count" id="cnt">0개 입력됨</span>'
  + '</div></header>\n'
  + body
  + '\n<div id="out"><textarea readonly></textarea></div>\n'
  + '<script>\n' + JS + '\n</script>\n';

fs.mkdirSync('results', { recursive: true });
const outPath = path.join('results', 'report_' + ts + '.html');
fs.writeFileSync(outPath, html);
console.log('저장: ' + outPath);
console.log('사진 ' + rows.length + '장 · 문항 ' + nItems + '개' + (A ? ' · 불일치 ' + nMismatch + '개' : ''));
console.log('사진 참조 경로 예: ' + relFromResults(rows[0] ? rows[0].file : 'X.jpg'));
console.log('(이미지가 안 뜨면 --photos photos/test10 처럼 폴더를 직접 지정하세요)');
