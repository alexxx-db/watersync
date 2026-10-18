import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderReleaseNotes } from './releaseNotes';

const html = (markdown: string) => renderToStaticMarkup(<>{renderReleaseNotes(markdown)}</>);

// The notes GitHub generated for v0.1.1, shortened.
const generated = [
  "## What's Changed",
  '* Import WaterSync by @erinaldidb in https://github.com/databricks-industry-solutions/watersync/pull/1',
  '* Bump sharp from 0.34.5 to 0.35.5 by @dependabot[bot] in https://github.com/databricks-industry-solutions/watersync/pull/3',
  '',
  '**Full Changelog**: https://github.com/databricks-industry-solutions/watersync/commits/v0.1.1',
].join('\r\n');

describe('renderReleaseNotes', () => {
  it('renders GitHub-generated notes as a heading, a list and a paragraph', () => {
    const output = html(generated);
    expect(output).toContain('<h4 class="pt-2 text-sm font-semibold text-foreground">What&#x27;s Changed</h4>');
    expect(output).toMatch(
      /<ul[^>]*><li>Import WaterSync by @erinaldidb in <a href="https:\/\/github.com\/databricks-industry-solutions\/watersync\/pull\/1"[^>]*>#1<\/a><\/li>/
    );
    expect(output).toContain('>#3</a></li></ul>');
    expect(output).toContain(
      '<p><strong>Full Changelog</strong>: <a href="https://github.com/databricks-industry-solutions/watersync/commits/v0.1.1"'
    );
    expect(output).toContain('>github.com/databricks-industry-solutions/watersync/commits/v0.1.1</a></p>');
  });

  it('renders labelled links, inline code and keeps trailing punctuation out of bare links', () => {
    const output = html('See [the docs](https://example.com/docs) and `npm ci`, or https://example.com/a.');
    expect(output).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noreferrer" class="underline underline-offset-2">the docs</a>'
    );
    expect(output).toContain('<code class="rounded bg-muted px-1 font-mono text-xs">npm ci</code>');
    expect(output).toContain('href="https://example.com/a"');
    expect(output).toMatch(/example\.com\/a<\/a>\.<\/p>$/);
  });

  it('never turns markup or non-http links into HTML', () => {
    const output = html('<img src=x onerror=alert(1)> [click](javascript:alert(1)) <script>alert(1)</script>');
    expect(output).not.toContain('<img');
    expect(output).not.toContain('<script');
    expect(output).not.toContain('href="javascript');
    expect(output).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
