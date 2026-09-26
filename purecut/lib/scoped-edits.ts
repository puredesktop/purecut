import { parseSource } from "@diffusionstudio/jsx";

export interface ScopedEdit {
  source: string;
  props: Record<string, number | string>;
  text?: string;
}

const ranges: Record<string, [number, number]> = {
  x: [-1000000, 1000000], y: [-1000000, 1000000],
  width: [0.01, 100000], height: [0.01, 100000],
  rotation: [-360000, 360000], opacity: [0, 1], fontSize: [1, 2000],
  start: [0, 86400], end: [0, 86400],
};

export function validateScopedEdits(input: unknown): ScopedEdit[] {
  if (!Array.isArray(input) || !input.length || input.length > 100) throw Error("Provide 1-100 scoped edits.");
  const seen = new Set<string>();
  return input.map(value => {
    if (!value || typeof value !== "object" || typeof value.source !== "string") throw Error("Invalid edit target.");
    const source = parseSource(value.source);
    if (source?.file !== "index.tsx" || typeof source.locator !== "string" || seen.has(value.source))
      throw Error("Each edit must name a unique stable index.tsx element ID.");
    seen.add(value.source);
    if (value.props !== undefined && (!value.props || typeof value.props !== "object" || Array.isArray(value.props)))
      throw Error("Invalid edit properties.");
    const props: ScopedEdit['props'] = {};
    for (const [name, setting] of Object.entries(value.props ?? {})) {
      if (name === "fill") {
        if (typeof setting !== "string" || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(setting)) throw Error("Fill must be a hex colour.");
      } else {
        const range = Object.hasOwn(ranges, name) ? ranges[name] : undefined;
        if (!range || typeof setting !== "number" || !Number.isFinite(setting) || setting < range[0] || setting > range[1])
          throw Error(`Unsupported or invalid property: ${name}`);
      }
      props[name] = setting as number | string;
    }
    if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > 20000)) throw Error("Invalid text edit.");
    if (!Object.keys(props).length && value.text === undefined) throw Error("An edit must change a property or text.");
    return { source: value.source, props, ...(value.text === undefined ? {} : { text: value.text }) };
  });
}
