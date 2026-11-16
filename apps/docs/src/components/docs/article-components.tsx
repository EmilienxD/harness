import Image from "next/image";
import Link from "next/link";
import { Info, Lightbulb, TriangleAlert, Link as LinkIcon, ArrowUpRight } from "lucide-react";
import type { ContentBlock, DocSection, ResourceCard } from "./content";
import { DocIcon } from "./icons";
import { CodeBlock } from "./code-block";

export function ResourceCards({ cards, columns = 3 }: { cards: ResourceCard[]; columns?: 2 | 3 }) {
  return <div className={`resource-grid columns-${columns}`}>
    {cards.map(card => <Link className="resource-card" href={card.href} key={card.href}>
      <DocIcon name={card.icon} /><ArrowUpRight className="card-arrow" size={16} aria-hidden="true" />
      <span className="card-title">{card.title}</span>
      {card.description && <span className="card-description">{card.description}</span>}
    </Link>)}
  </div>;
}

export function SectionHeading({ id, title, titleHtml }: { id: string; title: string; titleHtml?: string }) {
  return <h2 id={id} className="section-heading"><a className="heading-anchor" href={`#${id}`} aria-label={`Link to ${title}`}><LinkIcon size={16} /></a><span dangerouslySetInnerHTML={{ __html: titleHtml ?? title }} /></h2>;
}

export function ArticleBlock({ block }: { block: ContentBlock }) {
  if (block.type === "prose") return <div className="prose" dangerouslySetInnerHTML={{ __html: block.html }} />;
  if (block.type === "callout") {
    const Icon = block.tone === "tip" ? Lightbulb : block.tone === "warning" ? TriangleAlert : Info;
    return <aside className={`callout callout-${block.tone}`}><Icon size={20} aria-hidden="true" /><div>{block.title && <strong>{block.title}</strong>}<div className="prose" dangerouslySetInnerHTML={{ __html: block.html }} /></div></aside>;
  }
  if (block.type === "code") return <CodeBlock {...block} />;
  if (block.type === "image") return <Image className="article-image" src={block.src} alt={block.alt} width={1200} height={675} />;
  return <div className="table-wrap prose" tabIndex={0} role="region" aria-label="Reference table"><table><thead><tr>{block.columns.map((column, index) => <th key={index} dangerouslySetInnerHTML={{ __html: column }} />)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} dangerouslySetInnerHTML={{ __html: cell }} />)}</tr>)}</tbody></table></div>;
}

export function ArticleSection({ section }: { section: DocSection }) {
  return <section className="article-section">{section.title && section.id && <SectionHeading id={section.id} title={section.title} titleHtml={section.titleHtml} />}{section.blocks.map((block, index) => <ArticleBlock block={block} key={index} />)}</section>;
}
