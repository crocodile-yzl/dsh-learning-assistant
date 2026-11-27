// Stand-in for the platform's `@deepseek-ai/dsh-tools`, used ONLY by
// tools/selfcheck.mjs when the real package cannot be resolved (a clean CI
// runner without dsh installed). It is never shipped and never loaded by dsh.
//
// `defineTool` types and validates the tool's schemas and returns a tool
// definition whose `name` and `execute` are what the plugin registered. The
// self-check drives `execute` directly with well-formed arguments, so a
// definition that carries them through unchanged is enough.

export function defineTool(options) {
	if (options === null || typeof options !== "object") throw new TypeError("defineTool: options must be an object");
	if (typeof options.name !== "string" || options.name === "") throw new TypeError("defineTool: options.name is required");
	if (typeof options.execute !== "function") throw new TypeError(`defineTool(${options.name}): options.execute must be a function`);
	return options;
}
