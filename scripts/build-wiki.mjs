#!/usr/bin/env node
// Rebuild the published wiki pages from the Qoder Repo Wiki output.
//
//   node scripts/build-wiki.mjs [--source DIR] [--repo-out DIR] [--wiki-out DIR]
//
// --wiki-out is the separate gollum checkout used by https://github.com/<owner>/<repo>/wiki.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function parseArgs(argv) {
  const opts = {
    source: join(ROOT, '.qoder/repowiki/zh/content'),
    repoOut: join(ROOT, 'docs/wiki'),
    wikiOut: null,
    force: false,
    help: false,
  };
  const valued = new Set(['--source', '--repo-out', '--wiki-out']);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    if (valued.has(flag)) {
      opts[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[i + 1];
      i += 1;
    } else if (flag === '--force') opts.force = true;
    else if (flag === '--help') opts.help = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('usage: node scripts/build-wiki.mjs [--source DIR] [--repo-out DIR] [--wiki-out DIR] [--force]');
  console.log('  --wiki-out DIR   also write the gollum link style used by the published repo wiki');
  console.log('  --force          write even when validation reports problems');
  process.exit(0);
}

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const slug = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
if (!slug) throw new Error(`cannot derive GitHub owner/repo from remote: ${remoteUrl}`);
const BLOB = `https://github.com/${slug}/blob/${branch}/`;

const treeFiles = new Set(
  execFileSync('git', ['-c', 'core.quotePath=false', 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
);

const SECTION_ORDER = [
  '總覽與指南', '系統架構', '核心循環引擎', '問題處理管道', 'AI 自動修復引擎',
  'CLI 命令參考', '設定指南', 'Git 平台整合', '外部整合與擴充', '部署與發布',
];

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : name.endsWith('.md') ? [p] : [];
});

// Some generated pages are truncated mid-document and then re-emitted in full; keep the last fragment.
function repair(body, label, notes) {
  if (!body.includes('<docs>')) return body;
  const lines = body.split('\n');
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^# [^\s]/.test(lines[i])) { last = i; break; }
  }
  if (last <= 0) return body;
  notes.push(`${label}: dropped ${last} truncated lines`);
  return lines.slice(last).join('\n');
}

// `cite` is a CommonMark block-level tag: content between the tags is emitted verbatim, so the
// "referenced files" list shows up as raw markdown text instead of links. Drop the wrapper.
function unwrapCite(body, label, notes) {
  const lines = body.split('\n');
  const out = [];
  let blocks = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^ {0,3}(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence || !/^<cite>\s*$/.test(lines[i])) {
      if (!fence && /^\s*<\/?cite>/.test(lines[i])) throw new Error(`${label}: unexpected cite tag at line ${i + 1}`);
      out.push(lines[i]);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !/^<\/cite>\s*$/.test(lines[j])) j += 1;
    if (j === lines.length) throw new Error(`${label}: unclosed <cite> at line ${i + 1}`);
    const inner = lines.slice(i + 1, j).map((l) => l.replace(/[ \t]+$/, ''));
    while (inner.length && inner[inner.length - 1] === '') inner.pop();
    if (inner.length > 1 && /^\*\*[^*]+\*\*$/.test(inner[0]) && /^([-*+] |\d+\. |#{1,6} |\|)/.test(inner[1])) inner.splice(1, 0, '');
    out.push(...inner);
    blocks += 1;
    i = j;
  }
  if (blocks === 0 && body.includes('<cite>')) notes.push(`${label}: <cite> present but not unwrapped`);
  return out.join('\n');
}

const sanitize = (s) => s.replace(/[\\/:*?"<>|#%&]/g, ' ').replace(/\s+/g, ' ').trim();

// gollum serves a page at /wiki/<name> with spaces turned into hyphens.
const gollumLink = (name) => name.replace(/ /g, '-');
const repoLink = (name) => `./${encodeURIComponent(`${name}.md`)}`;

function assignNames(docs, taken) {
  const groups = new Map();
  for (const d of docs) {
    if (!groups.has(d.stem)) groups.set(d.stem, []);
    groups.get(d.stem).push(d);
  }
  for (const [stem, group] of groups) {
    if (group.length !== 1) continue;
    group[0].name = sanitize(stem);
    taken.add(group[0].name);
  }
  for (const [stem, group] of [...groups].sort()) {
    if (group.length === 1) continue;
    // an index page duplicates its own folder name, so that trailing segment is redundant
    const chainOf = (d) => d.parts.filter((p, i, a) => p !== stem || i !== a.length - 1);
    for (const d of group) {
      const chain = chainOf(d);
      let chosen = null;
      for (let depth = 1; depth <= chain.length + 1 && !chosen; depth += 1) {
        const prefix = chain.slice(Math.max(0, chain.length - depth)).join(' — ');
        const candidate = sanitize(prefix ? `${prefix} — ${stem}` : stem);
        if (!taken.has(candidate)) chosen = candidate;
      }
      if (!chosen) chosen = sanitize(`${chain.join(' — ')} — ${stem} #${group.indexOf(d) + 1}`);
      d.name = chosen;
      taken.add(chosen);
    }
  }
}

function homePage(docs, link) {
  const groups = new Map();
  for (const d of docs) {
    const section = d.parts.length ? d.parts[0] : '總覽與指南';
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(d);
  }
  const rank = (s) => {
    const i = SECTION_ORDER.indexOf(s);
    return i === -1 ? 99 : i;
  };
  let out = '# Maestro Repo Wiki\n\n'
    + `> 統一調度 AI PR 審查機器人的收斂層。以下 ${docs.length} 頁由 Qoder Repo Wiki 產生，`
    + '內容對應 ' + '`' + branch + '`' + ' 分支；程式碼連結皆指向本倉庫，Mermaid 圖表由 GitHub 直接渲染。\n\n'
    + `**原始碼**：[${slug}](${BLOB.replace(`/blob/${branch}/`, '')}) ｜ `
    + `**設計文件**：[docs/DESIGN.md](${BLOB}docs/DESIGN.md) ｜ `
    + `**README**：[README.md](${BLOB}README.md)\n\n---\n\n`;
  for (const section of [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'zh'))) {
    const items = groups.get(section).sort((a, b) => {
      const ai = a.stem === section || a.parts.length === 0 ? 0 : 1;
      const bi = b.stem === section || b.parts.length === 0 ? 0 : 1;
      return ai - bi || a.parts.length - b.parts.length || a.title.localeCompare(b.title, 'zh');
    });
    out += `### ${section}\n\n`;
    for (const d of items) out += `- [${d.title}](${link(d.name)})\n`;
    out += '\n';
  }
  return `${out}---\n\n共 ${docs.length} 頁。\n`;
}

const BLOCK_TAGS = new Set([
  'cite', 'details', 'summary', 'div', 'p', 'table', 'tr', 'td', 'th', 'section', 'article', 'aside',
  'figure', 'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'header', 'footer', 'nav', 'main',
]);

function validate(name, body, problems) {
  const stripped = body.replace(/^```[\s\S]*?^```[ \t]*$/gm, '');
  const h1 = (stripped.match(/^#[ \t]/gm) || []).length;
  if (h1 !== 1) problems.push(`${name}: H1 count = ${h1}`);
  if ((stripped.match(/^```/gm) || []).length % 2) problems.push(`${name}: unclosed code fence`);
  for (const tag of ['cite', 'div', 'details', 'table']) {
    if (new RegExp(`^<${tag}>\\s*$`, 'm').test(stripped)) problems.push(`${name}: raw <${tag}> block left in output`);
  }
  if (body.includes('file://')) problems.push(`${name}: file:// link left in output`);
  for (const m of body.matchAll(/\]\(https:\/\/github\.com\/[^/)]+\/[^/)]+\/blob\/[^/)]+\/([^)#]+)(#[^)]*)?\)/g)) {
    const path = decodeURIComponent(m[1]);
    if (!treeFiles.has(path)) problems.push(`${name}: blob link target not in HEAD: ${path}`);
    const range = (m[2] || '').match(/#L(\d+)(?:-L(\d+))?/);
    if (range && treeFiles.has(path)) {
      const wanted = Number(range[2] || range[1]);
      const have = execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').length;
      if (wanted > have) problems.push(`${name}: ${path} line range L${wanted} beyond file end (${have})`);
    }
  }
}

const notes = [];
const problems = [];
if (!existsSync(opts.source)) throw new Error(`source not found: ${opts.source} (run the Qoder Repo Wiki generator first)`);

const docs = walk(opts.source).sort().map((p) => {
  const rel = relative(opts.source, p);
  const body = unwrapCite(repair(readFileSync(p, 'utf8'), rel, notes), rel, notes);
  const parts = dirname(rel).split('/').filter((s) => s && s !== '.');
  const stem = basename(p, '.md');
  return {
    rel,
    stem,
    parts,
    body,
    title: (body.match(/^#\s+(.+)$/m) || [, stem])[1].trim(),
    name: null,
  };
});

assignNames(docs, new Set(['Home']));

const converted = docs.map((d) => {
  let links = 0;
  const body = d.body.replace(/\]\(file:\/\/([^)\s]+)\)/g, (_m, p) => {
    links += 1;
    return `](${BLOB}${p.replace(/^\/+/, '')})`;
  });
  if (links === 0) notes.push(`${d.name}: no file:// links converted`);
  return { ...d, body };
});

const targets = [
  { dir: opts.repoOut, link: repoLink },
  ...(opts.wikiOut ? [{ dir: opts.wikiOut, link: gollumLink }] : []),
];

const plan = targets.map(({ dir, link }) => ({
  dir,
  files: [...converted.map((d) => [`${d.name}.md`, d.body]), ['Home.md', homePage(converted, link)]],
}));

for (const { dir, files } of plan) {
  for (const [name, body] of files) validate(`${dir}/${name}`, body, problems);
}

const branded = converted.filter((d) => /kkday/i.test(d.body)).map((d) => d.name);
if (branded.length) problems.push(`brand string found in ${branded.length} page(s): ${branded.slice(0, 5).join(', ')}`);

for (const n of notes) console.log(`note: ${n}`);
if (problems.length && !opts.force) {
  for (const p of problems) console.error(`PROBLEM: ${p}`);
  console.error(`refusing to write ${plan.length} target(s); fix the source, or pass --force`);
  process.exit(1);
}

for (const { dir, files } of plan) {
  const fresh = new Set(files.map(([name]) => name));
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !fresh.has(x))) rmSync(join(dir, f));
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of files) writeFileSync(join(dir, name), body);
}

for (const p of problems) console.error(`PROBLEM (written anyway via --force): ${p}`);
console.log(`pages: ${converted.length} -> ${plan.map((t) => t.dir).join(', ')}`);
