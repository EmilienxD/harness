import { createClient } from "@supabase/supabase-js";

function createSupabaseFetch(key: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    if (
      (key.startsWith("sb_secret_") || key.startsWith("sb_publishable_")) &&
      headers.get("Authorization") === `Bearer ${key}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", key);
    return fetch(input, { ...init, headers });
  };
}

function createAdmin() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SECRET_KEY"];
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
  return createClient(url, key, {
    global: { fetch: createSupabaseFetch(key) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let value: ReturnType<typeof createAdmin> | undefined;
export const supabaseAdmin = new Proxy({} as ReturnType<typeof createAdmin>, {
  get(_target, property, receiver) {
    value ??= createAdmin();
    return Reflect.get(value, property, receiver);
  },
});
