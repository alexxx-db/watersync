import type { ReactNode } from 'react';

// Renders the Markdown subset GitHub uses for release notes (headings, bullet lists, paragraphs, bold, inline
// code, links) as React elements. Nothing is injected as HTML, so markup in the notes shows as text, and only
// http(s) URLs become links.

const inlinePattern =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** github.com pull request and issue links read better as #123, like GitHub shows them. */
const linkLabel = (url: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)$/.exec(url)?.[1];

const link = (url: string, label: ReactNode, key: number) => (
  <a key={key} href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
    {label}
  </a>
);

const inline = (text: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index;
    if (index > last) nodes.push(text.slice(last, index));
    const [, bold, code, label, labelUrl, bareUrl] = match;
    if (bold !== undefined) nodes.push(<strong key={index}>{inline(bold)}</strong>);
    else if (code !== undefined)
      nodes.push(
        <code key={index} className="rounded bg-muted px-1 font-mono text-xs">
          {code}
        </code>
      );
    else if (labelUrl !== undefined) nodes.push(link(labelUrl, label, index));
    else if (bareUrl !== undefined) {
      const number = linkLabel(bareUrl);
      nodes.push(link(bareUrl, number ? `#${number}` : bareUrl.replace(/^https?:\/\//, ''), index));
    }
    last = index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
};

export function renderReleaseNotes(markdown: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  // Each item keeps its line number in the notes as a stable React key.
  let items: { line: number; text: string }[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>);
      paragraph = [];
    }
    if (items.length) {
      blocks.push(
        <ul key={blocks.length} className="list-disc space-y-1 pl-5">
          {items.map((item) => (
            <li key={item.line}>{inline(item.text)}</li>
          ))}
        </ul>
      );
      items = [];
    }
  };
  for (const [lineNumber, raw] of markdown.split(/\r?\n/).entries()) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (heading) {
      flush();
      blocks.push(
        <h4 key={blocks.length} className="pt-2 text-sm font-semibold text-foreground">
          {inline(heading[2])}
        </h4>
      );
    } else if (item) {
      if (paragraph.length) flush();
      items.push({ line: lineNumber, text: item[1] });
    } else {
      if (items.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}
