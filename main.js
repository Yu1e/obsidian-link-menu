'use strict';

/*
 * Yule Link Menu — собственное контекстное меню для ссылок.
 * Работает в Live Preview и в режиме исходного кода.
 * Shift + правый щелчок — родное меню Obsidian.
 *
 * Этап 1 (каркас): распознавание всех типов ссылок, меню с подменю,
 * настройки размещения пунктов, базовые действия.
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Menu, Notice, MarkdownView } = obsidian;

/* ------------------------------------------------------------------ */
/*  Знаки типов (как в таблице отбора)                                 */
/* ------------------------------------------------------------------ */

const T = {
  WIKI: '[[',
  HTTP: 'http',
  A: '<a',
  FILE: 'file:/',
  EWIKI: '![[',
  EHTTP: '!http',
  EFILE: '![](file:/',
  IFRAME: '<iframe',
  SUB: '#',
  NEW: '[[нов'
};

/* ------------------------------------------------------------------ */
/*  Разбор ссылок в строке                                             */
/* ------------------------------------------------------------------ */

function isEscaped(s, i) {
  let n = 0;
  for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

function parseWiki(line) {
  const out = [];
  const re = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
  let m;
  while ((m = re.exec(line))) {
    if (isEscaped(line, m.index)) continue;
    const embed = m[1] === '!';
    const innerFrom = m.index + m[1].length + 2;
    const inner = m[2];
    const pipe = inner.indexOf('|');
    let destLen = pipe < 0 ? inner.length : pipe;
    let escapedPipe = false;
    if (pipe > 0 && inner[pipe - 1] === '\\') {
      escapedPipe = true;
      destLen = pipe - 1;
    }
    const dest = inner.slice(0, destLen);
    const hash = dest.indexOf('#');
    out.push({
      kind: 'wiki',
      embed: embed,
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      dest: dest,
      destFrom: innerFrom,
      destTo: innerFrom + destLen,
      text: pipe < 0 ? null : inner.slice(pipe + 1),
      textFrom: pipe < 0 ? null : innerFrom + pipe + 1,
      textTo: pipe < 0 ? null : innerFrom + inner.length,
      insertTextAt: innerFrom + inner.length,
      escapedPipe: escapedPipe,
      linkpath: hash < 0 ? dest : dest.slice(0, hash),
      subpath: hash < 0 ? '' : dest.slice(hash),
      destType: 'vault'
    });
  }
  return out;
}

function parseMd(line) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '[' || isEscaped(line, i)) continue;
    if (line[i + 1] === '[' || line[i - 1] === '[') continue;

    // закрывающая ] с учётом вложенных скобок
    let depth = 0;
    let j = i;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') { j++; continue; }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) break; }
    }
    if (j >= line.length || line[j + 1] !== '(') continue;

    // адрес
    let k = j + 2;
    let destFrom, destTo;
    let angle = false;
    if (line[k] === '<') {
      const e = line.indexOf('>', k + 1);
      if (e < 0) continue;
      angle = true;
      destFrom = k + 1;
      destTo = e;
      k = e + 1;
    } else {
      let pd = 0;
      destFrom = k;
      for (; k < line.length; k++) {
        const c = line[k];
        if (c === '\\') { k++; continue; }
        if (c === '(') pd++;
        else if (c === ')') { if (pd === 0) break; pd--; }
        else if (c === ' ') break;
      }
      destTo = k;
    }

    // необязательный title в кавычках
    while (line[k] === ' ') k++;
    if (line[k] === '"' || line[k] === "'") {
      const q = line[k];
      const e = line.indexOf(q, k + 1);
      if (e < 0) continue;
      k = e + 1;
      while (line[k] === ' ') k++;
    }
    if (line[k] !== ')') continue;

    const embed = i > 0 && line[i - 1] === '!' && !isEscaped(line, i - 1);
    const from = embed ? i - 1 : i;
    const to = k + 1;
    out.push({
      kind: 'md',
      embed: embed,
      from: from,
      to: to,
      raw: line.slice(from, to),
      dest: line.slice(destFrom, destTo),
      destFrom: destFrom,
      destTo: destTo,
      angle: angle,
      text: line.slice(i + 1, j),
      textFrom: i + 1,
      textTo: j
    });
    i = k;
  }
  return out;
}

function parseHtmlA(line) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])([^"']*)\1[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0];
    const q = m[1] + m[2] + m[1];
    const qi = raw.indexOf(q);
    const destFrom = m.index + qi + 1;
    const openEnd = m.index + raw.indexOf('>', qi + q.length) + 1;
    out.push({
      kind: 'html',
      embed: false,
      from: m.index,
      to: m.index + raw.length,
      raw: raw,
      dest: m[2],
      destFrom: destFrom,
      destTo: destFrom + m[2].length,
      text: m[3],
      textFrom: openEnd,
      textTo: openEnd + m[3].length
    });
  }
  return out;
}

function parseIframe(line) {
  const out = [];
  const re = /<iframe\b[^>]*?\bsrc\s*=\s*(["'])([^"']*)\1[^>]*>(?:[\s\S]*?<\/iframe\s*>)?/gi;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0];
    const q = m[1] + m[2] + m[1];
    const destFrom = m.index + raw.indexOf(q) + 1;
    out.push({
      kind: 'iframe',
      embed: true,
      from: m.index,
      to: m.index + raw.length,
      raw: raw,
      dest: m[2],
      destFrom: destFrom,
      destTo: destFrom + m[2].length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function parseAuto(line) {
  const out = [];
  const re = /<((?:https?|file):\/\/[^\s<>]+)>/gi;
  let m;
  while ((m = re.exec(line))) {
    out.push({
      kind: 'auto',
      embed: false,
      from: m.index,
      to: m.index + m[0].length,
      raw: m[0],
      dest: m[1],
      destFrom: m.index + 1,
      destTo: m.index + 1 + m[1].length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function trimUrlTail(u) {
  let s = u;
  for (;;) {
    const last = s[s.length - 1];
    if ('.,;:!?»"\'”’'.indexOf(last) >= 0) { s = s.slice(0, -1); continue; }
    if (last === ')') {
      const open = (s.match(/\(/g) || []).length;
      const close = (s.match(/\)/g) || []).length;
      if (close > open) { s = s.slice(0, -1); continue; }
    }
    break;
  }
  return s;
}

function parseBare(line) {
  const out = [];
  const re = /(?:https?:\/\/|file:\/\/\/?)[^\s<>"'`\[\]]+/gi;
  let m;
  while ((m = re.exec(line))) {
    const url = trimUrlTail(m[0]);
    if (!url) continue;
    out.push({
      kind: 'bare',
      embed: false,
      from: m.index,
      to: m.index + url.length,
      raw: url,
      dest: url,
      destFrom: m.index,
      destTo: m.index + url.length,
      text: null,
      textFrom: null,
      textTo: null
    });
  }
  return out;
}

function findLinks(line) {
  const spans = [];
  const push = function (l) {
    for (const s of spans) if (l.from < s.to && s.from < l.to) return;
    spans.push(l);
  };
  parseWiki(line).forEach(push);
  parseMd(line).forEach(push);
  parseHtmlA(line).forEach(push);
  parseIframe(line).forEach(push);
  parseAuto(line).forEach(push);
  parseBare(line).forEach(push);
  return spans;
}

function classifyDest(dest) {
  const d = (dest || '').trim();
  if (/^https?:/i.test(d)) return 'http';
  if (/^file:/i.test(d)) return 'file';
  if (/^[a-z][a-z0-9+.\-]*:/i.test(d)) return 'url';
  return 'vault';
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/* Дополняет ссылку сведениями о цели и знаками типов */
function enrichLink(app, l, sourcePath) {
  if (l.kind !== 'wiki') l.destType = classifyDest(l.dest);

  if (l.kind === 'md' && l.destType === 'vault') {
    const h = l.dest.indexOf('#');
    l.linkpath = safeDecode(h < 0 ? l.dest : l.dest.slice(0, h));
    l.subpath = h < 0 ? '' : safeDecode(l.dest.slice(h));
  }

  if (l.destType === 'vault') {
    if (l.linkpath) {
      l.file = app.metadataCache.getFirstLinkpathDest(l.linkpath, sourcePath);
    } else {
      l.file = app.vault.getAbstractFileByPath(sourcePath);
    }
    l.unresolved = !l.file;
  }

  const t = new Set();
  if (l.destType === 'vault' && (l.kind === 'wiki' || l.kind === 'md')) {
    t.add(l.embed ? T.EWIKI : T.WIKI);
    if (l.subpath) t.add(T.SUB);
    if (l.unresolved) t.add(T.NEW);
  } else if (l.kind === 'html') {
    t.add(T.A);
  } else if (l.kind === 'iframe') {
    t.add(T.IFRAME);
  } else if (l.destType === 'file') {
    t.add(l.embed ? T.EFILE : T.FILE);
  } else {
    t.add(l.embed ? T.EHTTP : T.HTTP);
  }
  l.tags = t;
  return l;
}

/* ------------------------------------------------------------------ */
/*  Пути, адреса, буфер обмена                                         */
/* ------------------------------------------------------------------ */

function fileUrlToPath(u) {
  let s = (u || '').trim().replace(/^<|>$/g, '');
  const unc = /^file:\/\/[^\/]/i.test(s);
  s = s.replace(/^file:\/\/\/?/i, '');
  s = safeDecode(s);
  s = s.replace(/\//g, '\\');
  if (unc) s = '\\\\' + s;
  return s;
}

function destForCopy(l) {
  if (l.kind === 'wiki') return l.dest;
  return (l.dest || '').replace(/^<|>$/g, '');
}

function copyText(s, msg) {
  navigator.clipboard.writeText(s).then(
    function () { new Notice(msg || 'Скопировано'); },
    function () { new Notice('Не удалось скопировать в буфер'); }
  );
}

function electronShell() {
  try { return require('electron').shell; } catch (e) { return null; }
}

function vaultFullPath(app, file) {
  const ad = app.vault.adapter;
  return ad && typeof ad.getFullPath === 'function' ? ad.getFullPath(file.path) : null;
}

/* ------------------------------------------------------------------ */
/*  Текст ссылки: имя, заголовок, блок, чистка мусора (п. 30)          */
/* ------------------------------------------------------------------ */

function stripMarkup(s) {
  return s
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, function (m0, p) { const h = p.split('#'); return h[h.length - 1] || h[0]; })
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/==(.+?)==/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(^|\s)#[^\s#]+(?=\s*$)/g, '$1');
}

function cleanText(str, opt, isHeading) {
  const orig = str;
  let s = str;
  if (isHeading && opt.markup) s = stripMarkup(s);
  if (!isHeading) {
    if (opt.idPrefix) {
      s = s.replace(/^(?:\d{8,14}|\d{4}-\d{2}-\d{2}(?:[ T_]\d{2}[-:.]?\d{2}(?:[-:.]?\d{2})?)?)[\s_\-–—.]+/, '');
    }
    if (opt.orderPrefix) s = s.replace(/^\d{1,3}(?:[.)]\s*|\s*[-–—]\s*|\s+)/, '');
    if (opt.kebab && s.indexOf(' ') < 0 && s.indexOf('-') > 0) s = s.replace(/-+/g, ' ');
    if (opt.dupSuffix) s = s.replace(/\s*(?:\(\d+\)|[-–—]?\s*(?:copy|копия)(?:\s*\d+)?)$/i, '');
  }
  if (opt.emoji) s = s.replace(/^(?:\p{Extended_Pictographic}|\uFE0F|\u200D|\p{Emoji_Modifier}|\s)+/u, '');
  if (opt.underscores) s = s.replace(/_+/g, ' ');
  if (opt.edges) s = s.replace(/\s{2,}/g, ' ').replace(/^[\s.,;:–—-]+|[\s.,;:–—-]+$/g, '');
  s = s.replace(/[|\[\]]/g, '').trim();
  return s || orig.trim();
}

function nameOf(link, opt) {
  if (link.file) {
    if (link.file.extension === 'md' || opt.attachmentExt) return link.file.basename;
    return link.file.name;
  }
  const p = link.linkpath || '';
  let n = p.slice(p.lastIndexOf('/') + 1);
  if (/\.md$/i.test(n)) n = n.slice(0, -3);
  else if (opt.attachmentExt) n = n.replace(/\.[a-z0-9]{1,5}$/i, '');
  return n;
}

function headingOf(app, link) {
  const sp = link.subpath || '';
  if (!sp || sp.indexOf('#^') === 0) return null;
  if (link.file && typeof obsidian.resolveSubpath === 'function') {
    const cache = app.metadataCache.getFileCache(link.file);
    if (cache) {
      const r = obsidian.resolveSubpath(cache, sp);
      if (r && r.type === 'heading' && r.current) return r.current.heading;
    }
  }
  const parts = sp.split('#').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

async function blockTextOf(app, link, max) {
  const sp = link.subpath || '';
  if (sp.indexOf('#^') !== 0 || !link.file || typeof obsidian.resolveSubpath !== 'function') return null;
  const cache = app.metadataCache.getFileCache(link.file);
  const r = cache && obsidian.resolveSubpath(cache, sp);
  if (!r || r.type !== 'block' || !r.block) return null;
  const content = await app.vault.cachedRead(link.file);
  const p = r.block.position;
  let t = content.slice(p.start.offset, p.end.offset).split('\n')[0];
  t = t.replace(/\s*\^[\w-]+\s*$/, '');
  t = t.replace(/^\s*(?:[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+|>\s*|#{1,6}\s+)/, '');
  t = stripMarkup(t).trim();
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return t || null;
}

async function autoTextOf(plugin, link) {
  const st = plugin.settings;
  const opt = st.clean;
  const sp = link.subpath || '';
  if (sp.indexOf('#^') === 0) {
    if (st.blockMode === 'text') {
      const bt = await blockTextOf(plugin.app, link, st.blockTextLength);
      if (bt) return cleanText(bt, opt, true);
    }
    return cleanText(nameOf(link, opt), opt, false);
  }
  if (sp) {
    const h = headingOf(plugin.app, link);
    if (h) return cleanText(h, opt, true);
  }
  return cleanText(nameOf(link, opt), opt, false);
}

function aliasesOf(app, link) {
  if (!link.file || link.file.extension !== 'md') return [];
  const cache = app.metadataCache.getFileCache(link.file);
  const fm = cache && cache.frontmatter;
  if (!fm) return [];
  if (typeof obsidian.parseFrontMatterAliases === 'function') {
    return obsidian.parseFrontMatterAliases(fm) || [];
  }
  const a = fm.aliases || fm.alias;
  return Array.isArray(a) ? a.map(String) : (a ? [String(a)] : []);
}

/* ------------------------------------------------------------------ */
/*  Правка текста в редакторе                                          */
/* ------------------------------------------------------------------ */

function P(ctx, ch) { return { line: ctx.line, ch: ch }; }

function verify(ctx) {
  const cur = ctx.editor.getLine(ctx.line);
  if (cur.slice(ctx.link.from, ctx.link.to) !== ctx.link.raw) {
    new Notice('Строка изменилась — щёлкни по ссылке ещё раз');
    return false;
  }
  return true;
}

function replaceSpan(ctx, from, to, text) {
  ctx.editor.replaceRange(text, P(ctx, from), P(ctx, to));
}

function isTableLine(s) { return /^\s*\|/.test(s); }

function setWikiText(ctx, newText) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  const t = (newText || '').replace(/[|\[\]]/g, '').trim();
  if (!t) return;
  if (l.text == null) {
    const bar = (l.escapedPipe || isTableLine(ctx.editor.getLine(ctx.line))) ? '\\|' : '|';
    replaceSpan(ctx, l.insertTextAt, l.insertTextAt, bar + t);
  } else {
    replaceSpan(ctx, l.textFrom, l.textTo, t);
  }
  ctx.editor.focus();
}

function removeWikiText(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  if (l.text == null) return;
  replaceSpan(ctx, l.destTo, l.textTo, '');
  ctx.editor.focus();
}

/* ------------------------------------------------------------------ */
/*  Действия                                                           */
/* ------------------------------------------------------------------ */

function isVault(l) { return l.destType === 'vault' && (l.kind === 'wiki' || l.kind === 'md'); }
function isFileUrl(l) { return l.destType === 'file'; }
function isExternal(l) { return l.destType === 'http' || l.destType === 'url'; }

function openLink(ctx, pane) {
  const l = ctx.link;
  const app = ctx.plugin.app;
  if (isVault(l)) {
    const linktext = l.kind === 'wiki' ? l.dest : (l.linkpath + l.subpath);
    app.workspace.openLinkText(linktext, ctx.sourcePath, pane);
    return;
  }
  if (isFileUrl(l)) {
    const sh = electronShell();
    if (sh) sh.openPath(fileUrlToPath(l.dest)).then(function (err) { if (err) new Notice(err); });
    return;
  }
  window.open(destForCopy(l));
}

function openDefault(ctx) {
  const l = ctx.link;
  const sh = electronShell();
  if (!sh) return;
  const p = isFileUrl(l) ? fileUrlToPath(l.dest) : vaultFullPath(ctx.plugin.app, l.file);
  if (p) sh.openPath(p).then(function (err) { if (err) new Notice(err); });
}

function showInFolder(ctx) {
  const l = ctx.link;
  const sh = electronShell();
  if (!sh) return;
  const p = isFileUrl(l) ? fileUrlToPath(l.dest) : vaultFullPath(ctx.plugin.app, l.file);
  if (p) sh.showItemInFolder(p);
}

function deleteLink(ctx) {
  if (!verify(ctx)) return;
  const line = ctx.editor.getLine(ctx.line);
  let from = ctx.link.from;
  let to = ctx.link.to;
  if (line[from - 1] === ' ' && line[to] === ' ') to++;
  replaceSpan(ctx, from, to, '');
  ctx.editor.focus();
}

function cutLink(ctx) {
  if (!verify(ctx)) return;
  navigator.clipboard.writeText(ctx.link.raw).then(function () {
    deleteLink(ctx);
    new Notice('Ссылка вырезана');
  });
}

function editText(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  if (l.kind === 'wiki' && l.text == null) {
    autoTextOf(ctx.plugin, l).then(function (t) {
      if (!verify(ctx)) return;
      const bar = (l.escapedPipe || isTableLine(ctx.editor.getLine(ctx.line))) ? '\\|' : '|';
      replaceSpan(ctx, l.insertTextAt, l.insertTextAt, bar + t);
      const s = l.insertTextAt + bar.length;
      ctx.editor.setSelection(P(ctx, s), P(ctx, s + t.length));
      ctx.editor.focus();
    });
    return;
  }
  ctx.editor.setSelection(P(ctx, l.textFrom), P(ctx, l.textTo));
  ctx.editor.focus();
}

function editDest(ctx) {
  if (!verify(ctx)) return;
  ctx.editor.setSelection(P(ctx, ctx.link.destFrom), P(ctx, ctx.link.destTo));
  ctx.editor.focus();
}

function unlink(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  let t;
  if (l.kind === 'wiki') {
    t = l.text != null ? l.text : cleanText(headingOf(ctx.plugin.app, l) || nameOf(l, ctx.plugin.settings.clean), ctx.plugin.settings.clean, !!l.subpath);
  } else if (l.kind === 'html') {
    t = l.text.replace(/<[^>]+>/g, '');
  } else {
    t = l.text || '';
  }
  replaceSpan(ctx, l.from, l.to, t);
  ctx.editor.focus();
}

function toggleEmbed(ctx) {
  if (!verify(ctx)) return;
  const l = ctx.link;
  if (l.embed) replaceSpan(ctx, l.from, l.from + 1, '');
  else replaceSpan(ctx, l.from, l.from, '!');
  ctx.editor.focus();
}

function autoText(ctx) {
  autoTextOf(ctx.plugin, ctx.link).then(function (t) { setWikiText(ctx, t); });
}

function short(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* Варианты текста для подменю «Текст ссылки» */
function textVariants(ctx) {
  const plugin = ctx.plugin;
  const l = ctx.link;
  const opt = plugin.settings.clean;
  const items = [];
  const name = cleanText(nameOf(l, opt), opt, false);
  items.push({ title: 'Имя: ' + short(name, 40), icon: 'file-text', run: function () { setWikiText(ctx, name); } });
  const h = headingOf(plugin.app, l);
  if (h) {
    const hc = cleanText(h, opt, true);
    items.push({ title: 'Заголовок: ' + short(hc, 40), icon: 'heading', run: function () { setWikiText(ctx, hc); } });
  }
  if ((l.subpath || '').indexOf('#^') === 0) {
    items.push({
      title: 'Текст блока', icon: 'text',
      run: function () {
        blockTextOf(plugin.app, l, plugin.settings.blockTextLength).then(function (bt) {
          if (bt) setWikiText(ctx, cleanText(bt, opt, true));
          else new Notice('Блок не найден');
        });
      }
    });
  }
  const full = l.dest.replace(/\.md(?=#|$)/i, '');
  if (full !== name) items.push({ title: 'Путь целиком: ' + short(full, 40), icon: 'folder', run: function () { setWikiText(ctx, full); } });
  aliasesOf(plugin.app, l).forEach(function (a) {
    items.push({ title: 'Алиас: ' + short(a, 40), icon: 'tag', run: function () { setWikiText(ctx, a); } });
  });
  if (l.text != null) items.push({ title: 'Убрать текст', icon: 'eraser', run: function () { removeWikiText(ctx); } });
  return items;
}

const GROUPS = [
  { id: 'open', title: 'Открыть', icon: 'file-text' },
  { id: 'copy', title: 'Копировать', icon: 'copy' },
  { id: 'edit', title: 'Правка', icon: 'pencil' },
  { id: 'text', title: 'Текст ссылки', icon: 'type' },
  { id: 'convert', title: 'Преобразовать', icon: 'repeat' },
  { id: 'remove', title: 'Удалить', icon: 'trash-2' },
  { id: 'file', title: 'Файл', icon: 'folder' }
];

/*
 * place: где пункт стоит по умолчанию — 'top' (на виду) или 'sub' (в подменю группы).
 * when:  к каким ссылкам пункт применим.
 * items: для пунктов, которые раскрываются в несколько строк.
 */
const ACTIONS = [
  /* Открыть */
  { id: 'open', group: 'open', place: 'top', icon: 'file-text',
    title: function (l) { return l.unresolved ? 'Создать заметку и открыть' : 'Открыть'; },
    when: function (l) { return l.kind !== 'iframe' || !!l.dest; },
    run: function (c) { openLink(c, false); } },
  { id: 'open-tab', group: 'open', place: 'top', icon: 'file-plus', title: 'Открыть в новой вкладке',
    when: isVault, run: function (c) { openLink(c, 'tab'); } },
  { id: 'open-split', group: 'open', place: 'sub', icon: 'columns', title: 'Открыть справа',
    when: isVault, run: function (c) { openLink(c, 'split'); } },
  { id: 'open-window', group: 'open', place: 'sub', icon: 'app-window', title: 'Открыть в новом окне',
    when: isVault, run: function (c) { openLink(c, 'window'); } },

  /* Копировать */
  { id: 'copy-dest', group: 'copy', place: 'top', icon: 'link', title: 'Копировать адрес',
    when: function () { return true; }, run: function (c) { copyText(destForCopy(c.link), 'Адрес скопирован'); } },
  { id: 'copy-raw', group: 'copy', place: 'sub', icon: 'copy', title: 'Копировать ссылку целиком',
    when: function () { return true; }, run: function (c) { copyText(c.link.raw, 'Ссылка скопирована'); } },
  { id: 'copy-text', group: 'copy', place: 'sub', icon: 'type', title: 'Копировать текст ссылки',
    when: function (l) { return !!l.text && !(l.kind === 'wiki' && l.embed); },
    run: function (c) { copyText(c.link.text, 'Текст скопирован'); } },
  { id: 'copy-winpath', group: 'copy', place: 'sub', icon: 'hard-drive', title: 'Копировать как путь Windows',
    when: isFileUrl, run: function (c) { copyText(fileUrlToPath(c.link.dest), 'Путь скопирован'); } },
  { id: 'cut', group: 'copy', place: 'sub', icon: 'scissors', title: 'Вырезать ссылку',
    when: function () { return true; }, run: cutLink },

  /* Правка */
  { id: 'edit-text', group: 'edit', place: 'top', icon: 'pencil',
    title: function (l) { return l.embed ? 'Редактировать подпись' : 'Редактировать текст'; },
    when: function (l) { return (l.kind === 'wiki' && !l.embed) || l.kind === 'md' || l.kind === 'html'; },
    run: editText },
  { id: 'edit-dest', group: 'edit', place: 'sub', icon: 'pencil-line', title: 'Редактировать адрес',
    when: function (l) { return l.destFrom != null; }, run: editDest },
  { id: 'auto-text', group: 'edit', place: 'top', icon: 'heading', title: 'Текст = заголовок или имя',
    when: function (l) { return l.kind === 'wiki' && !l.embed && l.text == null; }, run: autoText },

  /* Текст ссылки — варианты */
  { id: 'text-variants', group: 'text', place: 'sub', icon: 'type', title: 'Варианты текста',
    when: function (l) { return l.kind === 'wiki' && !l.embed; }, items: textVariants },

  /* Преобразовать */
  { id: 'toggle-embed', group: 'convert', place: 'sub', icon: 'image',
    title: function (l) { return l.embed ? 'Сделать обычной ссылкой (убрать !)' : 'Сделать встраиванием (добавить !)'; },
    when: function (l) { return l.kind === 'wiki' || l.kind === 'md'; }, run: toggleEmbed },

  /* Удалить */
  { id: 'unlink', group: 'remove', place: 'sub', icon: 'unlink', title: 'Убрать ссылку, оставить текст',
    when: function (l) { return !l.embed && (l.kind === 'wiki' || l.kind === 'md' || l.kind === 'html'); }, run: unlink },
  { id: 'delete', group: 'remove', place: 'top', icon: 'trash-2', title: 'Удалить ссылку',
    when: function () { return true; }, run: deleteLink },

  /* Файл */
  { id: 'open-default-app', group: 'file', place: 'sub', icon: 'monitor', title: 'Открыть в системной программе',
    when: function (l) { return (isVault(l) && !!l.file) || isFileUrl(l); }, run: openDefault },
  { id: 'show-in-folder', group: 'file', place: 'sub', icon: 'folder-open', title: 'Показать в проводнике',
    when: function (l) { return (isVault(l) && !!l.file) || isFileUrl(l); }, run: showInFolder }
];

/* ------------------------------------------------------------------ */
/*  Настройки                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  showHeader: true,
  placement: {},          // id действия -> 'top' | 'sub' | 'off'
  blockMode: 'text',      // 'text' | 'name'
  blockTextLength: 40,
  clean: {
    underscores: true,
    markup: true,
    edges: true,
    idPrefix: false,
    orderPrefix: false,
    kebab: false,
    dupSuffix: false,
    emoji: false,
    attachmentExt: false
  }
};

/* ------------------------------------------------------------------ */
/*  Плагин                                                             */
/* ------------------------------------------------------------------ */

module.exports = class YuleLinkMenu extends Plugin {
  async onload() {
    await this.loadSettings();
    this.bypass = false;
    this.handler = this.onContextMenu.bind(this);

    this.registerDomEvent(window, 'contextmenu', this.handler, true);
    this.registerEvent(this.app.workspace.on('window-open', (ww, win) => {
      this.registerDomEvent(win, 'contextmenu', this.handler, true);
    }));

    this.addSettingTab(new YuleLinkMenuSettings(this.app, this));
  }

  async loadSettings() {
    const d = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, d);
    this.settings.clean = Object.assign({}, DEFAULT_SETTINGS.clean, d.clean || {});
    this.settings.placement = Object.assign({}, d.placement || {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  placementOf(a) {
    return this.settings.placement[a.id] || a.place;
  }

  findView(el) {
    let res = null;
    this.app.workspace.iterateAllLeaves(function (leaf) {
      if (res) return;
      const v = leaf.view;
      if (v instanceof MarkdownView && v.containerEl.contains(el)) res = v;
    });
    return res;
  }

  onContextMenu(evt) {
    if (this.bypass || evt.shiftKey) return;

    let el = evt.target;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el || !el.closest) return;

    if (!el.closest('.markdown-source-view .cm-editor')) return;
    if (el.closest('.metadata-container, .markdown-embed-content, .cm-table-widget, .cm-callout, ' +
                   '.cm-inline-code, .HyperMD-codeblock, .cm-math, .math, .cm-comment, ' +
                   '.pdf-viewer-container, .pdf-toolbar')) return;

    const view = this.findView(el);
    if (!view || view.getMode() !== 'source') return;
    const cm = view.editor && view.editor.cm;
    if (!cm) return;

    let pos = null;
    let fromWidget = false;
    const widget = el.tagName === 'IMG' ? el : el.closest('.internal-embed, .image-embed, .cm-embed-block, .media-embed');
    if (widget && cm.contentDOM.contains(widget)) {
      try { pos = cm.posAtDOM(widget); fromWidget = true; } catch (e) { pos = null; }
    }
    if (pos == null) pos = cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
    if (pos == null) return;

    const lineObj = cm.state.doc.lineAt(pos);
    const off = pos - lineObj.from;
    const links = findLinks(lineObj.text);

    let link = links.find(function (l) { return l.from <= off && off < l.to; });
    if (!link) {
      const edge = links.find(function (l) { return l.to === off; });
      if (edge && (fromWidget || el.matches('[class*="link"], [class*="url"], .cm-underline, .cm-hmd-barelink'))) link = edge;
    }
    if (!link && fromWidget) link = links.find(function (l) { return l.embed && l.from >= off; });
    if (!link) return;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const sourcePath = view.file ? view.file.path : '';
    enrichLink(this.app, link, sourcePath);

    const ctx = {
      plugin: this,
      view: view,
      editor: view.editor,
      line: lineObj.number - 1,
      link: link,
      evt: evt,
      targetEl: el,
      sourcePath: sourcePath
    };
    this.showMenu(ctx);
  }

  expand(a, ctx) {
    if (a.items) return a.items(ctx);
    const l = ctx.link;
    return [{
      title: typeof a.title === 'function' ? a.title(l) : a.title,
      icon: a.icon,
      run: function () { a.run(ctx); }
    }];
  }

  addItems(menu, a, ctx) {
    this.expand(a, ctx).forEach(function (it) {
      menu.addItem(function (mi) {
        mi.setTitle(it.title).setIcon(it.icon).onClick(function () {
          try { it.run(); } catch (e) { console.error(e); new Notice('Ошибка: ' + e.message); }
        });
      });
    });
  }

  showMenu(ctx) {
    const self = this;
    const l = ctx.link;
    const menu = new Menu();

    if (this.settings.showHeader) {
      const tags = Array.from(l.tags).join(' ');
      const d = short(l.kind === 'wiki' ? l.dest : destForCopy(l), 48);
      menu.addItem(function (mi) { mi.setTitle(tags + '   ' + d).setIcon('link').setDisabled(true); });
      menu.addSeparator();
    }

    const avail = ACTIONS.filter(function (a) { return self.placementOf(a) !== 'off' && a.when(l, ctx); });

    const top = avail.filter(function (a) { return self.placementOf(a) === 'top'; });
    top.forEach(function (a) { self.addItems(menu, a, ctx); });
    if (top.length) menu.addSeparator();

    GROUPS.forEach(function (g) {
      const list = avail.filter(function (a) { return a.group === g.id && self.placementOf(a) === 'sub'; });
      if (!list.length) return;
      let flat = false;
      menu.addItem(function (mi) {
        mi.setTitle(g.title).setIcon(g.icon);
        if (typeof mi.setSubmenu === 'function') {
          const sub = mi.setSubmenu();
          list.forEach(function (a) { self.addItems(sub, a, ctx); });
        } else {
          mi.setDisabled(true);
          flat = true;
        }
      });
      if (flat) list.forEach(function (a) { self.addItems(menu, a, ctx); });
    });

    menu.addSeparator();
    menu.addItem(function (mi) {
      mi.setTitle('Показать обычное контекстное меню').setIcon('menu').onClick(function () { self.showNative(ctx); });
    });

    menu.showAtMouseEvent(ctx.evt);
  }

  showNative(ctx) {
    const self = this;
    const evt = ctx.evt;
    const doc = ctx.targetEl.ownerDocument;
    const win = doc.defaultView;
    setTimeout(function () {
      const el = doc.elementFromPoint(evt.clientX, evt.clientY) || ctx.targetEl;
      self.bypass = true;
      try {
        el.dispatchEvent(new win.MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, view: win, button: 2, buttons: 2,
          clientX: evt.clientX, clientY: evt.clientY, screenX: evt.screenX, screenY: evt.screenY
        }));
      } finally {
        self.bypass = false;
      }
    }, 50);
  }
};

/* ------------------------------------------------------------------ */
/*  Вкладка настроек                                                   */
/* ------------------------------------------------------------------ */

class YuleLinkMenuSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const el = this.containerEl;
    const p = this.plugin;
    const s = p.settings;
    el.empty();

    new Setting(el).setName('Меню').setHeading();

    new Setting(el)
      .setName('Заголовок меню')
      .setDesc('Первой строкой меню показывать распознанный тип ссылки и её адрес.')
      .addToggle(function (t) { t.setValue(s.showHeader).onChange(async function (v) { s.showHeader = v; await p.saveSettings(); }); });

    el.createEl('p', {
      text: 'Где стоит каждый пункт: наверху меню, в подменю своей группы или нигде. ' +
            'Пункты, неприменимые к ссылке, в меню не появляются.',
      cls: 'setting-item-description'
    });

    GROUPS.forEach(function (g) {
      const acts = ACTIONS.filter(function (a) { return a.group === g.id; });
      if (!acts.length) return;
      new Setting(el).setName(g.title).setHeading();
      acts.forEach(function (a) {
        const name = typeof a.title === 'function' ? a.title({}) : a.title;
        new Setting(el).setName(name).addDropdown(function (d) {
          d.addOption('top', 'Наверху').addOption('sub', 'В подменю').addOption('off', 'Скрыт');
          d.setValue(p.placementOf(a)).onChange(async function (v) {
            if (v === a.place) delete s.placement[a.id];
            else s.placement[a.id] = v;
            await p.saveSettings();
          });
        });
      });
    });

    new Setting(el).setName('Текст ссылки').setHeading();
    el.createEl('p', {
      text: 'Как собирается текст для [[ссылок]] в пунктах «Текст = заголовок или имя», «Редактировать текст» и в вариантах текста.',
      cls: 'setting-item-description'
    });

    const toggles = [
      ['underscores', 'Подчёркивания → пробелы', 'Моя_заметка → Моя заметка'],
      ['markup', 'Убирать разметку из заголовков', '**жирный**, *курсив*, `код`, ==выделение==, [[ссылки]], #теги на конце'],
      ['edges', 'Чистить края и двойные пробелы', 'Пробелы и знаки препинания в начале и в конце, повторные пробелы внутри'],
      ['idPrefix', 'Убирать ID и даты в начале имени', '202609251430 Название, 2026-09-25 Название → Название'],
      ['orderPrefix', 'Убирать порядковые номера в начале имени', '01. Название, 03 - Название → Название'],
      ['kebab', 'Дефисы → пробелы в именах без пробелов', 'moya-zametka → moya zametka. Осторожно: заденет и Санкт-Петербург'],
      ['dupSuffix', 'Убирать хвосты дубликатов', 'Название (2), Название copy, Название - копия → Название. «Название 1» не трогается: его не отличить от «Глава 1»'],
      ['emoji', 'Убирать эмодзи в начале', '📚 Книги → Книги'],
      ['attachmentExt', 'Убирать расширение у вложений', 'отчёт.pdf → отчёт']
    ];
    toggles.forEach(function (row) {
      new Setting(el).setName(row[1]).setDesc(row[2]).addToggle(function (t) {
        t.setValue(!!s.clean[row[0]]).onChange(async function (v) { s.clean[row[0]] = v; await p.saveSettings(); });
      });
    });

    new Setting(el)
      .setName('Ссылка на блок')
      .setDesc('Что ставить текстом у [[Заметка#^abc123]].')
      .addDropdown(function (d) {
        d.addOption('text', 'Начало текста блока').addOption('name', 'Имя заметки');
        d.setValue(s.blockMode).onChange(async function (v) { s.blockMode = v; await p.saveSettings(); });
      });

    new Setting(el)
      .setName('Длина текста блока')
      .setDesc('Сколько символов брать из блока.')
      .addSlider(function (sl) {
        sl.setLimits(15, 120, 5).setValue(s.blockTextLength).setDynamicTooltip()
          .onChange(async function (v) { s.blockTextLength = v; await p.saveSettings(); });
      });
  }
}

/* Для проверки разбора вне Obsidian */
module.exports._test = { findLinks: findLinks, cleanText: cleanText, stripMarkup: stripMarkup, fileUrlToPath: fileUrlToPath };
