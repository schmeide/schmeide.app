// The name the owner gave the app in its site settings, or the one it was started with.
export const appName = (project: {
  readonly name: string;
  readonly pageTitle: string | null;
}): string => project.pageTitle ?? project.name;
