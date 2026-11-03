/* render-text.js -- the model's answer as DOM, never as HTML.
   A small subset of Markdown: paragraphs, bullet and numbered lists, bold,
   inline code, and a heading line as a bold paragraph. Everything else is
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

export function renderText(host, text) {
  host.textContent = '';
  let para = [];
  let list = null, listType = null;
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    inline(p, para.join(' '));
    host.appendChild(p);
    para = [];
  };
  const flushList = () => { if (list) { host.appendChild(list); list = null; listType = null; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
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
}
