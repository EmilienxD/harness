import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", (event, ctx) => {
		if (!event.text.startsWith("/")) return { action: "continue" };

		// Native UI and extension commands dispatch before input; skills and prompts expand after it.
		const space = event.text.indexOf(" ");
		const skillName = event.text.slice(1, space === -1 ? undefined : space);
		const promptName = /^\/([^\s]+)(?:\s+[\s\S]*)?$/.exec(event.text)?.[1];
		const known = pi.getCommands().some((command) =>
			(command.source === "skill" && command.name === skillName) ||
			(command.source === "prompt" && command.name === promptName),
		);
		if (known) return { action: "continue" };

		const command = /^\/\S*/.exec(event.text)![0];
		ctx.ui.notify(`Command ${command} not found.`, "error");
		return { action: "handled" };
	});
}
