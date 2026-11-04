/* render-text.js -- the model's answer as DOM, never as HTML.
   A small subset of Markdown: paragraphs, bullet and numbered lists, bold,
   inline code, pipe tables, and a heading line as a bold paragraph. Everything else is
   literal text, which is the point: nothing the model writes is parsed as
   markup. */

function inline(el, text) {
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    const node = document.createElement(t.startsWith('**') ? 'strong' : 'code');
    node.textContent = t.startsWith('**') ? t.slice(2, -2) : t.slice(1, -1);
    el.appendChild(node);
    last = m.index + t.length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

const cells = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isRule = (line) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line);
const numeric = (c) => /^[-+]?[\d,.]+%?$/.test(c);

export function renderText(host, text) {
  host.textContent = '';
  let para = [];
  let list = null, listType = null;
  let rows = null;   // a pipe table being collected: [header, ...body]
  const flushTable = () => {
    if (!rows) return;
    const [head, ...body] = rows;
    rows = null;
    const wrap = document.createElement('div');
    wrap.className = 'tablewrap';
    const table = document.createElement('table');
    table.className = 'data';
    const tr = document.createElement('tr');
    for (const c of head) { const th = document.createElement('th'); inline(th, c); tr.appendChild(th); }
    const thead = document.createElement('thead');
    thead.appendChild(tr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const r of body) {
      const row = document.createElement('tr');
      head.forEach((_, i) => {
        const td = document.createElement('td');
        const c = r[i] ?? '';
        if (numeric(c)) td.style.textAlign = 'right';
        inline(td, c);
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  };
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    inline(p, para.join(' '));
    host.appendChild(p);
    para = [];
  };
  const flushList = () => { if (list) { host.appendChild(list); list = null; listType = null; } };
  const lines = String(text || '').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    // A table starts with a pipe row followed by a rule row, and runs while
    // the lines start with a pipe. While streaming, the header row waits for
    // its rule row as plain text, then turns into a table.
    if (rows) {
      if (line.startsWith('|')) { rows.push(cells(line)); continue; }
      flushTable();
    }
    if (line.startsWith('|') && n + 1 < lines.length && isRule(lines[n + 1].trim())) {
      flushPara(); flushList();
      rows = [cells(line)];
      n++;
      continue;
    }
    if (!line) { flushPara(); flushList(); continue; }
    const li = line.match(/^(?:[-*•]|\d{1,2}[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const type = /^\d/.test(line) ? 'ol' : 'ul';
      if (!list || listType !== type) { flushList(); list = document.createElement(type); listType = type; }
      const item = document.createElement('li');
      inline(item, li[1]);
      list.appendChild(item);
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flushPara(); flushList();
      const p = document.createElement('p');
      const b = document.createElement('strong');
      b.textContent = h[1];
      p.appendChild(b);
      host.appendChild(p);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  flushTable();
}
