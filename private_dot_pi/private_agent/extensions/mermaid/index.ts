import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseMermaid, renderMermaidASCII } from "./vendor/dist/index.js";
import { createMermaidTransformer } from "./markdown.ts";

export default function (pi: ExtensionAPI) {
	pi.registerMarkdownTransformer(createMermaidTransformer((source) => {
		const header = source.split("\n")[0].trim();
		// The ASCII engine prints HTML entities literally rather than decoding their labels.
		if (/&(?:#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/i.test(source)) {
			throw new Error("HTML entity labels are unsupported by the terminal renderer.");
		}
		if (!/^(?:(?:graph|flowchart)\s+(?:TD|TB|BT|LR|RL)|stateDiagram(?:-v2)?|sequenceDiagram|classDiagram|erDiagram|xychart(?:-beta)?(?:\s+horizontal)?)$/i.test(header)) {
			throw new Error("Unsupported Mermaid diagram type.");
		}
		if (/^(?:graph|flowchart|stateDiagram)/i.test(header)) {
			const graph = parseMermaid(source);
			if (!graph.nodes.size || graph.nodes.size > 40 || graph.edges.length > 80 ||
				[...graph.nodes.values()].some((node) => node.label.length > 80)) {
				throw new Error("Diagram exceeds the inline layout limits.");
			}
			const groups = [...graph.subgraphs];
			while (groups.length) {
				const group = groups.pop()!;
				// beautiful-mermaid 1.1.3 renders RL as LR; do not show misleading arrows.
				if (group.direction === "RL") throw new Error("Right-to-left ASCII layout is unsupported.");
				groups.push(...group.children);
			}
			if (graph.direction === "RL") throw new Error("Right-to-left ASCII layout is unsupported.");
		}
		return renderMermaidASCII(source, {
			useAscii: false, colorMode: "none", paddingX: 3, paddingY: 2, boxBorderPadding: 1,
		});
	}, visibleWidth));
}
