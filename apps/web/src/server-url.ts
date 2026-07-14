export function resolveServerBase(input: {
  configured: string | undefined;
  development: boolean;
  protocol: string;
  hostname: string;
  origin: string;
}): string {
  if (input.configured) return input.configured.replace(/\/$/, "");
  if (input.development) return `${input.protocol}//${input.hostname}:8787`;
  return input.origin;
}
