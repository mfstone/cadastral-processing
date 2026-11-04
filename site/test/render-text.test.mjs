/* The answer renderer, in node, with just enough DOM to build a tree. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class Node {
  constructor(tag, text = '') { this.tag = tag; this.children = []; this.text = text; this.style = {}; this.className = ''; }
  appendChild(c) { this.children.push(c); return c; }
  set textContent(v) { this.children = []; this.text = v; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
}
globalThis.document = { createElement: (t) => new Node(t), createTextNode: (t) => new Node('#text', t) };
const { renderText } = await import('../src/assistant/render-text.js');
const find = (n, tag, out = []) => { if (n.tag === tag) out.push(n); n.children.forEach((c) => find(c, tag, out)); return out; };

test('a pipe table becomes a table, with numbers right-aligned', () => {
  const host = new Node('div');
  renderText(host, 'Counts:\n\n| County | Above | Below |\n|---|---|---|\n| Madison | 388 | 175 |\n| **Gallatin** | 309 | 154 |\n\nAfter.');
  const [table] = find(host, 'table');
  assert.ok(table);
  assert.deepEqual(find(table, 'th').map((c) => c.textContent), ['County', 'Above', 'Below']);
  const tds = find(table, 'td');
  assert.deepEqual(tds.map((c) => c.textContent), ['Madison', '388', '175', 'Gallatin', '309', '154']);
  assert.equal(tds[1].style.textAlign, 'right');
  assert.equal(find(tds[3], 'strong').length, 1);
  assert.deepEqual(find(host, 'p').map((p) => p.textContent), ['Counts:', 'After.']);
});

test('a header row without its rule row stays text, as while streaming', () => {
  const host = new Node('div');
  renderText(host, '| County | Above |');
  assert.equal(find(host, 'table').length, 0);
  assert.equal(host.textContent, '| County | Above |');
});

test('markup in the model text is never parsed as HTML', () => {
  const host = new Node('div');
  renderText(host, '| a |\n|---|\n| <img src=x onerror=alert(1)> |');
  assert.equal(find(host, 'img').length, 0);
  assert.equal(find(host, 'td')[0].textContent, '<img src=x onerror=alert(1)>');
});
