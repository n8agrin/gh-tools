// Just enough markdown for PR descriptions and Claude's review notes. Everything is escaped first,
// so text from a PR can never inject HTML into the page.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const safeUrl = (u) => (/^https?:\/\//.test(u) ? u : '#');

export function inline(s) {
  const code = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => `<img src="${safeUrl(u)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}" target="_blank" rel="noreferrer">${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s.,;:)]|$)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(code[i])}</code>`);
}

// A table row's cells, split on pipes that aren't escaped or inside `code`.
function cells(line) {
  const out = [];
  let cur = '';
  let tick = false;
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') (cur += '|'), i++;
    else if (c === '`') (tick = !tick), (cur += c);
    else if (c === '|' && !tick) out.push(cur.trim()), (cur = '');
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line ?? '');

// Code blocks get colors when highlight.js is on the page and knows the language.
function codeBlock(lang, body) {
  const hl = globalThis.hljs;
  if (lang && hl?.getLanguage(lang)) {
    try {
      return `<pre><code class="hl">${hl.highlight(body, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
    } catch {}
  }
  return `<pre><code>${esc(body)}</code></pre>`;
}

export function markdown(src) {
  // GitHub descriptions often hold raw <img> tags for screenshots; keep them as images.
  src = String(src ?? '').replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '![screenshot]($1)')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(sub|sup|details|summary|p|div|span|b|i|em|strong|picture|source|video)\b[^>]*>/gi, '');
  const out = [];
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
    if (list) out.push(`</${list}>`), (list = null);
  };
  const lines = src.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const lang = line.trim().slice(3).trim().split(/\s/)[0].toLowerCase();
      const body = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
      out.push(codeBlock(lang, body.join('\n')));
    } else if (line.includes('|') && isSep(lines[i + 1])) {
      // A GitHub-style table: header, separator with alignment, then rows until a line without a pipe.
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      const n = Math.min(6, line.match(/^#+/)[0].length + 1);
      out.push(`<h${n}>${inline(line.replace(/^#+\s*/, ''))}</h${n}>`);
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`), (para = []);
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul';
      if (list !== tag) list && out.push(`</${list}>`), out.push(`<${tag}>`), (list = tag);
      const nested = /^\s{2,}/.test(line) ? ' class="nested"' : '';
      out.push(`<li${nested}>${inline(line.replace(/^\s*([-*+]|\d+\.)\s+(\[[ x]\]\s+)?/, ''))}</li>`);
    } else if (/^>\s?/.test(line)) {
      flush();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flush();
      out.push('<hr>');
    } else if (!line.trim()) {
      flush();
    } else if (list && /^\s+/.test(line)) {
      out[out.length - 1] = out.at(-1).replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      if (list) out.push(`</${list}>`), (list = null);
      para.push(line.trim());
    }
  }
  flush();
  return out.join('\n');
}
