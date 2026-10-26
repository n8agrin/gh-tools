// Turns a rendered section back into GitHub markdown for pasting into a PR comment.
// File links on the page already point at the PR's diff or at the file at its head commit, so they carry over as-is.
const BLOCK = new Set(['DIV', 'P', 'UL', 'OL', 'LI', 'H2', 'H3', 'H4', 'H5', 'H6', 'DETAILS', 'SUMMARY', 'PRE', 'BLOCKQUOTE', 'HR', 'SECTION']);

function inline(n) {
  // A bare < in prose would read as an HTML tag on GitHub and vanish.
  if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ').replace(/</g, '\\<');
  if (n.nodeType !== 1 || n.matches('.n, button')) return '';
  const kids = () => [...n.childNodes].map(inline).join('').trim();
  switch (n.tagName) {
    case 'A': {
      if (!/^https?:/.test(n.href) || n.getAttribute('href').startsWith('#')) return kids();
      // File links show only the base name on the page; the title holds the full path (and line).
      const label = n.classList.contains('file') ? `\`${n.title || kids()}\`` : kids();
      return `[${label}](${n.href})`;
    }
    case 'CODE': return `\`${n.textContent}\``;
    case 'B': case 'STRONG': return `**${kids()}**`;
    case 'I': case 'EM': return `_${kids()}_`;
    case 'IMG': return `![${n.alt}](${n.src})`;
    case 'BR': return '\n';
    case 'KBD': return `<kbd>${n.textContent}</kbd>`;
  }
  return [...n.childNodes].map(inline).join('');
}

// Children as a list of markdown chunks: runs of inline content become one chunk, block children recurse.
function chunks(el) {
  const out = [];
  let run = '';
  const push = () => {
    const s = run.replace(/[ \t]+/g, ' ').trim();
    if (s) out.push(s);
    run = '';
  };
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && BLOCK.has(n.tagName)) push(), out.push(...block(n));
    else run += inline(n);
  }
  push();
  return out;
}

function block(n) {
  const tag = n.tagName;
  if (tag === 'UL' || tag === 'OL') {
    const items = [...n.children].filter((li) => li.tagName === 'LI').map((li, i) => {
      const marker = tag === 'OL' ? `${i + 1}.` : '-';
      // GitHub comments keep single newlines as line breaks, so a list item's parts stay on their own lines.
      return `${marker} ${chunks(li).join('\n').replace(/\n/g, `\n${' '.repeat(marker.length + 1)}`)}`;
    });
    return items.length ? [items.join('\n')] : [];
  }
  if (tag === 'PRE') return ['```\n' + n.textContent.replace(/\n$/, '') + '\n```'];
  if (/^H[2-6]$/.test(tag)) return [`${'#'.repeat(Number(tag[1]))} ${chunks(n).join(' ')}`];
  if (tag === 'SUMMARY') return [`**${chunks(n).join(' ')}**`];
  if (tag === 'BLOCKQUOTE') return [chunks(n).map((c) => c.replace(/^/gm, '> ')).join('\n>\n')];
  if (tag === 'HR') return ['---'];
  return chunks(n);
}

export const toMarkdown = (el) => chunks(el).join('\n\n');
