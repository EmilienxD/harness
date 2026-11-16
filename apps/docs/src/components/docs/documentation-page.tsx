import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { getArticle, getNavigation, getOrderedSlugs } from "@/content/docs.server";
import { homeCards, siteConfig } from "@/content/site";
import { slugHref } from "./content";
import { DocumentationShell } from "./documentation-shell";
import { ArticleSection, ResourceCards } from "./article-components";
import { BrandMark } from "./icons";
import { highlightArticleCode } from "./code-highlighting.server";

export async function DocumentationPage({ slug }: { slug: string }) {
  const sourceArticle = getArticle(slug);
  if (!sourceArticle) notFound();
  const article = await highlightArticleCode(sourceArticle);
  const ordered = getOrderedSlugs();
  const index = ordered.indexOf(slug);
  const previous = index > 0 ? getArticle(ordered[index - 1]) : undefined;
  const next = index >= 0 ? getArticle(ordered[index + 1]) : undefined;
  return <DocumentationShell article={{ slug, title: article.title, group: article.group, sections: article.sections.map(({ id, title }) => ({ id, title })) }} navigation={getNavigation()} activeTab={article.tab}>
    <header className="article-header"><p className="article-eyebrow tool-group-label">{article.group}</p><h1 id={article.titleId}>{article.title}</h1>{article.platforms.length > 0 && <div className="platform-badges" aria-label="Supported platforms">{article.platforms.map(platform => <span className="platform-badge" key={platform}>{platform}</span>)}</div>}</header>
    <div className="article-body">{article.sections.map((section, index) => <ArticleSection section={section} key={section.id ?? index} />)}</div>
    {slug === "" && <ResourceCards cards={homeCards.map(card => ({ ...card, href: slugHref(card.path) }))} columns={2} />}
    <a className="edit-page" href={siteConfig.editBaseUrl + article.sourcePath} target="_blank" rel="noopener"><Pencil size={14} />Edit this page</a>
    <nav className="article-pagination" aria-label="Article pagination">{previous ? <Link href={previous.href}><ChevronLeft size={15} /><span>{previous.title}</span></Link> : <span />}{next && <Link href={next.href}><span>{next.title}</span><ChevronRight size={15} /></Link>}</nav>
    <footer className="article-footer"><Link href="/" aria-label="Harness documentation home"><BrandMark /><span>Harness <span className="footer-divider">/</span> Documentation</span></Link></footer>
  </DocumentationShell>;
}
