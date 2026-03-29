import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './markdown.ts';

/** Helper: check that output contains a substring */
function has(output: string, fragment: string, msg?: string) {
  assert.ok(output.includes(fragment), msg ?? `Expected output to contain "${fragment}"\nGot: ${output}`);
}

/** Helper: check that output does NOT contain a substring */
function notHas(output: string, fragment: string, msg?: string) {
  assert.ok(!output.includes(fragment), msg ?? `Expected output NOT to contain "${fragment}"\nGot: ${output}`);
}

describe('renderMarkdown', () => {
  // ── Empty / null input ──

  it('returns empty string for empty input', () => {
    assert.equal(renderMarkdown(''), '');
  });

  // ── Headings ──

  describe('headings', () => {
    it('renders h1', () => {
      has(renderMarkdown('# Title'), '<h1');
      has(renderMarkdown('# Title'), 'Title</h1>');
    });

    it('renders h2-h6', () => {
      has(renderMarkdown('## Sub'), '<h2');
      has(renderMarkdown('### Sub'), '<h3');
      has(renderMarkdown('#### Sub'), '<h4');
      has(renderMarkdown('##### Sub'), '<h5');
      has(renderMarkdown('###### Sub'), '<h6');
    });

    it('does not render mid-line hashes as headings', () => {
      notHas(renderMarkdown('not a # heading'), '<h1');
    });
  });

  // ── Bold / Italic ──

  describe('inline formatting', () => {
    it('renders bold', () => {
      has(renderMarkdown('**bold**'), '<strong>bold</strong>');
    });

    it('renders italic', () => {
      has(renderMarkdown('*italic*'), '<em>italic</em>');
    });

    it('renders bold inside text', () => {
      has(renderMarkdown('some **bold** text'), '<strong>bold</strong>');
    });

    it('renders inline code', () => {
      has(renderMarkdown('use `foo()` here'), '<code>foo()</code>');
    });

    it('does not render bold across lines', () => {
      // **bold** regex is non-greedy single line
      const out = renderMarkdown('**start\nend**');
      notHas(out, '<strong>start\nend</strong>');
    });
  });

  // ── Links ──

  describe('links', () => {
    it('renders markdown links', () => {
      has(renderMarkdown('[click](http://example.com)'), '<a href="http://example.com"');
      has(renderMarkdown('[click](http://example.com)'), '>click</a>');
    });

    it('opens links in new tab', () => {
      has(renderMarkdown('[x](http://y.com)'), 'target="_blank"');
    });

    it('auto-links bare URLs', () => {
      const out = renderMarkdown('visit https://example.com for details');
      has(out, '<a href="https://example.com"');
      has(out, '>https://example.com</a>');
    });

    it('does not double-link markdown links', () => {
      const out = renderMarkdown('[click](https://example.com)');
      // Should have exactly one <a> tag, not nested
      const matches = out.match(/<a /g) || [];
      assert.equal(matches.length, 1);
    });

    it('auto-links http URLs', () => {
      has(renderMarkdown('see http://localhost:3000/test'), '<a href="http://localhost:3000/test"');
    });

    it('strips trailing punctuation from auto-linked URLs', () => {
      const out = renderMarkdown('visit https://example.com.');
      has(out, '<a href="https://example.com"');
      // Period should be outside the link
      has(out, '</a>.');
    });

    it('does not auto-link URLs inside inline code', () => {
      const out = renderMarkdown('run `https://example.com/api` to test');
      // URL should be inside <code>, not wrapped in <a>
      has(out, '<code>https://example.com/api</code>');
      // Should not contain an <a> tag
      const linkMatches = out.match(/<a /g) || [];
      assert.equal(linkMatches.length, 0);
    });

    it('auto-links URL followed by comma', () => {
      const out = renderMarkdown('see https://example.com, then continue');
      has(out, '<a href="https://example.com"');
      has(out, '</a>,');
    });
  });

  // ── Unordered lists ──

  describe('unordered lists', () => {
    it('renders a simple bullet list', () => {
      const out = renderMarkdown('- item one\n- item two\n- item three');
      has(out, '<ul>');
      has(out, '<li>item one</li>');
      has(out, '<li>item two</li>');
      has(out, '<li>item three</li>');
      has(out, '</ul>');
    });

    it('renders asterisk bullets', () => {
      const out = renderMarkdown('* foo\n* bar');
      has(out, '<ul>');
      has(out, '<li>foo</li>');
    });

    it('renders nested unordered lists', () => {
      const out = renderMarkdown('- parent\n  - child\n  - child2\n- parent2');
      // Should have nested ul
      const ulCount = (out.match(/<ul>/g) || []).length;
      assert.ok(ulCount >= 2, `expected at least 2 <ul> tags for nesting, got ${ulCount}`);
      has(out, '<li>child</li>');
    });
  });

  // ── Ordered lists ──

  describe('ordered lists', () => {
    it('renders a simple numbered list', () => {
      const out = renderMarkdown('1. first\n2. second\n3. third');
      has(out, '<ol>');
      has(out, '<li>first</li>');
      has(out, '<li>second</li>');
      has(out, '<li>third</li>');
      has(out, '</ol>');
    });

    it('renders numbered list with bold content', () => {
      const out = renderMarkdown('1. **ASSIGN** — No. Nominal types.\n2. **EXTRA** — Yes.');
      has(out, '<ol>');
      has(out, '<li><strong>ASSIGN</strong>');
      has(out, '<li><strong>EXTRA</strong>');
    });

    it('renders numbered list with em dash in content', () => {
      const out = renderMarkdown('1. TYPE — No. Ambiguous.\n2. SPREAD — Deep copy.');
      has(out, '<ol>');
      has(out, '<li>TYPE — No. Ambiguous.</li>');
    });

    it('handles non-sequential numbers', () => {
      const out = renderMarkdown('1. first\n5. fifth\n99. ninety-nine');
      has(out, '<ol>');
      has(out, '<li>first</li>');
      has(out, '<li>fifth</li>');
      has(out, '<li>ninety-nine</li>');
    });

    it('renders numbered list after a paragraph', () => {
      const out = renderMarkdown('Edge cases:\n\n1. first\n2. second');
      has(out, '<ol>');
      has(out, '<li>first</li>');
    });

    it('renders numbered list after heading', () => {
      const out = renderMarkdown('## Items\n\n1. one\n2. two');
      has(out, '<h2');
      has(out, '<ol>');
    });
  });

  // ── Mixed lists ──

  describe('mixed lists', () => {
    it('handles ul followed by ol', () => {
      const out = renderMarkdown('- bullet\n\n1. number');
      has(out, '<ul>');
      has(out, '</ul>');
      has(out, '<ol>');
      has(out, '</ol>');
    });

    it('handles ol followed by ul', () => {
      const out = renderMarkdown('1. number\n\n- bullet');
      has(out, '<ol>');
      has(out, '</ol>');
      has(out, '<ul>');
    });
  });

  // ── Code blocks ──

  describe('code blocks', () => {
    it('renders fenced code blocks', () => {
      const out = renderMarkdown('```\nconst x = 1;\n```');
      has(out, '<pre');
      has(out, '<code>const x = 1;</code>');
    });

    it('renders code blocks with language tag', () => {
      const out = renderMarkdown('```typescript\nconst x: number = 1;\n```');
      has(out, '<code>const x: number = 1;</code>');
    });

    it('preserves content inside code blocks', () => {
      const out = renderMarkdown('```\n# not a heading\n**not bold**\n- not a list\n```');
      has(out, '# not a heading');
      has(out, '**not bold**');
      has(out, '- not a list');
      notHas(out, '<h1');
      notHas(out, '<strong>');
      notHas(out, '<ul>');
    });

    it('handles multiple code blocks', () => {
      const out = renderMarkdown('```\nblock1\n```\n\ntext\n\n```\nblock2\n```');
      has(out, 'block1');
      has(out, 'block2');
      const preCount = (out.match(/<pre/g) || []).length;
      assert.equal(preCount, 2);
    });
  });

  // ── Tables ──

  describe('tables', () => {
    it('renders a basic table', () => {
      const out = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
      has(out, '<table>');
      has(out, '<th>A</th>');
      has(out, '<th>B</th>');
      has(out, '<td>1</td>');
      has(out, '<td>2</td>');
    });

    it('ends table on non-pipe line', () => {
      const out = renderMarkdown('| A |\n|---|\n| 1 |\n\nParagraph after');
      has(out, '</tbody></table>');
      has(out, 'Paragraph after');
    });
  });

  // ── Horizontal rules ──

  describe('horizontal rules', () => {
    it('renders --- as hr', () => {
      has(renderMarkdown('---'), '<hr');
    });

    it('renders longer dashes', () => {
      has(renderMarkdown('-----'), '<hr');
    });
  });

  // ── Paragraphs ──

  describe('paragraphs', () => {
    it('wraps plain text in p tags', () => {
      has(renderMarkdown('hello world'), '<p');
      has(renderMarkdown('hello world'), 'hello world');
    });

    it('separates paragraphs on blank lines', () => {
      const out = renderMarkdown('para one\n\npara two');
      const pCount = (out.match(/<p /g) || []).length;
      assert.equal(pCount, 2);
    });

    it('uses br for consecutive non-blank lines', () => {
      const out = renderMarkdown('line one\nline two');
      has(out, '<br>');
    });
  });

  // ── Edge cases from production ──

  describe('edge cases', () => {
    it('handles numbered list with periods in content (e.g. "No. Nominal types")', () => {
      const input = '1. ASSIGN ANON TO NAMED TYPE — No. Nominal types require new User(). Prevents bypassing constructor validation.';
      const out = renderMarkdown(input);
      has(out, '<ol>');
      has(out, '<li>ASSIGN ANON');
    });

    it('handles multi-paragraph then numbered list', () => {
      const input = 'Edge cases analyzed for anonymous objects:\n\n1. ASSIGN ANON TO NAMED TYPE\n2. EXTRA FIELDS\n3. TYPE MATCHING';
      const out = renderMarkdown(input);
      has(out, '<ol>');
      has(out, '<li>ASSIGN ANON TO NAMED TYPE</li>');
      has(out, '<li>EXTRA FIELDS</li>');
    });

    it('handles bold markers inside list items', () => {
      const out = renderMarkdown('- **Key**: value\n- **Other**: data');
      has(out, '<ul>');
      has(out, '<strong>Key</strong>');
    });

    it('handles inline code inside list items', () => {
      const out = renderMarkdown('1. Use `foo()` method\n2. Call `bar()`');
      has(out, '<ol>');
      has(out, '<code>foo()</code>');
    });

    it('handles empty lines between list items (should break the list)', () => {
      const out = renderMarkdown('1. first\n\n2. second');
      // Blank line between items should close and reopen the list
      has(out, '<li>first</li>');
      has(out, '<li>second</li>');
    });

    it('handles list item with link', () => {
      const out = renderMarkdown('- [link](http://example.com) description');
      has(out, '<ul>');
      has(out, '<a href="http://example.com"');
    });

    it('handles heading followed directly by list (no blank line)', () => {
      const out = renderMarkdown('## Title\n1. one\n2. two');
      has(out, '<h2');
      has(out, '<ol>');
    });

    it('handles text with collab message format', () => {
      const input = '[from: agent-a, reply with collab send agent-a]: \'hello\'';
      const out = renderMarkdown(input);
      // Should render as plain text, not break
      has(out, 'from: agent-a');
    });

    it('handles deeply nested content: heading + paragraph + list + code', () => {
      const input = '## Analysis\n\nHere are the findings:\n\n1. First point\n2. Second point\n\n```\ncode example\n```\n\nConclusion.';
      const out = renderMarkdown(input);
      has(out, '<h2');
      has(out, '<ol>');
      has(out, '<pre');
      has(out, 'Conclusion');
    });
  });
});
