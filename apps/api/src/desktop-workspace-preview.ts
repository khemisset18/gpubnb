/**
 * Desktop GPU streaming is a laboratory preview, NOT a production rollout.
 * Both switches must be explicitly set on the API and host agent.
 * This feature never authorizes PC1/PC2, Render or a public rental.
 */
export const desktopWorkspaceSlugs = ['creator', 'cloud-desktop', 'cad', 'gaming'] as const;
export type DesktopWorkspaceSlug = typeof desktopWorkspaceSlugs[number];

export function isDesktopWorkspaceSlug(value: string): value is DesktopWorkspaceSlug {
  return desktopWorkspaceSlugs.some((slug) => slug === value);
}

export type PreviewEnvironment = Readonly<{
  NODE_ENV?: string;
  GPUBNB_DESKTOP_WORKSPACE_PREVIEW?: string;
}>;

export function desktopWorkspacePreviewEnabled(env: PreviewEnvironment = process.env): boolean {
  return (env.NODE_ENV === 'development' || env.NODE_ENV === 'test')
    && env.GPUBNB_DESKTOP_WORKSPACE_PREVIEW === 'true';
}
