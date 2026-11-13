const NIBI_PROCESS_PREFIX = "nibi";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinNibiProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [NIBI_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatNibiMainProcessName(): string {
  return joinNibiProcessName("main");
}

export function formatNibiGpuProcessName(): string {
  return joinNibiProcessName("gpu");
}

export function formatNibiHostProcessName(label?: string): string {
  return joinNibiProcessName("host", label);
}

export function formatNibiRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "NIBI") {
    return joinNibiProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinNibiProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "NIBI - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinNibiProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinNibiProcessName("renderer", normalizedTitle);
}

export function formatNibiAgentProcessName(provider: string, workspacePath?: string): string {
  return joinNibiProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatNibiUtilityProcessName(name?: string, type = "utility"): string {
  return joinNibiProcessName(type, name);
}
