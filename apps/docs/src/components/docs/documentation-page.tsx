import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { getArticle, getNavigation, getOrderedSlugs } from "@/content/docs.server";
import { homeCards, siteConfig } from "@/content/site";
import { slugHref } from "./content";
import { DocumentationShell } from "./documentation-shell";
import { ArticleSection, ResourceCards } from "./article-components";
import { BrandMark } from "./icons";
import { highlightArticleCode } from "./code-highlighting.server";

const providerLogos: Record<string, string> = {
  "Claude Code": "/providers/claude.svg",
  ChatGPT: "/providers/chatgpt.svg",
  Pi: "/providers/pi.svg",
};

export async function DocumentationPage({ slug }: { slug: string }) {
  const sourceArticle = getArticle(slug);
  if (!sourceArticle) notFound();
  const article = await highlightArticleCode(sourceArticle);
  const ordered = getOrderedSlugs();
  const index = ordered.indexOf(slug);
  const previous = index > 0 ? getArticle(ordered[index - 1]) : undefined;
  const next = index >= 0 ? getArticle(ordered[index + 1]) : undefined;
  return <DocumentationShell article={{ slug, title: article.title, group: article.group, sections: article.sections.map(({ id, title }) => ({ id, title })) }} navigation={getNavigation()} activeTab={article.tab}>
    <header className="article-header"><p className="article-eyebrow tool-group-label">{article.group}</p><h1 id={article.titleId}>{article.title}</h1>{article.platforms.length > 0 && <div className="provider-logos" role="group" aria-label="Supported providers">{article.platforms.map(platform => <span className="provider-logo" key={platform} title={platform}><Image unoptimized src={providerLogos[platform]} alt={platform} width={28} height={28} className={platform === "ChatGPT" ? "provider-logo__monochrome" : undefined} /></span>)}</div>}</header>
    <div className="article-body">{article.sections.map((section, index) => <ArticleSection section={section} key={section.id ?? index} />)}</div>
    {slug === "" && <ResourceCards cards={homeCards.map(card => ({ ...card, href: slugHref(card.path) }))} columns={2} />}
    <a className="edit-page" href={siteConfig.editBaseUrl + article.sourcePath} target="_blank" rel="noopener"><ExternalLink size={14} />Open in GitHub</a>
    <nav className="article-pagination" aria-label="Article pagination">{previous ? <Link href={previous.href}><ChevronLeft size={15} /><span>{previous.title}</span></Link> : <span />}{next && <Link href={next.href}><span>{next.title}</span><ChevronRight size={15} /></Link>}</nav>
    <footer className="article-footer"><Link href="/" aria-label="Harness documentation home"><BrandMark /><span>Harness <span className="footer-divider">/</span> Documentation</span></Link></footer>
  </DocumentationShell>;
}
