import Link from "next/link";
export default function NotFound() {
  return <main className="not-found"><span className="eyebrow">404 · PAGE NOT FOUND</span><h1>Page not found</h1><p>This Harness guide may have moved. Browse the documentation to find a tool or configuration guide.</p><Link className="primary-button" href="/">Back to documentation <span aria-hidden="true">→</span></Link></main>;
}
