type ServerEntry = { fetch(request: Request, env: unknown, context: unknown): Promise<Response> | Response };

let entry: Promise<ServerEntry> | undefined;

export default {
  async fetch(request: Request, env: unknown, context: unknown) {
    try {
      entry ??= import("@tanstack/react-start/server-entry").then(
        (module) => (module.default ?? module) as ServerEntry,
      );
      return await (await entry).fetch(request, env, context);
    } catch (error) {
      console.error(error);
      return new Response("Hosted Grill-Me board failed to serve this request.", { status: 500 });
    }
  },
};
