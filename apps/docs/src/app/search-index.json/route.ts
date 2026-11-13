import { buildSearchEntries } from "@/content/docs.server";
export const dynamic = "force-static";
export function GET() { return Response.json(buildSearchEntries()); }
