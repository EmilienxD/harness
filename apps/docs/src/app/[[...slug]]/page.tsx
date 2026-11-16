import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getArticle, getArticles } from "@/content/docs.server";
import { DocumentationPage } from "@/components/docs/documentation-page";

export const dynamicParams = false;
type Props = { params: Promise<{ slug?: string[] }> };
export function generateStaticParams() {
  return getArticles().map(article => ({ slug: article.slug ? article.slug.split("/") : [] }));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug?.join("/") ?? "");
  if (!article) notFound();
  return { title: article.title, description: article.description, alternates: { canonical: article.href } };
}
export default async function Page({ params }: Props) {
  const { slug } = await params;
  return <DocumentationPage slug={slug?.join("/") ?? ""} />;
}
